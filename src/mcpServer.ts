/**
 * MCP server giving an agent controlled access to the host OS.
 *
 * Run (stdio):   desktop-mcp   node dist/bin/desktop-mcp.js
 * Permissions:   --allow-all | --allow-mouse --allow-keyboard --allow-screen ...   (see `desktop-mcp --help`)
 *                --preset / --config FILE   a base policy that the flags are layered on
 *                --policy-show              print the effective policy and exit
 * Features:      --gui         force the desktop tools on (automatic when a desktop feature is allowed)
 *                --no-search   drop web_search / fetch_url
 *                --transport   stdio (default) | streamable-http   (with --host / --port)
 *
 * IMPORTANT: stdout carries the MCP protocol on stdio, so nothing here may print to it.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { currentOs, describePlatform } from "./platform.js";
import { PermissionDenied, PermissionEngine, type AskFn } from "./policy/engine.js";
import { FLAG_OPTIONS, permissionHelp, policyFromFlags } from "./policy/flags.js";
import { PolicyError, resolvePolicy, type PolicySource } from "./policy/load.js";
import { PRESET_NAMES } from "./policy/presets.js";
import { defineTool, type ContentBlock, type Tool, type ToolResult } from "./tools/base.js";
import { coreTools, desktopTools, webTools } from "./tools/registry.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS = `Controlled access to the user's computer ({os}). Tools: run commands in the native shell \
(bash/zsh, or PowerShell on Windows), read/write/edit/move/delete files, search files, inspect and kill processes, \
clipboard, open files/URLs, search the web and (if enabled) see and drive the desktop: mouse, keyboard, windows, \
OCR, image matching.

A permission policy limits what you may do. Call permissions_describe, or read desktop-mcp://permissions, at the \
start of any task: it is the authoritative status of what is allowed, requires approval, or is not available. \
Tools you cannot use are not listed; a call outside the policy is refused with a reason. Work carefully: inspect \
before changing, verify results after acting, prefer small reversible steps, and use commands that match the host OS \
(see system_info). Read desktop-mcp://documentation for operational guidance.`;

const MCP_DOCUMENTATION = `# desktop-mcp runtime documentation

desktop-mcp is a local MCP server giving controlled access to the user's computer.
Only tools permitted by the active policy are listed. Use the tool list and the
permissions status as the source of truth.

Feature areas:
- Mouse, keyboard, clipboard and windows.
- Screen capture, OCR, image matching, colour search and recording.
- File, directory, process, shell and system tools.
- Network-limited web tools.

Safe-operation guidance:
- Start with permissions_describe and treat its output as authoritative.
- Inspect before changing; verify after acting.
- Prefer small, reversible steps.
- Respect read-only paths, denied paths and command allow-lists.
- Keep typed text and command payloads short and deliberate.

MCP resources:
- desktop-mcp://documentation
- desktop-mcp://permissions`;

export interface ServerOptions {
  /** A preset name, a policy source (file / preset / overrides), or a ready engine. Default: the `full` preset. */
  policy?: string | PolicySource;
  engine?: PermissionEngine;
  /** Legacy shorthands for the `safe` / `readonly` presets. */
  safe?: boolean;
  readOnly?: boolean;
  gui?: boolean;
  searchTools?: boolean;
  ask?: AskFn;
}

/**
 *
 * @param result - Result to process.
 * @returns MCP content blocks for the result.
 */
function toMcpContent(result: ToolResult): CallToolResult["content"] {
  if (typeof result === "string") return [{ type: "text", text: result }];
  return result.map((b: ContentBlock) =>
    b.type === "text"
      ? { type: "text" as const, text: b.text }
      : { type: "image" as const, data: b.source.data, mimeType: b.source.media_type },
  );
}

/**
 *
 * @returns The active window title, or `undefined` when unavailable.
 */
async function activeTitle(): Promise<string | undefined> {
  return (await import("./tools/window.js")).activeWindowTitle();
}

/**
 *
 * @param opts - Options to use.
 * @returns The permission engine built from the server options.
 */
export async function engineFor(opts: ServerOptions): Promise<PermissionEngine> {
  if (opts.engine) return opts.engine;
  const src: PolicySource = typeof opts.policy === "string" ? { preset: opts.policy } : { safe: opts.safe, readOnly: opts.readOnly, ...opts.policy };
  return new PermissionEngine(await resolvePolicy(src), { ask: opts.ask, activeWindowTitle: activeTitle });
}

/**
 * Every tool this build can offer for the given feature flags (before the policy decides which the AI sees).
 * @param opts - Options to use.
 * @returns Every tool enabled by the given options.
 */
