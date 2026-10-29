/** The omcps command line, end to end: real main(), real flags, real MCP client, real desktop. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/mcpServer.js";
import { TOOL_META } from "../src/policy/capabilities.js";
import { VERSION } from "../src/version.js";
import { tmpDir } from "./helpers.js";
import { runOmcps, textOf } from "./stream.js";
import { haveWm, haveXev, openWindow, stopAll } from "./x.js";
import { windowFocus } from "../src/tools/window.js";

afterEach(() => { vi.restoreAllMocks(); });
const ALL = Object.keys(TOOL_META).filter((k) => k !== "think");

describe("deny by default", () => {
  it("with no flags only permissions_describe is offered, and the user is told what to do", async () => {
    const r = await runOmcps([]);
    expect(await r.names()).toEqual(["permissions_describe"]);
    expect(textOf(await r.client.callTool({ name: "permissions_describe", arguments: {} }))).toContain("Permission policy: locked");
    await r.close();
    expect(r.stderr.join("\n")).toContain("nothing is allowed yet. Add flags such as --allow-all");
  });
});

describe("feature flags choose the tools the AI sees", () => {
  it("--allow-mouse --allow-screen", async () => {
    const r = await runOmcps(["--allow-mouse", "--allow-screen", "--no-search"]);
    const n = await r.names();
    for (const t of ["move_mouse", "click", "mouse_drag", "scroll", "screenshot", "screen_read_text", "screen_find_image", "screen_find_color", "permissions_describe"]) expect(n, t).toContain(t);
    for (const t of ["type_text", "press_key", "run_command", "read_file", "window_list", "clipboard_get", "web_search", "screen_record"]) expect(n, t).not.toContain(t);
    await r.close();
  });

  it("--allow-all offers everything and turns the desktop tools on by itself", async () => {
    const r = await runOmcps(["--allow-all"]);
    expect((await r.names()).sort()).toEqual(ALL.sort());
    expect(textOf(await r.client.callTool({ name: "system_info", arguments: {} }))).toContain("CPU cores");
    await r.close();
  });

  it("individual groups", async () => {
    for (const [flag, has, hasNot] of [
      ["--allow-keyboard", "type_text", "click"], ["--allow-clipboard", "clipboard_set", "clipboard_paste"], ["--allow-windows", "window_close", "screenshot"],
      ["--allow-files", "write_file", "delete_path"], ["--allow-delete", "delete_path", "write_file"],
      ["--allow-shell", "run_command", "write_file"], ["--allow-processes", "kill_process", "run_command"], ["--allow-system", "get_env", "kill_process"],
      ["--allow-web", "fetch_url", "get_env"], ["--allow-open", "open_path", "run_command"], ["--allow-gui", "window_focus", "run_command"],
    ] as const) {
      const r = await runOmcps([flag]);
      const n = await r.names();
      expect(n, flag).toContain(has);
      expect(n, flag).not.toContain(hasNot);
      await r.close();
    }
  });

  it("tools that need two features appear only when both are allowed (pasting = clipboard + keyboard)", async () => {
    const both = await runOmcps(["--allow-clipboard", "--allow-keyboard"]);
    const n = await both.names();
    expect(n).toContain("clipboard_paste");
    expect(n).toContain("clipboard_copy");
    await both.close();
  });

  it("recording and saving screenshots also need permission to write files", async () => {
    const alone = await runOmcps(["--allow-record", "--allow-screen"]);
    const a = await alone.names();
    expect(a).not.toContain("screen_record");
    expect(a).not.toContain("screenshot_save");
    expect(a).toContain("screenshot");
    await alone.close();
    const withFiles = await runOmcps(["--allow-record", "--allow-screen", "--allow-files"]);
    const w = await withFiles.names();
    expect(w).toContain("screen_record");
    expect(w).toContain("screenshot_save");
    await withFiles.close();
  });

  it("--preset and --config are bases the flags layer onto", async () => {
    const r = await runOmcps(["--preset", "readonly", "--allow-mouse"]);
    const n = await r.names();
    expect(n).toContain("read_file");
    expect(n).toContain("click");
    expect(n).not.toContain("write_file");
    await r.close();
    const safe = await runOmcps(["--safe", "--no-search"]);
    expect(await safe.names()).not.toContain("delete_path");
    await safe.close();
    const ro = await runOmcps(["--read-only", "--no-search"]);
    expect(await ro.names()).not.toContain("run_command");
    await ro.close();
  });

  it("--help and --version", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    expect(await main(["--help"])).toBe(0);
    expect(await main(["-h"])).toBe(0);
    expect(await main(["--version"])).toBe(0);
    expect(out[0]).toContain("npx desktop-mcp@latest --allow-all");
    for (const f of ["--allow-all", "--allow-mouse", "--allow-clipboard", "--allow-keyboard", "--transport", "--no-search", "--policy-show", "--region", "--preset"]) expect(out[0], f).toContain(f);
    expect(out[0]).toContain("only web_search/fetch_url touch the network");
    expect(out.at(-1)).toMatch(new RegExp(`^desktop-mcp ${VERSION.replace(/\./g, "\\.")} on OS: `));
  });

  it("--policy-show describes the effective permissions", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    expect(await main(["--allow-mouse", "--ask-shell", "--allow-path", "/work", "--policy-show"])).toBe(0);
    const t = out.join("\n");
    expect(t).toContain("Permission policy: flags");
    expect(t).toContain("Allowed:");
    expect(t).toContain("Needs user approval: run_command");
    expect(t).toContain("Files limited to: /work");
  });

  it("rejects bad flag values with exit code 2", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const argv of [["--region", "1,2"], ["--rate-limit", "0"], ["--ask-fallback", "maybe"], ["--config", "/nonexistent.json"], ["--allow-nonsense"], ["--max-actions", "x"]]) {
      expect(await main(argv), argv.join(" ")).toBe(2);
    }
  });
});

describe("scoping flags are enforced", () => {
  it("--allow-files --allow-path confines file access; credential folders stay protected", async () => {
    const root = tmpDir();
    const r = await runOmcps(["--allow-files", "--allow-path", root]);
    const f = path.join(root, "a.txt");
    expect(textOf(await r.client.callTool({ name: "write_file", arguments: { path: f, content: "hi" } }))).toContain("wrote 2 chars");
    expect(textOf(await r.client.callTool({ name: "read_file", arguments: { path: f } }))).toContain("hi");
    expect(textOf(await r.client.callTool({ name: "read_file", arguments: { path: "/etc/hostname" } }))).toContain("outside the allowed paths");
    await r.close();
    const open = await runOmcps(["--allow-files"]);
    expect(textOf(await open.client.callTool({ name: "read_file", arguments: { path: "~/.ssh/id_rsa" } }))).toBe(`[permission denied] path ${process.env.HOME ?? "/root"}/.ssh/id_rsa is denied by policy`);
    await open.close();
    const unlocked = await runOmcps(["--allow-files", "--allow-sensitive-paths"]);
    const missing = path.join(process.env.HOME ?? "/root", ".ssh", `omcps-missing-${process.pid}`);
    expect(textOf(await unlocked.client.callTool({ name: "read_file", arguments: { path: missing } }))).toContain("not a file"); // reached the tool
    await unlocked.close();
  });

  it("--allow-shell refuses dangerous commands unless that net is switched off; --allow-command is an exclusive list", async () => {
    const r = await runOmcps(["--allow-shell"]);
    expect(textOf(await r.client.callTool({ name: "run_command", arguments: { command: "echo sudo" } }))).toContain("dangerous pattern");
    expect(textOf(await r.client.callTool({ name: "run_command", arguments: { command: "echo fine" } }))).toContain("fine");
    await r.close();
    const off = await runOmcps(["--allow-shell", "--allow-dangerous-commands"]);
    expect(textOf(await off.client.callTool({ name: "run_command", arguments: { command: "echo sudo" } }))).toContain("exit_code: 0");
    await off.close();
    const list = await runOmcps(["--allow-shell", "--allow-command", "^echo "]);
    expect(textOf(await list.client.callTool({ name: "run_command", arguments: { command: "echo ok" } }))).toContain("ok");
    expect(textOf(await list.client.callTool({ name: "run_command", arguments: { command: "ls" } }))).toContain("not on the allow-list");
    expect(textOf(await list.client.callTool({ name: "run_command", arguments: { command: "echo a; ls" } }))).toContain("chaining");
    const deny = await runOmcps(["--allow-shell", "--deny-command", "hostname"]);
    expect(textOf(await deny.client.callTool({ name: "run_command", arguments: { command: "hostname" } }))).toContain("denied pattern");
    await list.close(); await deny.close();
  });

  it("--allow-web --allow-host limits where fetch_url may go (denied before any network use)", async () => {
    const r = await runOmcps(["--allow-web", "--allow-host", "(^|\\.)example\\.com$", "--deny-host", "^evil\\.example\\.com$"]);
    expect(textOf(await r.client.callTool({ name: "fetch_url", arguments: { url: "https://other.org/" } }))).toContain("not on the allow-list");
    expect(textOf(await r.client.callTool({ name: "fetch_url", arguments: { url: "https://evil.example.com/" } }))).toContain("is denied");
    await r.close();
  });

  it("--rate-limit and --max-actions", async () => {
    const r = await runOmcps(["--allow-system", "--max-actions", "2"]);
    expect(textOf(await r.client.callTool({ name: "get_env", arguments: { name: "PATH" } }))).toContain("/");
    expect(textOf(await r.client.callTool({ name: "get_env", arguments: { name: "PATH" } }))).toContain("/");
    expect(textOf(await r.client.callTool({ name: "get_env", arguments: { name: "PATH" } }))).toContain("budget of 2 is used up");
    await r.close();
    const rl = await runOmcps(["--allow-system", "--rate-limit", "1"]);
    await rl.client.callTool({ name: "get_env", arguments: { name: "PATH" } });
    expect(textOf(await rl.client.callTool({ name: "get_env", arguments: { name: "PATH" } }))).toContain("rate limit of 1 actions per minute");
    await rl.close();
  });

  it("--audit-file records decisions", async () => {
    const log = path.join(tmpDir(), "audit.jsonl");
    const r = await runOmcps(["--allow-system", "--audit-file", log, "--audit-args"]);
    await r.client.callTool({ name: "get_env", arguments: { name: "PATH" } });
    await r.client.callTool({ name: "kill_process", arguments: { pid: 1 } }).catch(() => undefined);
    await r.close();
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ policy: "flags", tool: "get_env", allowed: true, args: { name: "PATH" } });
  });

  it("--deny-tool / --allow-tool", async () => {
    const r = await runOmcps(["--allow-system", "--deny-tool", "get_env", "--allow-tool", "read_file"]);
    const n = await r.names();
    expect(n).toContain("system_info");
    expect(n).not.toContain("get_env");
    expect(n).toContain("read_file");
    await r.close();
  });
});

describe("--ask-* goes through MCP elicitation", () => {
  it("asks, honours approve and decline, and shows no file contents", async () => {
    const r = await runOmcps(["--ask-files", "--allow-files-read"], { elicitation: {} });
    const seen: string[] = [];
    let approve = true;
    r.client.setRequestHandler(ElicitRequestSchema, async (req) => (seen.push(req.params.message), { action: "accept", content: { approve } }));
    const f = path.join(tmpDir(), "o.txt");
    expect(textOf(await r.client.callTool({ name: "write_file", arguments: { path: f, content: "TOP-SECRET" } }))).toContain("wrote");
    expect(seen[0]).toContain("<10 chars>");
    expect(seen[0]).not.toContain("TOP-SECRET");
    approve = false;
    expect(textOf(await r.client.callTool({ name: "write_file", arguments: { path: f, content: "x" } }))).toContain("did not approve");
    expect(textOf(await r.client.callTool({ name: "read_file", arguments: { path: f } }))).toContain("TOP-SECRET"); // reads were allowed, not asked
    expect(seen).toHaveLength(2);
    await r.close();
  });

  it("without a client that can be asked, ask is refused (or allowed with --ask-fallback allow)", async () => {
    const r = await runOmcps(["--ask-shell"]);
    expect(textOf(await r.client.callTool({ name: "run_command", arguments: { command: "echo x" } }))).toContain("nobody could be asked");
    await r.close();
    const lenient = await runOmcps(["--ask-shell", "--ask-fallback", "allow"]);
    expect(textOf(await lenient.client.callTool({ name: "run_command", arguments: { command: "echo x" } }))).toContain("exit_code: 0");
    await lenient.close();
  });
});

describe.skipIf(!haveXev)("desktop scoping flags on the real desktop", () => {
  it("--region confines clicks and captures", async () => {
    const r = await runOmcps(["--allow-mouse", "--allow-screen", "--region", "0,0,200,200"]);
    expect(textOf(await r.client.callTool({ name: "click", arguments: { x: 600, y: 600 } }))).toContain("outside the allowed screen regions");
    expect(textOf(await r.client.callTool({ name: "screenshot", arguments: {} }))).toContain("whole screen is not allowed");
    expect((await r.client.callTool({ name: "screenshot", arguments: { x: 10, y: 10, width: 50, height: 50 } })).isError).toBeFalsy();
    expect(textOf(await r.client.callTool({ name: "move_mouse", arguments: { x: 100, y: 100 } }))).toContain("moved");
    await r.close();
    const n = await import("@nut-tree-fork/nut-js");
    await n.mouse.setPosition(new n.Point(640, 400));
  });

  it("--block-key and --block-text and --max-type-chars", async () => {
    const r = await runOmcps(["--allow-keyboard", "--block-key", "ctrl+alt+delete", "--block-text", "\\d{16}", "--max-type-chars", "5"]);
    expect(textOf(await r.client.callTool({ name: "press_key", arguments: { keys: ["ctrl", "alt", "delete"] } }))).toContain("is blocked");
    expect(textOf(await r.client.callTool({ name: "type_text", arguments: { text: "4111111111111111" } }))).toContain("longer than 5");
    await r.close();
    const r2 = await runOmcps(["--allow-keyboard", "--block-text", "\\d{4}"]);
    expect(textOf(await r2.client.callTool({ name: "type_text", arguments: { text: "1234" } }))).toContain("blocked pattern");
    await r2.close();
  });
});

describe.skipIf(!haveWm)("--allow-window on real windows", () => {
  it("input only while an allowed window has focus", async () => {
    await openWindow("omcps-ok", { geometry: "30x4+100+100" });
    await openWindow("omcps-no", { geometry: "30x4+500+100" });
    const r = await runOmcps(["--allow-mouse", "--allow-windows", "--allow-window", "^omcps-ok$"]);
    await windowFocus({ title: "^omcps-ok$" });
    await new Promise((res) => setTimeout(res, 200));
    expect(textOf(await r.client.callTool({ name: "move_mouse", arguments: { x: 300, y: 300 } }))).toContain("moved");
    await windowFocus({ title: "^omcps-no$" });
    await new Promise((res) => setTimeout(res, 200));
    expect(textOf(await r.client.callTool({ name: "move_mouse", arguments: { x: 300, y: 300 } }))).toContain('active window "omcps-no" is not in the allowed windows');
    expect(textOf(await r.client.callTool({ name: "window_close", arguments: { title: "^omcps-no$" } }))).toContain("not in the allowed windows");
    await r.close();
    stopAll();
    expect(existsSync("/tmp")).toBe(true);
  });
});
