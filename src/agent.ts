/** The agent loop: plan step by step, act with OS tools, verify, repeat. */
import { describePlatform } from "./platform.js";
import { DANGEROUS } from "./safety.js";
import { PermissionDenied, type PermissionEngine } from "./policy/engine.js";
import { buildToolset } from "./tools/index.js";
import { defineTool } from "./tools/base.js";
import { callTool, toApi, type Tool, type ToolResult } from "./tools/base.js";

export { DANGEROUS };
/**
 * Test hook: where the optional Anthropic SDK comes from.
 * @returns The optional Anthropic SDK module.
 */
let loadSdk: () => Promise<typeof import("@anthropic-ai/sdk")> = () => import("@anthropic-ai/sdk");
/**
 *
 * @param fn - Loader to install, or `undefined` to restore the default.
 */
export function __setSdkLoader(fn: (() => Promise<typeof import("@anthropic-ai/sdk")>) | undefined): void {
  loadSdk = fn ?? (() => import("@anthropic-ai/sdk"));
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const SYSTEM_PROMPT = `You are an autonomous operator of the user's computer. You act through tools: a shell, \
files, web search, and (when enabled) screenshots, mouse and keyboard.

Host environment:
{platform}

Work step by step:
1. PLAN - call \`think\` first with a short numbered plan.
2. ACT - take one small action at a time with the most appropriate tool. Prefer the shell and files over \
GUI clicking when both can do the job; use the GUI for things only a GUI can do.
3. VERIFY - after every action check the result (exit codes, file contents, a fresh screenshot). Test your \
work in this real environment: run the code, run the tests, open the file. Never claim success without evidence.
4. ADAPT - if something fails, read the error, update the plan with \`think\`, and try a different approach.
5. SEARCH - when you lack current or specific knowledge, use web_search and fetch_url instead of guessing.
6. FINISH - reply with a short summary of what you did and the evidence it worked.

Use commands that match the host OS. Do not run destructive or irreversible commands unless the user asked for them.`;

export type Args = Record<string, unknown>;
export type ConfirmFn = (tool: string, args: Args) => boolean | Promise<boolean>;
export type EventFn = (kind: string, data: unknown) => void;

/** Minimal slice of the Anthropic client the loop needs (lets tests script the model). */
export interface MessagesClient {
  messages: { create(params: Record<string, unknown>): Promise<{ content: ContentBlock[] }> };
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AgentOptions {
  model?: string;
  gui?: boolean;
  search?: boolean;
  confirm?: ConfirmFn;
  confirmAll?: boolean;
  maxSteps?: number;
  onEvent?: EventFn;
  client?: MessagesClient;
  /** Permission policy; approvals (`ask`) are routed to `confirm`. */
  policy?: PermissionEngine;
}

/**
 *
 * @param tool - Tool definition to inspect.
 * @param args - Arguments supplied to the tool.
 * @returns Whether confirmation is required.
 */
export function needsConfirmation(tool: Tool, args: Args): boolean {
  if (tool.name === "run_command") return DANGEROUS.test(String(args.command ?? ""));
  return false;
}

export class Agent {
  private client?: MessagesClient;
  readonly model: string;
  readonly confirm?: ConfirmFn;
  readonly confirmAll: boolean;
  readonly maxSteps: number;
  readonly onEvent: EventFn;
  readonly system: string;
  readonly messages: { role: "user" | "assistant"; content: unknown }[] = [];
  private tools?: Map<string, Tool>;
  private readonly gui: boolean;
  private readonly search: boolean;
  private readonly engine?: PermissionEngine;

  constructor(opts: AgentOptions = {}) {
    this.client = opts.client;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.gui = opts.gui ?? false;
    this.search = opts.search ?? true;
    this.confirm = opts.confirm;
    this.engine = opts.policy;
    this.engine?.setAsk(async (req) => (this.confirm ? this.confirm(req.tool, req.args) : undefined));
    this.confirmAll = opts.confirmAll ?? false;
    this.maxSteps = opts.maxSteps ?? 40;
    this.onEvent = opts.onEvent ?? (() => {});
    this.system = SYSTEM_PROMPT.replace("{platform}", describePlatform());
  }

  private async toolset(): Promise<Map<string, Tool>> {
    if (!this.tools) {
      const all = await buildToolset(this.gui, this.search);
      const e = this.engine;
      if (e) {
        const visible = [...all.values()].filter((t) => e.isVisible(t.name));
        visible.push(defineTool({ name: "permissions_describe", description: "Describe what you are and are not allowed to do on this computer.", shape: {}, run: () => e.describe(visible), readOnly: true }));
        this.tools = new Map(visible.map((t) => [t.name, e.wrap(t)]));
      } else this.tools = all;
    }
    return this.tools;
  }

  /**
   * The model client. The standalone agent is the ONLY part of this package that talks to an LLM API, so the
   * Anthropic SDK is an optional peer dependency, loaded here on first use (never by the desktop-mcp MCP server).
   * @returns The resulting value.
   */
  private async clientFor(): Promise<MessagesClient> {
    if (!this.client) {
      const sdk = await loadSdk().catch(() => {
        throw new Error("the standalone agent needs the Anthropic SDK: npm install @anthropic-ai/sdk (the desktop-mcp MCP server does not)");
      });
      this.client = new sdk.default() as unknown as MessagesClient;
    }
    return this.client;
  }

  /**
   * Run one tool call. Returns [result, isError].
   * @param name - Tool name to execute.
   * @param args - Arguments supplied to the tool.
   * @returns The tool result and whether it represents an error.
   */
  async execute(name: string, args: Args): Promise<[ToolResult, boolean]> {
    const tool = (await this.toolset()).get(name);
    if (!tool) return [`[error] unknown tool ${name}`, true];
    const gated = (this.confirmAll && tool.risky) || needsConfirmation(tool, args);
    if (gated && (!this.confirm || !(await this.confirm(name, args)))) {
      return ["[denied] the user did not approve this action; choose a safer approach or explain.", true];
    }
    try {
      return [await callTool(tool, args), false];
    } catch (e) {
      if (e instanceof PermissionDenied) return [e.message, true];
      // report to the model so it can adapt
      const err = e as Error;
      return [`[error] ${err.name}: ${err.message}`, true];
    }
  }

  async run(task: string): Promise<string> {
    const tools = [...(await this.toolset()).values()].map(toApi);
    this.messages.push({ role: "user", content: task });
    for (let step = 0; step < this.maxSteps; step++) {
      const resp = await (await this.clientFor()).messages.create({
        model: this.model,
        max_tokens: 4096,
        system: this.system,
        tools,
        messages: this.messages,
      });
      this.messages.push({ role: "assistant", content: resp.content });
      for (const b of resp.content) if (b.type === "text" && b.text?.trim()) this.onEvent("text", b.text);

      const calls = resp.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) return resp.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");

      const results: unknown[] = [];
      for (const call of calls) {
        const args = (call.input ?? {}) as Args;
        this.onEvent("tool_call", [call.name, args]);
        const [out, isError] = await this.execute(call.name as string, { ...args });
        this.onEvent("tool_result", [call.name, out]);
        results.push({ type: "tool_result", tool_use_id: call.id, content: out, is_error: isError });
      }
      this.messages.push({ role: "user", content: results });
    }
    return `[stopped after ${this.maxSteps} steps without finishing]`;
  }
}
