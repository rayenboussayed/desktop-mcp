/**
 * "Everything runs locally": proven two ways.
 *  1. Static: only the web tools and the standalone agent may contain network-client code or reference a cloud SDK.
 *  2. Dynamic: the whole MCP server, with every feature allowed, works inside a network namespace that has NO network
 *     (real desktop, real OCR, real image/colour search, clipboard, files, shell); only the web tools fail.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, afterAll } from "vitest";
import { hasBinary, tmpDir } from "../helpers.js";
import { haveWm, haveXterm, openWindow, stopAll } from "../x.js";

// eslint-disable-next-line security/detect-non-literal-fs-filename
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
const SRC = walk("src").filter((f) => !f.includes(`${path.sep}bin${path.sep}`));
// files that are SUPPOSED to touch the network, and why
const NETWORK_ALLOWED = new Set([path.join("src", "tools", "search.ts"), path.join("src", "agent.ts")]);

describe("static guard: no hidden network or cloud dependencies", () => {
  const forbidden: [string, RegExp][] = [
    ["fetch()", /\bfetch\s*\(/], ["XMLHttpRequest", /XMLHttpRequest/], ["WebSocket", /new WebSocket/], ["node:https", /node:https/],
    ["http client", /\bhttps?\.(request|get)\(/], ["a cloud SDK", /@anthropic-ai|openai|api\.anthropic|ANTHROPIC_|OPENAI_|AZURE_/i],
  ];
  it("only the web tools and the standalone agent may use the network or an LLM SDK", () => {
    expect(SRC.length).toBeGreaterThan(30);
    for (const file of SRC) {
      if (NETWORK_ALLOWED.has(file)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const code = readFileSync(file, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      for (const [what, re] of forbidden) expect(re.test(code), `${file} must not use ${what}`).toBe(false);
    }
  });
  it("the MCP server and the plugins never import the agent", () => {
    for (const file of SRC.filter((f) => f !== path.join("src", "agent.ts") && f !== path.join("src", "cli.ts") && f !== path.join("src", "index.ts"))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(/from "\.\.?\/agent\.js"/.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });
  it("a cloud client is not a dependency of the MCP server (only an optional peer of the standalone agent)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, Record<string, unknown>>;
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@anthropic-ai/sdk");
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain("@anthropic-ai/sdk");
    expect(pkg.peerDependenciesMeta?.["@anthropic-ai/sdk"]).toEqual({ optional: true });
    expect(pkg.name).toBe("desktop-mcp");
    expect((pkg.bin as unknown as Record<string, string>)["desktop-mcp"]).toBe("./dist/bin/omcps.js");
  });
  it("OCR is configured with local data only", () => {
    const ocr = readFileSync("src/plugins/ocr.ts", "utf8");
    expect(ocr).toContain("Nothing is downloaded automatically");
    expect(ocr).toContain("langPath");
  });
});

const canIsolate = spawnSync("unshare", ["-n", "true"]).status === 0;

describe.skipIf(!canIsolate || !haveWm || !haveXterm || !hasBinary("xclip"))("everything works with NO network at all", () => {
  afterAll(() => stopAll());

  it("runs every local feature inside a network-less namespace; only the web tools fail", async () => {
    await openWindow("offline-win", { geometry: "34x4+60+80", font: 30, text: "HELLO OFFLINE WORLD" });
    const dir = tmpDir();
    const script = path.join(dir, "offline.mjs");
    const sdk = path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(script, `
import { Client } from "${sdk}/client/index.js";
import { StdioClientTransport } from "${sdk}/client/stdio.js";
const t = new StdioClientTransport({ command: process.execPath, args: [${JSON.stringify(path.resolve("dist/bin/omcps.js"))}, "--allow-all"], env: { ...process.env } });
const c = new Client({ name: "offline", version: "1" });
await c.connect(t);
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content.map((b) => b.text ?? "<" + b.type + ">").join("") }; };
const out = {};
// is the network really off?
try { await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) }); out.networkOff = false; } catch { out.networkOff = true; }
out.system = await call("system_info");
out.files = await call("write_file", { path: ${JSON.stringify(path.join(dir, "f.txt"))}, content: "local file" });
out.read = await call("read_file", { path: ${JSON.stringify(path.join(dir, "f.txt"))} });
out.shell = await call("run_command", { command: "echo offline-shell" });
out.clipSet = await call("clipboard_set", { text: "offline clipboard" });
out.clipGet = await call("clipboard_get");
out.windows = await call("window_list");
out.screenshot = await call("screenshot", { max_width: 200 });
out.mouse = await call("mouse_position");
out.ocr = await call("screen_find_text", { text: "OFFLINE", scale: 1 });
out.ocrRead = await call("screen_read_text", {});
out.color = await call("screen_find_color", { color: "#ffffff", min_pixels: 200 });
out.save = await call("screenshot_save", { path: ${JSON.stringify(path.join(dir, "s.png"))}, x: 60, y: 80, width: 160, height: 60 });
out.image = await call("screen_find_image", { template: ${JSON.stringify(path.join(dir, "s.png"))}, confidence: 0.98 });
out.status = await call("plugin_status");
out.webSearch = await call("web_search", { query: "anything" });
out.fetch = await call("fetch_url", { url: "https://example.com/" });
await c.close();
console.log("RESULT " + JSON.stringify(out));
`);
    const r = spawnSync("unshare", ["-n", process.execPath, script], { encoding: "utf8", timeout: 240_000, env: { ...process.env } });
    const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    expect(line, r.stderr.slice(-500)).toBeDefined();
    const o = JSON.parse((line as string).slice(7)) as { networkOff: boolean } & Record<string, { err: boolean; text: string }>;
    // eslint-disable-next-line security/detect-object-injection
    const r_ = (k: string): { err: boolean; text: string } => o[k] as { err: boolean; text: string };
    expect(o.networkOff).toBe(true); // the sandbox really had no network
    expect(r_("system").text).toContain("CPU cores");
    expect(r_("read").text).toContain("local file");
    expect(r_("shell").text).toContain("offline-shell");
    expect(r_("clipGet").text).toBe("offline clipboard");
    expect(r_("windows").text).toContain("offline-win");
    expect(r_("screenshot").text).toContain("<image>");
    expect(r_("mouse").text).toMatch(/^\(\d+,\d+\)$/);
    expect(r_("ocr").text).toContain("match 1");        // OCR with no network (model data is local)
    expect(r_("ocrRead").text.toUpperCase()).toContain("HELLO");
    expect(r_("color").text).toContain("match 1");
    expect(r_("image").text).toContain("match 1");
    expect(r_("status").text).toContain("built-in");
    for (const k of ["system", "files", "read", "shell", "clipSet", "clipGet", "windows", "screenshot", "mouse", "ocr", "ocrRead", "color", "save", "image", "status"]) expect(r_(k).err, `${k}: ${r_(k).text}`).toBe(false);
    // and the only things that need the internet are the web tools, which fail cleanly
    expect(r_("webSearch").text).toContain("[error] search failed");
    expect(r_("fetch").text).toContain("[error] fetch failed");
  }, 300_000);
});