export async function allTools(opts: Pick<ServerOptions, "gui" | "searchTools"> = {}): Promise<Tool[]> {
  return [...coreTools, ...(opts.searchTools === false ? [] : webTools), ...(opts.gui ? await desktopTools() : [])];
}

/**
 * The tools the AI may see under the policy, each wrapped so every call is authorised.
 * @param opts - Options to use.
 * @returns The tools allowed by the policy.
 */
export async function selectTools(opts: ServerOptions = {}): Promise<Tool[]> {
  const engine = await engineFor(opts);
  const base = (await allTools(opts)).filter((t) => engine.isVisible(t.name));
  const describe = defineTool({
    name: "permissions_describe",
    description: "Describe what you are and are not allowed to do on this computer (the active permission policy).",
    shape: {},
    run: () => engine.describe(base),
    readOnly: true,
  });
  return [...base, describe].filter((t) => engine.isVisible(t.name)).map((t) => engine.wrap(t));
}

/**
 *
 * @param opts - Options to use.
 * @returns A configured MCP server.
 */
export async function buildServer(opts: ServerOptions = {}): Promise<McpServer> {
  const engine = opts.engine ?? await engineFor(opts);
  const visibleTools = (await allTools(opts)).filter((tool) => engine.isVisible(tool.name));
  const permissionStatus = engine.describe(visibleTools);
  const instructions = `${INSTRUCTIONS.replace("{os}", currentOs())}\n\n${MCP_DOCUMENTATION}\n\nPermission status:\n${permissionStatus}\n\nRead the desktop-mcp://documentation and desktop-mcp://permissions resources for more detail.`;
  const server = new McpServer({ name: "osagent-os-control", version: VERSION }, { instructions });
  /**
   * Ask the human through MCP elicitation, when the client supports it.
   * @param req - Elicitation request.
   * @returns The user's answer, or `undefined` when the client declines.
   */
  const ask: AskFn = async (req) => {
    if (opts.ask) return opts.ask(req);
    if (!server.server.getClientCapabilities()?.elicitation) return undefined;
    const r = await server.server.elicitInput({
      message: `${req.summary}\n${req.reasons.join("\n")}`,
      requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Allow this action", description: req.summary } }, required: ["approve"] },
    });
    return r.action === "accept" && r.content?.approve === true;
  };
  // engine was created above so its permission summary can become part of the server instructions
  engine.setAsk(ask);
  for (const tool of await selectTools({ ...opts, engine })) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.shape,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: true },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          return { content: toMcpContent(await tool.run(args)) };
        } catch (e) {
          const err = e as Error;
          const text = e instanceof PermissionDenied ? err.message : `[error] ${err.name}: ${err.message}`;
          return { isError: true, content: [{ type: "text", text }] };
        }
      },
    );
  }
  server.registerResource(
    "desktop-mcp-documentation",
    "desktop-mcp://documentation",
    { title: "desktop-mcp documentation", description: "Operational guidance for using desktop-mcp safely.", mimeType: "text/markdown" },
    async (uri: URL) => ({ contents: [{ uri: String(uri), mimeType: "text/markdown", text: MCP_DOCUMENTATION }] }),
  );
  server.registerResource(
    "desktop-mcp-permissions",
    "desktop-mcp://permissions",
    { title: "desktop-mcp permission status", description: "Allowed, approval-required and unavailable tools.", mimeType: "text/markdown" },
    async (uri: URL) => ({ contents: [{ uri: String(uri), mimeType: "text/markdown", text: permissionStatus }] }),
  );
  // never leave a key or mouse button held down, or an OCR worker running, after the client goes away
  server.server.onclose = () => void cleanup();
  return server;
}

/** Release held inputs and stop background workers. Safe to call at any time. */
export async function cleanup(): Promise<void> {
  const [gui, ocr] = await Promise.all([import("./tools/gui.js"), import("./plugins/ocr.js")]);
  await Promise.allSettled([gui.releaseHeldInputs(), ocr.shutdownOcr()]);
}

/**
 * Stateless streamable-HTTP endpoint (one server + transport per request). Binds to localhost by default.
 * @param opts - Options to use.
 * @param host - Interface to bind.
 * @param port - Port to listen on.
 * @param route - HTTP route to serve.
 * @returns The listening HTTP server.
 */
