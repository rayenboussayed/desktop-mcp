import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_META } from "../../src/policy/capabilities.js";
import { PermissionEngine } from "../../src/policy/engine.js";
import { PolicySchema } from "../../src/policy/schema.js";
import { allTools, buildServer, cleanup, engineFor, main, selectTools, serveHttp, type ServerOptions } from "../../src/mcpServer.js";
import { VERSION } from "../../src/version.js";
import { tmpDir } from "../helpers.js";
import { haveXev, startXev, stopAll } from "../x.js";

const names = async (o: ServerOptions): Promise<string[]> => (await selectTools(o)).map((t) => t.name);
const textOf = (r: unknown): string =>
  ((r as { content: { type: string; text?: string }[] }).content).map((c) => c.text ?? `<${c.type}>`).join("");

/**
 *
 * @param o - Server options.
 * @param caps - Client capabilities.
 * @returns The connected client and a close function.
 */
async function connect(o: ServerOptions, caps: object = {}): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await buildServer(o);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "1" }, { capabilities: caps });
  await client.connect(a);
  return { client, close: () => client.close() };
}

/** A client transport over a pair of streams, for driving main() in-process. */
class StreamTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private buf = new ReadBuffer();
  constructor(private toServer: PassThrough, private fromServer: PassThrough) {}
  async start(): Promise<void> {
    this.fromServer.on("data", (d: Buffer) => {
      this.buf.append(d);
      for (let m = this.buf.readMessage(); m; m = this.buf.readMessage()) this.onmessage?.(m);
    });
  }

  async send(m: JSONRPCMessage): Promise<void> { this.toServer.write(serializeMessage(m)); }
  async close(): Promise<void> { this.toServer.end(); this.onclose?.(); }
}

afterEach(() => { stopAll(); vi.restoreAllMocks(); });

describe("which tools each preset shows the AI (denied tools are hidden, not just refused)", () => {
  const all = Object.keys(TOOL_META).filter((k) => k !== "think"); // `think` is the standalone agent's scratchpad, not an MCP tool
  it("full shows everything the build has; locked shows nothing", async () => {
    expect((await names({ gui: true })).sort()).toEqual(all.sort());
    expect(await names({ gui: true, policy: "locked" })).toEqual(["permissions_describe"]); // the AI can always read its limits
    expect((await names({})).length).toBeLessThan(all.length); // no --gui: no desktop tools
    expect(await names({ searchTools: false })).not.toContain("web_search");
  });
  it("readonly: can look, cannot touch", async () => {
    const n = await names({ gui: true, policy: "readonly" });
    for (const t of ["read_file", "list_dir", "system_info", "list_processes", "screenshot", "screen_read_text", "window_list", "web_search", "screen_find_color", "permissions_describe"]) expect(n, t).toContain(t);
    for (const t of ["write_file", "run_command", "delete_path", "kill_process", "click", "type_text", "press_key", "window_focus", "window_close", "clipboard_set", "clipboard_get", "open_path", "screen_record"]) expect(n, t).not.toContain(t);
  });
  it("legacy flags map to presets", async () => {
    expect(await names({ readOnly: true })).not.toContain("write_file");
    const safe = await names({ safe: true, gui: true });
    for (const t of ["delete_path", "kill_process", "move_path"]) expect(safe).not.toContain(t);
    expect(safe).toContain("run_command");
    expect(safe).toContain("click");
  });
  it("standard and desktop keep everything visible (approval, not hiding)", async () => {
    expect((await names({ gui: true, policy: "standard" })).length).toBe(all.length);
    expect((await names({ gui: true, policy: "desktop" })).length).toBe(all.length);
  });
  it("per-tool overrides hide and reveal", async () => {
    const n = await names({ policy: { preset: "locked", allowTools: ["read_file", "permissions_describe"] } });
    expect(n.sort()).toEqual(["permissions_describe", "read_file"]);
    expect(await names({ policy: { denyTools: ["run_command"] } })).not.toContain("run_command");
  });
  it("allTools respects the feature flags", async () => {
    const base = (await allTools()).map((t) => t.name);
    expect(base).toContain("web_search");
    expect(base).not.toContain("click");
    expect((await allTools({ gui: true, searchTools: false })).map((t) => t.name)).not.toContain("fetch_url");
  });
  it("engineFor accepts a ready engine unchanged", async () => {
    const e = new PermissionEngine(PolicySchema.parse({ default: "allow" }));
    expect(await engineFor({ engine: e })).toBe(e);
  });
});

