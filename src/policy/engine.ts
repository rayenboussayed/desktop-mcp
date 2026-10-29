import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../platform.js";
import { DANGEROUS } from "../safety.js";
import type { Tool } from "../tools/base.js";
import { TOOL_META, type Scope } from "./capabilities.js";
import type { Capability, Mode, Policy, RegionLike } from "./schema.js";

export class PermissionDenied extends Error {
  override name = "PermissionDenied";
  constructor(reason: string) {
    super(`[permission denied] ${reason}`);
  }
}

export interface AskRequest {
  tool: string;
  /** Human-readable one-liner of what is about to happen. */
  summary: string;
  /** Why approval is needed. */
  reasons: string[];
  /** Arguments with bulky/sensitive values replaced by their size. */
  args: Record<string, unknown>;
}
/** Resolve to true/false, or undefined when there is nobody to ask. */
export type AskFn = (req: AskRequest) => Promise<boolean | undefined>;

export interface EngineDeps {
  ask?: AskFn;
  now?: () => number;
  /** Title of the focused window, for `gui.windows`. */
  activeWindowTitle?: () => Promise<string | undefined>;
  /** Audit sink override (tests); defaults to appending to `policy.audit.file`. */
  writeAudit?: (line: string) => Promise<void>;
}

export interface Decision {
  allowed: boolean;
  mode: Mode;
  asked: boolean;
  reason?: string;
}

// ------------------------------------------------------------------ paths
const caseInsensitive = (): boolean => process.platform === "win32" || process.platform === "darwin";
const slashes = (p: string): string => p.replace(/\\/g, "/");

/**
 * Absolute, normalised, forward-slash form of a policy pattern or a path (no symlink resolution).
 * @param p - Path to normalise.
 * @returns The normalised path.
 */
function normalise(p: string): string {
  const s = slashes(resolveUserPath(p));
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * `**` any depth, `*` within a segment, `?` one character. A match covers the entry and everything below it.
 * @param pattern - Glob or pattern to match.
 * @returns The compiled path pattern.
 */
export function pathRegExp(pattern: string): RegExp {
  let norm = normalise(pattern);
  if (norm.endsWith("/**")) norm = norm.slice(0, -3) || "/";
  let src = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i] as string;
    if (c === "*" && norm[i + 1] === "*") {
      if (norm[i + 2] === "/") { src += "(?:.*/)?"; i += 2; } else { src += ".*"; i += 1; }
    } else if (c === "*") src += "[^/]*";
    else if (c === "?") src += "[^/]";
    else src += esc(c);
  }
  if (src === "/") src = ""; // the root covers everything
  return new RegExp(`^${src}(?:/.*)?$`, caseInsensitive() ? "i" : "");
}

/**
 * The real path of `p`: symlinks resolved on the longest existing ancestor, the rest appended.
 * @param p - Path to normalise.
 * @returns The canonical absolute path.
 */