export async function serveHttp(opts: ServerOptions, host = "127.0.0.1", port = 8000, route = "/mcp"): Promise<HttpServer> {
  const localOnly = ["127.0.0.1", "localhost", "::1"].includes(host);
  const json = (res: ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };
  const engine = await engineFor(opts); // one engine: rate limits and budgets span requests
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        if (new URL(req.url as string, "http://x").pathname !== route) return void json(res, 404, "not found");
        const hostName = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
        // DNS-rebinding protection: a local-only server answers only to local host names.
        if (localOnly && !["127.0.0.1", "localhost", "::1"].includes(hostName)) return void json(res, 403, "forbidden host");
        if (req.method !== "POST") return void json(res, 405, "method not allowed (stateless server: POST only)");
        const chunks: Buffer[] = [];
        const maxBytes = 1024 * 1024;
        for await (const c of req) {
          const buf = c as Buffer;
          if (chunks.reduce((n, b) => n + b.length, 0) + buf.length > maxBytes) return void json(res, 413, "request body too large");
          chunks.push(buf);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return void json(res, 400, "invalid JSON");
        }
        const server = await buildServer({ ...opts, engine });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => void Promise.allSettled([transport.close(), server.close()]));
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        try {
          json(res, 500, `internal error: ${(e as Error).message}`);
        } catch {
          /* the response had already started: there is nothing more we can say */
        }
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  return http;
}

export interface MainIo {
  stdin?: Readable;
  stdout?: Writable;
  /** Stop serving (http) when aborted. */
  signal?: AbortSignal;
  /** Called with the port once the http transport is listening. */
  onListening?: (port: number) => void;
}

const HELP = `desktop-mcp - an MCP server that lets an AI use your computer: shell, files, clipboard, mouse, keyboard,
screen (OCR, image and colour search), windows. Everything runs locally; only web_search/fetch_url touch the network.

Usage: desktop-mcp [options]          (e.g.  npx desktop-mcp@latest --allow-all)

Server:
  --transport stdio|streamable-http   default stdio;  --host <h> --port <n> for http (default 127.0.0.1:8000)
  --gui                               force the desktop tools on (otherwise on when a desktop feature is allowed)
  --no-search                         never offer web_search / fetch_url
  --policy-show                       print the effective permissions and exit
  --version, -h/--help

${permissionHelp()}
`;

/**
 *
 * @param argv - Command-line arguments.
 * @param io - I/O overrides.
 * @returns The process exit code.
 */
export async function main(argv: string[] = process.argv.slice(2), io: MainIo = {}): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ...FLAG_OPTIONS,
        "policy-show": { type: "boolean", default: false },
        gui: { type: "boolean", default: false },
        "no-search": { type: "boolean", default: false },
        transport: { type: "string", default: "stdio" },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "8000" },
        version: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    console.error(`desktop-mcp: ${(e as Error).message}`);
    return 2;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(`desktop-mcp ${VERSION} on ${describePlatform().split("\n")[0]}`);
    return 0;
  }
  const transport = values.transport as string;
  if (transport !== "stdio" && transport !== "streamable-http") {
    console.error("desktop-mcp: --transport must be 'stdio' or 'streamable-http'");
    return 2;
  }
  let engine: PermissionEngine;
  let hint: boolean;
  try {
    const p = await policyFromFlags(values);
    hint = !p.hasBase && p.granted.length === 0;
    engine = new PermissionEngine(p.policy, { activeWindowTitle: activeTitle });
  } catch (e) {
    console.error(`desktop-mcp: ${e instanceof PolicyError ? e.message : (e as Error).message}`);
    return 2;
  }
  const desktop = values.gui || (await desktopTools()).some((t) => engine.isVisible(t.name));
  const opts: ServerOptions = { engine, gui: desktop, searchTools: !values["no-search"] };
  if (values["policy-show"]) {
    console.log(engine.describe((await allTools(opts)).filter((t) => engine.isVisible(t.name))));
    return 0;
  }
  console.error(`desktop-mcp: permissions "${engine.policy.name}"${engine.policy.name === "full" ? " (no restrictions)" : ""}`);
  if (hint) console.error("desktop-mcp: nothing is allowed yet. Add flags such as --allow-all, --allow-mouse --allow-keyboard --allow-screen, or run desktop-mcp --help.");
  if (transport === "streamable-http") {
    const port = Number.parseInt(values.port as string, 10);
    const http = await serveHttp(opts, values.host as string, port);
    io.signal?.addEventListener("abort", () => http.close());
    const actual = (http.address() as { port: number }).port;
    io.onListening?.(actual);
    console.error(`desktop-mcp listening on http://${values.host}:${actual}/mcp`);
    await new Promise<void>((resolve) => http.once("close", resolve));
    return 0;
  }
  const stdin = io.stdin ?? process.stdin;
  const server = await buildServer(opts);
  await server.connect(new StdioServerTransport(stdin, io.stdout ?? process.stdout));
  await new Promise<void>((resolve) => stdin.once("end", resolve)); // client went away
  await server.close();
  return 0;
}

export { PRESET_NAMES };