describe("protocol (in-memory client <-> real server)", () => {
  it("lists tools with annotations and schemas", async () => {
    const { client, close } = await connect({});
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.read_file?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(by.delete_path?.annotations?.destructiveHint).toBe(true);
    expect(by.run_command?.inputSchema.required).toEqual(["command"]);
    expect(client.getInstructions()).toMatch(/permission policy/i);
    await close();
  });

  it("calls real tools under the full preset", async () => {
    const { client, close } = await connect({});
    const f = path.join(tmpDir(), "x.txt");
    expect(textOf(await client.callTool({ name: "write_file", arguments: { path: f, content: "hello mcp" } }))).toContain("wrote 9 chars");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(readFileSync(f, "utf8")).toBe("hello mcp");
    expect(textOf(await client.callTool({ name: "run_command", arguments: { command: "echo via-mcp" } }))).toContain("via-mcp");
    expect(textOf(await client.callTool({ name: "edit_file", arguments: { path: f, old: "mcp", new: "MCP" } }))).toContain("replaced 1");
    expect(textOf(await client.callTool({ name: "delete_path", arguments: { path: f } }))).toContain("deleted");
    await close();
  });

  it("reports validation errors, tool exceptions and permission denials as isError results", async () => {
    const { client, close } = await connect({ policy: { preset: "full", denyTools: [] }, engine: new PermissionEngine(PolicySchema.parse({ default: "allow", paths: { deny: ["/etc"] } })) });
    const v = await client.callTool({ name: "read_file", arguments: { path: 1 } }).catch((e) => e as Error);
    expect(String((v as { message?: string }).message ?? textOf(v))).toMatch(/invalid|expected string/i);
    const boom = await client.callTool({ name: "move_path", arguments: { src: "/nonexistent/a", dst: "/nonexistent/b" } });
    expect(boom.isError).toBe(true);
    expect(textOf(boom)).toMatch(/^\[error\] Error: ENOENT/);
    const denied = await client.callTool({ name: "read_file", arguments: { path: "/etc/hostname" } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toBe("[permission denied] path /etc/hostname is denied by policy");
    await close();
  });

  it("safe mode blocks dangerous commands but allows normal ones", async () => {
    const { client, close } = await connect({ safe: true });
    expect(textOf(await client.callTool({ name: "run_command", arguments: { command: "sudo rm -rf /" } }))).toContain("dangerous pattern");
    expect(textOf(await client.callTool({ name: "run_command", arguments: { command: "echo fine" } }))).toContain("fine");
    await close();
  });

  it("calling a hidden tool is an error result, not an execution", async () => {
    const { client, close } = await connect({ readOnly: true });
    const r = await client.callTool({ name: "write_file", arguments: { path: "/tmp/x", content: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not found/i);
    await close();
  });

  it("permissions_describe tells the AI what it may do", async () => {
    const { client, close } = await connect({ policy: { preset: "standard" } });
    const t = textOf(await client.callTool({ name: "permissions_describe", arguments: {} }));
    expect(t).toContain("Permission policy: standard");
    expect(t).toContain("Needs user approval:");
    expect(t).toContain("Files never touched:");
    expect(t).toContain("Dangerous shell commands are refused.");
    await close();
  });

  it("initialize instructions document the runtime and permission policy", async () => {
    const { client, close } = await connect({});
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/permission status/i);
    expect(instructions).toMatch(/documentation/i);
    expect(instructions).toContain("permissions_describe");
    await close();
  });

  it("exposes and reads documentation and permission resources", async () => {
    const { client, close } = await connect({ policy: "standard" });
    const listed = await client.listResources();
    const names = listed.resources.map((r) => r.name);
    expect(names).toContain("desktop-mcp-documentation");
    expect(names).toContain("desktop-mcp-permissions");
    const docs = await client.readResource({ uri: "desktop-mcp://documentation" });
    expect(String((docs.contents[0] as { text?: string }).text ?? "")).toMatch(/desktop-mcp runtime documentation/i);
    const status = await client.readResource({ uri: "desktop-mcp://permissions" });
    expect(String((status.contents[0] as { text?: string }).text ?? "")).toMatch(/Permission policy/i);
    expect(String((status.contents[0] as { text?: string }).text ?? "")).toContain("Permission policy: standard");
    await close();
  });
});

describe("approvals through MCP elicitation", () => {
  const writeArgs = (): { name: string; arguments: Record<string, unknown> } => ({ name: "write_file", arguments: { path: path.join(tmpDir(), "a.txt"), content: "SECRET-BODY" } });

  it("asks the human, and honours accept / decline / cancel", async () => {
    const seen: string[] = [];
    let answer: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } = { action: "accept", content: { approve: true } };
    const { client, close } = await connect({ policy: "standard" }, { elicitation: {} });
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params.message);
      return answer;
    });
    const w = writeArgs();
    expect(textOf(await client.callTool(w))).toContain("wrote 11 chars");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(w.arguments.path as string)).toBe(true);
    expect(seen[0]).toContain("write_file(");
    expect(seen[0]).toContain("<11 chars>"); // the file body is never shown
    expect(seen[0]).not.toContain("SECRET-BODY");
    expect(seen[0]).toContain('requires approval for write_file');

    const w2 = writeArgs();
    answer = { action: "accept", content: { approve: false } };
    expect(textOf(await client.callTool(w2))).toBe("[permission denied] the user did not approve");
    answer = { action: "decline" };
    expect(textOf(await client.callTool(w2))).toContain("did not approve");
    answer = { action: "cancel" };
    expect(textOf(await client.callTool(w2))).toContain("did not approve");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(w2.arguments.path as string)).toBe(false);
    await close();
  });

  it("without elicitation support, ask falls back to deny (or allow, if the policy says so)", async () => {
    const { client, close } = await connect({ policy: "standard" });
    const r = await client.callTool(writeArgs());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("nobody could be asked");
    await close();
    const lenient = await connect({ engine: new PermissionEngine(PolicySchema.parse({ default: "ask", askFallback: "allow" })) });
    expect(textOf(await lenient.client.callTool(writeArgs()))).toContain("wrote");
    await lenient.close();
  });

  it("an injected ask function takes precedence (used by embedders)", async () => {
    const { client, close } = await connect({ policy: "standard", ask: async () => true });
    expect(textOf(await client.callTool(writeArgs()))).toContain("wrote");
    await close();
  });

  it("reads never ask under the standard preset", async () => {
    let asked = 0;
    const { client, close } = await connect({ policy: "standard", ask: async () => (asked++, true) });
    await client.callTool({ name: "system_info", arguments: {} });
    await client.callTool({ name: "read_file", arguments: { path: "package.json" } });
    expect(asked).toBe(0);
    await close();
  });
});