export async function canonicalPath(p: string): Promise<string> {
  const real = resolveUserPath(p);
  let existing = real;
  const rest: string[] = [];
  for (;;) {
    try {
      return slashes(path.join(await realpath(existing), ...rest.reverse()));
    } catch {
      const parent = path.dirname(existing);
      /* v8 ignore next -- the filesystem root always resolves, so the walk up always ends before this */
      if (parent === existing) return slashes(real);
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

// ------------------------------------------------------------------- keys
const KEY_ALIASES: Record<string, string> = {
  control: "ctrl", ctl: "ctrl", option: "alt", opt: "alt", win: "meta", windows: "meta", super: "meta",
  cmd: "meta", command: "meta", return: "enter", esc: "escape", del: "delete", pgup: "pageup", pgdn: "pagedown",
};
const normKey = (k: string): string => {
  const x = k.trim().toLowerCase();
  return KEY_ALIASES[x] ?? x;
};
const keySet = (keys: string[]): Set<string> => new Set(keys.map(normKey));

const inRegion = (r: RegionLike, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
const regionInside = (outer: RegionLike, r: RegionLike): boolean =>
  r.x >= outer.x && r.y >= outer.y && r.x + r.width <= outer.x + outer.width && r.y + r.height <= outer.y + outer.height;

const SENSITIVE_ARG = new Set(["text", "content", "old", "new", "template"]);
const CHAIN = /[;&|`<>\n]|\$\(/;
const compile = (patterns: string[], what: string): RegExp[] =>
  patterns.map((s) => {
    try {
      return new RegExp(s, "i");
    } catch (e) {
      throw new Error(`invalid ${what} pattern ${JSON.stringify(s)}: ${(e as Error).message}`, { cause: e });
    }
  });

const als = new AsyncLocalStorage<PermissionEngine>();
/**
 * The engine authorising the tool call currently running, if any.
 * @returns The active permission engine, or `undefined` outside a run.
 */
export const currentEngine = (): PermissionEngine | undefined => als.getStore();

export class PermissionEngine {
  private readonly allowCmd: RegExp[];
  private readonly denyCmd: RegExp[];
  private readonly allowHosts: RegExp[];
  private readonly denyHosts: RegExp[];
  private readonly windows: RegExp[];
  private readonly blockedText: RegExp[];
  private readonly blockedKeys: Set<string>[];
  private readonly allowPaths: RegExp[];
  private readonly denyPaths: RegExp[];
  private readonly roPaths: RegExp[];
  private readonly stamps: number[] = [];
  private total = 0;
  private readonly now: () => number;
  private askFn?: AskFn;

  constructor(readonly policy: Policy, private readonly deps: EngineDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.askFn = deps.ask;
    this.allowCmd = compile(policy.commands.allow, "commands.allow");
    this.denyCmd = compile(policy.commands.deny, "commands.deny");
    this.allowHosts = compile(policy.network.allowHosts, "network.allowHosts");
    this.denyHosts = compile(policy.network.denyHosts, "network.denyHosts");
    this.windows = compile(policy.gui.windows, "gui.windows");
    this.blockedText = compile(policy.gui.blockedText, "gui.blockedText");
    this.blockedKeys = policy.gui.blockedKeys.map((c) => keySet(c.split("+")));
    this.allowPaths = policy.paths.allow.map(pathRegExp);
    this.denyPaths = policy.paths.deny.map(pathRegExp);
    this.roPaths = policy.paths.readOnly.map(pathRegExp);
  }

  // ------------------------------------------------------------- modes
  private capMode(cap: Capability): Mode {
    return this.policy.capabilities[cap] ?? this.policy.default;
  }

  /**
   * The mode of a tool before looking at its arguments. Unknown tools are denied.
   * @param tool - Tool name.
   * @returns The tool's static permission mode.
   */
  staticMode(tool: string): Mode {
    const override = this.policy.tools[tool];
    if (override) return override;
    const meta = TOOL_META[tool];
    if (!meta) return "deny";
    const modes = meta.caps.map((c) => this.capMode(c));
    return modes.includes("deny") ? "deny" : modes.includes("ask") ? "ask" : "allow";
  }

  /**
   * Tools the AI may see at all: a denied tool is not even listed.
   * @param tool - Tool name.
   * @returns Whether the tool is visible under the policy.
   */
  isVisible(tool: string): boolean {
    return this.staticMode(tool) !== "deny";
  }

  // -------------------------------------------------------- scope checks
  private async pathReason(kind: "read" | "write" | "delete", raw: string): Promise<string | undefined> {
    const lexical = slashes(resolveUserPath(raw));
    const canon = await canonicalPath(raw);
    const hit = (res: RegExp[]): boolean => res.some((r) => r.test(lexical) || r.test(canon));
    if (hit(this.denyPaths)) return `path ${canon} is denied by policy`;
    if (this.allowPaths.length > 0 && !this.allowPaths.some((r) => r.test(canon))) return `path ${canon} is outside the allowed paths`;
    if (kind !== "read" && hit(this.roPaths)) return `path ${canon} is read-only`;
    return undefined;
  }

  private commandReason(command: string): string | undefined {
    if (this.denyCmd.some((r) => r.test(command))) return "command matches a denied pattern";
    if (this.policy.commands.blockDangerous && DANGEROUS.test(command)) return "command matches a dangerous pattern";
    if (this.allowCmd.length > 0) {
      if (!this.allowCmd.some((r) => r.test(command))) return "command is not on the allow-list";
      if (!this.policy.commands.allowChaining && CHAIN.test(command)) return "command chaining/redirection is not allowed with an allow-list";
    }
    return undefined;
  }

  private urlReason(url: string): string | undefined {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return `invalid URL ${JSON.stringify(url)}`;
    }
    if (this.denyHosts.some((r) => r.test(hostname))) return `host ${hostname} is denied`;
    if (this.allowHosts.length > 0 && !this.allowHosts.some((r) => r.test(hostname))) return `host ${hostname} is not on the allow-list`;
    return undefined;
  }

  private guiReason(scope: Scope): string | undefined {
    const g = this.policy.gui;
    for (const pt of scope.points ?? []) {
      if (g.regions.length > 0 && !g.regions.some((r) => inRegion(r, pt.x, pt.y))) return `point (${pt.x},${pt.y}) is outside the allowed screen regions`;
    }
    if (scope.capture && g.regions.length > 0) {
      if (!scope.region) return "capturing the whole screen is not allowed; specify a region inside the allowed area";
      const reg = scope.region;
      if (!g.regions.some((r) => regionInside(r, reg))) return "the requested region is outside the allowed screen regions";
    } else if (scope.region && g.regions.length > 0 && !g.regions.some((r) => regionInside(r, scope.region as RegionLike))) {
      return "the requested region is outside the allowed screen regions";
    }
    if (scope.keys) {
      const pressed = keySet(scope.keys);
      if (this.blockedKeys.some((b) => [...b].every((k) => pressed.has(k)))) return `key combination ${scope.keys.join("+")} is blocked`;
    }
    if (scope.text !== undefined) {
      if (g.maxTypeChars !== undefined && Array.from(scope.text).length > g.maxTypeChars) return `text longer than ${g.maxTypeChars} characters`;
      if (this.blockedText.some((r) => r.test(scope.text as string))) return "text matches a blocked pattern";
    }
    return undefined;
  }

  private limitReason(): string | undefined {
    const { maxActionsPerMinute, maxTotalActions } = this.policy.limits;
    if (maxTotalActions !== undefined && this.total >= maxTotalActions) return `action budget of ${maxTotalActions} is used up`;
    if (maxActionsPerMinute !== undefined) {
      const cutoff = this.now() - 60_000;
      while (this.stamps.length > 0 && (this.stamps[0] as number) <= cutoff) this.stamps.shift();
      if (this.stamps.length >= maxActionsPerMinute) return `rate limit of ${maxActionsPerMinute} actions per minute reached`;
    }
    return undefined;
  }

  /**
   * Window scoping for window-control tools: the target window's title must match `gui.windows`.
   * @param title - Window title to check.
   */
  assertWindow(title: string): void {
    if (this.windows.length > 0 && !this.windows.some((r) => r.test(title))) {
      throw new PermissionDenied(`window ${JSON.stringify(title)} is not in the allowed windows`);
    }
  }

  /**
   * Where `ask`-mode approvals go (the MCP server points this at elicitation once a client has connected).
   * @param ask - Approval callback, or `undefined` when approvals are denied.
   */
  setAsk(ask: AskFn | undefined): void {
    this.askFn = ask;
  }

  // --------------------------------------------------------- authorise
  private async scopeReasons(tool: string, args: Record<string, unknown>): Promise<string[]> {
    const meta = TOOL_META[tool];
    const reasons: string[] = [];
    const scope = meta?.scope?.(args) ?? {};
    for (const [kind, list] of [["read", scope.reads], ["write", scope.writes], ["delete", scope.deletes]] as const) {
      for (const p of list ?? []) {
        const r = await this.pathReason(kind, p);
        if (r) reasons.push(r);
      }
    }
    if (scope.command !== undefined) {
      const r = this.commandReason(scope.command);
      if (r) reasons.push(r);
    }
    if (scope.url !== undefined) {
      const r = this.urlReason(scope.url);
      if (r) reasons.push(r);
    }
    const g = this.guiReason(scope);
    if (g) reasons.push(g);
    if (meta?.input && this.windows.length > 0) {
      const title = await this.deps.activeWindowTitle?.();
      if (title === undefined || !this.windows.some((r) => r.test(title))) {
        reasons.push(`the active window ${JSON.stringify(title ?? "(unknown)")} is not in the allowed windows`);
      }
    }
    return reasons;
  }

  private async audit(tool: string, args: Record<string, unknown>, d: Decision): Promise<string | undefined> {
    const sink = this.deps.writeAudit ?? (this.policy.audit.file ? (l: string) => appendFile(this.policy.audit.file as string, l) : undefined);
    if (!sink) return undefined;
    const entry: Record<string, unknown> = {
      ts: new Date(this.now()).toISOString(), policy: this.policy.name, tool, allowed: d.allowed, mode: d.mode, asked: d.asked,
    };
    if (d.reason) entry.reason = d.reason;
    entry.args = this.policy.audit.logArgs ? redact(args, false) : Object.keys(args);
    try {
      await sink(JSON.stringify(entry) + "\n");
      return undefined;
    } catch (e) {
      return `audit log unavailable (${(e as Error).message})`;
    }
  }

  async authorize(tool: string, args: Record<string, unknown>): Promise<Decision> {
    const mode = this.staticMode(tool);
    let d: Decision;
    if (mode === "deny") {
      const known = TOOL_META[tool] !== undefined || this.policy.tools[tool] !== undefined;
      d = { allowed: false, mode, asked: false, reason: known ? `tool ${tool} is not permitted by policy "${this.policy.name}"` : `tool ${tool} has no permission metadata` };
    } else {
      const reasons = await this.scopeReasons(tool, args);
      const limit = reasons.length === 0 ? this.limitReason() : undefined;
      if (reasons.length > 0) d = { allowed: false, mode, asked: false, reason: reasons.join("; ") };
      else if (limit) d = { allowed: false, mode, asked: false, reason: limit };
      else if (mode === "ask") {
        const answer = await this.askFn?.({
          tool, args: redact(args, true), reasons: [`policy "${this.policy.name}" requires approval for ${tool}`],
          summary: `${tool}(${Object.entries(redact(args, true)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`,
        });
        const allowed = answer ?? this.policy.askFallback === "allow";
        d = { allowed, mode, asked: true, ...(allowed ? {} : { reason: answer === undefined ? "approval required but nobody could be asked" : "the user did not approve" }) };
      } else d = { allowed: true, mode, asked: false };
    }
    const auditProblem = await this.audit(tool, args, d);
    if (auditProblem) d = { ...d, allowed: false, reason: auditProblem };
    if (d.allowed) {
      this.total++;
      this.stamps.push(this.now());
    }
    return d;
  }

  /**
   * Wrap a tool so every call is authorised first (and window scoping is available while it runs).
   * @param tool - Tool to wrap.
   * @returns The authorising wrapper around the tool.
   */
  wrap(tool: Tool): Tool {
    return {
      ...tool,
      run: async (args) => {
        const d = await this.authorize(tool.name, (args ?? {}) as Record<string, unknown>);
        if (!d.allowed) throw new PermissionDenied(d.reason ?? "not permitted");
        return als.run(this, () => tool.run(args));
      },
    };
  }

  /**
   * Plain-language summary for the AI (and for `--policy-show`).
   * @param tools - Tools to describe.
   * @returns A plain-language policy summary.
   */
  describe(tools: Tool[]): string {
    const group = (m: Mode): string[] => tools.map((t) => t.name).filter((n) => this.staticMode(n) === m);
    const p = this.policy;
    const lines = [`Permission policy: ${p.name}`];
    for (const m of ["allow", "ask", "deny"] as const) {
      const names = m === "deny" ? Object.keys(TOOL_META).filter((n) => this.staticMode(n) === "deny" && !tools.some((t) => t.name === n)) : group(m);
      if (names.length) lines.push(`${m === "allow" ? "Allowed" : m === "ask" ? "Needs user approval" : "Not available"}: ${names.join(", ")}`);
    }
    if (p.paths.allow.length) lines.push(`Files limited to: ${p.paths.allow.join(", ")}`);
    if (p.paths.deny.length) lines.push(`Files never touched: ${p.paths.deny.join(", ")}`);
    if (p.paths.readOnly.length) lines.push(`Read-only files: ${p.paths.readOnly.join(", ")}`);
    if (p.commands.allow.length) lines.push(`Shell limited to commands matching: ${p.commands.allow.join(" | ")}`);
    if (p.commands.blockDangerous) lines.push("Dangerous shell commands are refused.");
    if (p.network.allowHosts.length) lines.push(`Web limited to hosts: ${p.network.allowHosts.join(", ")}`);
    if (p.gui.regions.length) lines.push(`Screen limited to regions: ${p.gui.regions.map((r) => `${r.width}x${r.height}+${r.x}+${r.y}`).join(", ")}`);
    if (p.gui.windows.length) lines.push(`Input limited to windows titled: ${p.gui.windows.join(", ")}`);
    if (p.gui.blockedKeys.length) lines.push(`Blocked hotkeys: ${p.gui.blockedKeys.join(", ")}`);
    if (p.limits.maxActionsPerMinute) lines.push(`Rate limit: ${p.limits.maxActionsPerMinute} actions/minute`);
    if (p.limits.maxTotalActions) lines.push(`Action budget: ${p.limits.maxTotalActions}`);
    return lines.join("\n");
  }
}

/**
 *
 * @param args - Raw tool arguments to redact.
 * @param forDisplay - Whether the arguments are for display rather than execution.
 * @returns A copy of the arguments with secrets redacted.
 */
function redact(args: Record<string, unknown>, forDisplay: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && (SENSITIVE_ARG.has(k) || (forDisplay && v.length > 200))) out[k] = `<${Array.from(v).length} chars>`;
    else out[k] = v;
  }
  return out;
}