describe("audit log and limits through the server", () => {
  it("every call is recorded, with and without permission", async () => {
    const log = path.join(tmpDir(), "audit.jsonl");
    const engine = new PermissionEngine(PolicySchema.parse({ name: "audited", default: "allow", capabilities: { "fs.delete": "deny" }, audit: { file: log }, limits: { maxTotalActions: 3 } }));
    const { client, close } = await connect({ engine });
    await client.callTool({ name: "system_info", arguments: {} });
    await client.callTool({ name: "get_env", arguments: { name: "PATH" } });
    await client.callTool({ name: "list_processes", arguments: {} });
    const over = await client.callTool({ name: "system_info", arguments: {} });
    expect(textOf(over)).toContain("budget of 3 is used up");
    await close();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.tool, l.allowed])).toEqual([["system_info", true], ["get_env", true], ["list_processes", true], ["system_info", false]]);
    expect(lines[0].policy).toBe("audited");
  });
});

describe("shutdown safety", () => {
  it.skipIf(!haveXev)("releases keys and buttons the AI left held when the client disconnects", async () => {
    const ev = await startXev();
    const { client, close } = await connect({ gui: true });
    await client.callTool({ name: "move_mouse", arguments: { x: 250, y: 250 } });
    await client.callTool({ name: "key_down", arguments: { keys: ["shift"] } });
    await client.callTool({ name: "mouse_press", arguments: { button: "left" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(ev.out).not.toContain("KeyRelease");
    await close();
    await new Promise((r) => setTimeout(r, 600)); // onclose -> cleanup() releases them
    await ev.settle();
    expect(ev.out).toContain("KeyRelease");
    expect(ev.buttons("ButtonRelease")).toEqual(["1"]);
    await cleanup(); // idempotent
  });
});

describe("real transports", () => {
  it("stdio subprocess: serves tools under a preset and keeps stdout clean", async () => {
    const t = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/bin/omcps.js"), "--preset", "readonly", "--no-search"], stderr: "pipe" });
    const stderr: string[] = [];
    t.stderr?.on("data", (d) => stderr.push(String(d)));
    const c = new Client({ name: "stdio", version: "1" });
    await c.connect(t);
    const tools = (await c.listTools()).tools.map((x) => x.name);
    expect(tools).toContain("read_file");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("web_search");
    expect(textOf(await c.callTool({ name: "system_info", arguments: {} }))).toContain("CPU cores");
    await c.close();
    expect(stderr.join("")).toContain('permissions "readonly"');
  });

  it("stdio with --gui: real screenshot as an MCP image block", async () => {
    if (!process.env.DISPLAY) return;
    const t = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/bin/omcps.js"), "--allow-screen", "--allow-keyboard"], env: { ...process.env } as Record<string, string> });
    const c = new Client({ name: "gui", version: "1" });
    await c.connect(t);
    const r = await c.callTool({ name: "screenshot", arguments: { max_width: 320 } });
    const blocks = r.content as { type: string; data?: string; mimeType?: string; text?: string }[];
    expect(blocks[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    const png = Buffer.from(blocks[1]?.data as string, "base64");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 200]);
    expect((await c.callTool({ name: "press_key", arguments: { keys: ["bogus"] } })).isError).toBe(true);
    await c.close();
  });

  it("streamable HTTP: stateless endpoint; one engine spans requests (rate limit)", async () => {
    const http = await serveHttp({ engine: new PermissionEngine(PolicySchema.parse({ default: "allow", capabilities: { "fs.write": "deny" }, limits: { maxTotalActions: 2 } })) }, "127.0.0.1", 0);
    const port = (http.address() as AddressInfo).port;
    try {
      const c = new Client({ name: "http", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const listed = (await c.listTools()).tools.map((x) => x.name);
      expect(listed).not.toContain("write_file");
      expect(textOf(await c.callTool({ name: "get_env", arguments: { name: "PATH" } }))).toContain("/");
      expect(textOf(await c.callTool({ name: "get_env", arguments: { name: "PATH" } }))).toContain("/");
      expect(textOf(await c.callTool({ name: "get_env", arguments: { name: "PATH" } }))).toContain("budget of 2 is used up");
      await c.close();
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/other`, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await fetch(`${base}/mcp`, { method: "GET" })).status).toBe(405);
      expect((await fetch(`${base}/mcp`, { method: "POST", body: "not json" })).status).toBe(400);
      const evil = await new Promise<number>((resolve) => {
        import("node:http").then(({ request }) => {
          const r = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example.com" } }, (res) => resolve(res.statusCode ?? 0));
          r.end("{}");
        });
      });
      expect(evil).toBe(403);
    } finally {
      http.close();
    }
  });

  it("the http server survives an internal error and reports it", async () => {
    const http = await serveHttp({ policy: { file: "/nonexistent/policy.json" } }, "127.0.0.1", 0).catch((e) => e as Error);
    expect(String((http as Error).message)).toContain("cannot read policy file");
    const ok = await serveHttp({ policy: "readonly" }, "127.0.0.1", 0);
    try {
      const port = (ok.address() as AddressInfo).port;
      const spy = vi.spyOn(await import("../../src/mcpServer.js"), "buildServer");
      spy.mockRestore();
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(r.status).toBeLessThan(500);
    } finally {
      ok.close();
    }
  });
});

describe("main() in-process", () => {
  const logs = (): { out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
    return { out, err };
  };

  it("prints the version; rejects bad flags, transports and policies", async () => {
    const { out, err } = logs();
    expect(await main(["--version"])).toBe(0);
    // eslint-disable-next-line security/detect-non-literal-regexp
    expect(out[0]).toMatch(new RegExp(`^desktop-mcp ${VERSION.replace(/\./g, "\\.")} on OS: `));
    expect(await main(["--bogus"])).toBe(2);
    expect(await main(["--transport", "carrier-pigeon"])).toBe(2);
    expect(await main(["--preset", "nonsense"])).toBe(2);
    expect(err.join("\n")).toContain("unknown preset 'nonsense'");
    const bad = path.join(tmpDir(), "p.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(bad, '{"default":"maybe"}');
    expect(await main(["--policy", bad])).toBe(2);
    expect(err.join("\n")).toContain("invalid policy");
  });

  it("--policy-show prints the effective policy and exits", async () => {
    const { out } = logs();
    expect(await main(["--preset", "readonly", "--deny-tool", "read_file", "--policy-show"])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Permission policy: readonly");
    expect(text).toContain("Not available:");
    expect(text).toContain("read_file");
  });

  it("serves stdio over injected streams until the client disconnects", async () => {
    const { err } = logs();
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const done = main(["--preset", "safe", "--no-search"], { stdin: toServer, stdout: fromServer });
    const c = new Client({ name: "in-proc", version: "1" });
    await c.connect(new StreamTransport(toServer, fromServer));
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("delete_path");
    expect(textOf(await c.callTool({ name: "run_command", arguments: { command: "echo in-process" } }))).toContain("in-process");
    await c.close();
    expect(await done).toBe(0);
    expect(err.join("")).toContain('permissions "safe"');
  });

  it("says so on stderr when nothing is allowed, and when everything is", async () => {
    const { err } = logs();
    const toServer = new PassThrough();
    const done = main([], { stdin: toServer, stdout: new PassThrough() });
    await new Promise((r) => setTimeout(r, 100));
    toServer.end();
    expect(await done).toBe(0);
    expect(err.join("")).toContain("nothing is allowed yet");
    const full = new PassThrough();
    const done2 = main(["--preset", "full"], { stdin: full, stdout: new PassThrough() });
    await new Promise((r) => setTimeout(r, 100));
    full.end();
    expect(await done2).toBe(0);
    expect(err.join("")).toContain('permissions "full" (no restrictions)');
  });

  it("serves streamable HTTP and stops on abort", async () => {
    const { err } = logs();
    const ac = new AbortController();
    let port = 0;
    const done = main(["--transport", "streamable-http", "--port", "0", "--preset", "readonly"], { signal: ac.signal, onListening: (p) => (port = p) });
    for (let i = 0; i < 100 && !port; i++) await new Promise((r) => setTimeout(r, 20));
    const c = new Client({ name: "x", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("write_file");
    await c.close();
    ac.abort();
    expect(await done).toBe(0);
    expect(err.join("")).toContain(`listening on http://127.0.0.1:${port}/mcp`);
  });

  it("rejects oversized HTTP request bodies", async () => {
    const http = await serveHttp({ policy: "readonly" }, "127.0.0.1", 0);
    const port = (http.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "x".repeat(1024 * 1024 + 1), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(413);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
});

describe("compiled binary", () => {
  const run = (args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.resolve("dist/bin/omcps.js"), ...args]);
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  it("--version, bad transport, --policy-show", async () => {
    expect((await run(["--version"])).out).toContain("desktop-mcp");
    expect((await run(["--transport", "x"])).code).toBe(2);
    expect((await run(["--preset", "locked", "--policy-show"])).out).toContain("Permission policy: locked");
  });
});
