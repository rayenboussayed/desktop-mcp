import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_META } from "../../src/policy/capabilities.js";
import {
  PermissionDenied, PermissionEngine, canonicalPath, currentEngine, pathRegExp, type AskRequest, type EngineDeps,
} from "../../src/policy/engine.js";
import { PolicyError, createEngine, parsePolicy, resolvePolicy } from "../../src/policy/load.js";
import { PRESET_NAMES, SENSITIVE_PATHS, preset } from "../../src/policy/presets.js";
import { PolicySchema, type PolicyInput } from "../../src/policy/schema.js";
import { defineTool, type Tool } from "../../src/tools/base.js";
import { readFileTool } from "../../src/tools/files.js";
import { z } from "zod";
import { tmpDir } from "../helpers.js";

const engine = (input: PolicyInput, deps: EngineDeps = {}): PermissionEngine => new PermissionEngine(PolicySchema.parse(input), deps);
const allowed = async (e: PermissionEngine, tool: string, args: Record<string, unknown> = {}): Promise<boolean> => (await e.authorize(tool, args)).allowed;
const reason = async (e: PermissionEngine, tool: string, args: Record<string, unknown> = {}): Promise<string | undefined> => (await e.authorize(tool, args)).reason;

describe("schema and loader", () => {
  it("fills defaults", () => {
    const p = PolicySchema.parse({});
    expect(p).toMatchObject({ default: "deny", askFallback: "deny", paths: { allow: [], deny: [], readOnly: [] }, commands: { blockDangerous: false, allowChaining: false } });
    expect(p.gui).toMatchObject({ regions: [], windows: [] });
  });
  it("rejects unknown keys, bad modes and bad capabilities", () => {
    expect(() => PolicySchema.parse({ bogus: 1 })).toThrow();
    expect(() => PolicySchema.parse({ default: "maybe" })).toThrow();
    expect(() => PolicySchema.parse({ capabilities: { "fs.teleport": "allow" } })).toThrow();
    expect(() => PolicySchema.parse({ gui: { regions: [{ x: 0, y: 0, width: 0, height: 5 }] } })).toThrow();
  });
  it("parsePolicy reports JSON and schema errors readably", () => {
    expect(() => parsePolicy("{nope", "p.json")).toThrow(/p\.json: not valid JSON/);
    expect(() => parsePolicy('{"default":"x","tools":{"a":"b"}}', "p.json")).toThrow(/invalid policy: default: .*tools\.a/);
    expect(() => parsePolicy("1")).toThrow(PolicyError);
    expect(parsePolicy('{"name":"n","default":"allow"}').name).toBe("n");
  });
  it("every preset is valid and named", () => {
    for (const n of PRESET_NAMES) expect(preset(n).name).toBe(n);
    expect(SENSITIVE_PATHS.length).toBeGreaterThan(5);
  });
  it("resolvePolicy: file, preset, legacy flags, overrides, errors", async () => {
    const d = tmpDir();
    const f = path.join(d, "p.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(f, '{"name":"mine","default":"allow","tools":{"run_command":"deny"}}');
    expect((await resolvePolicy({ file: f })).name).toBe("mine");
    expect((await resolvePolicy({ preset: "standard" })).name).toBe("standard");
    expect((await resolvePolicy({ safe: true })).name).toBe("safe");
    expect((await resolvePolicy({ readOnly: true, safe: true })).name).toBe("readonly");
    expect((await resolvePolicy()).name).toBe("full");
    const o = await resolvePolicy({ file: f, denyTools: ["delete_path"], allowTools: ["run_command"] });
    expect(o.tools).toEqual({ run_command: "allow", delete_path: "deny" });
    await expect(resolvePolicy({ preset: "nope" })).rejects.toThrow(/unknown preset 'nope'/);
    await expect(resolvePolicy({ file: path.join(d, "missing.json") })).rejects.toThrow(/cannot read policy file/);
    expect((await createEngine({ preset: "locked" })).policy.name).toBe("locked");
  });
  it("rejects invalid regular expressions up front", () => {
    expect(() => engine({ commands: { allow: ["("] } })).toThrow(/invalid commands\.allow pattern/);
  });
});

describe("path matching and canonicalization", () => {
  it("uses exact segment and descendant boundaries, not string prefixes", () => {
    const exact = pathRegExp("/tmp/allowed");
    expect(exact.test("/tmp/allowed")).toBe(true);
    expect(exact.test("/tmp/allowed/src/file.txt")).toBe(true);
    expect(exact.test("/tmp/allowed-not-a-prefix")).toBe(false);
    expect(exact.test("/tmp/notallowed")).toBe(false);

    const glob = pathRegExp("/tmp/allowed/**/*.env");
    expect(glob.test("/tmp/allowed/.env")).toBe(true);
    expect(glob.test("/tmp/allowed/a/b/.env")).toBe(true);
    expect(glob.test("/tmp/allowed/src/.env.not")).toBe(false);
  });

  it("returns the real path for an existing symlinked ancestor", async () => {
    const d = tmpDir();
    const target = path.join(d, "target");
    const link = path.join(d, "link");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(target);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    symlinkSync(target, link);
    expect(await canonicalPath(target)).toBe(target.replace(/\\/g, "/"));
    expect(await canonicalPath(path.join(link, "new", "file"))).toBe(path.join(target, "new", "file").replace(/\\/g, "/"));
  });
});

describe("tool metadata", () => {
  it("every tool the server can register has permission metadata, and vice versa", async () => {
    const { selectTools } = await import("../../src/mcpServer.js");
    const { buildToolset } = await import("../../src/tools/index.js");
    const served = (await selectTools({ gui: true, policy: "full" })).map((t) => t.name);
    const agent = [...(await buildToolset(true, true)).keys()];
    expect([...new Set([...served, ...agent])].sort()).toEqual(Object.keys(TOOL_META).sort());
    expect(served).not.toContain("think");
  });
  it("unknown tools fail closed, even under the full preset", async () => {
    const e = engine({ default: "allow" });
    expect(await allowed(e, "brand_new_tool")).toBe(false);
    expect(await reason(e, "brand_new_tool")).toContain("no permission metadata");
    expect(e.isVisible("brand_new_tool")).toBe(false);
  });
});

describe("modes and visibility", () => {
  it("combines capabilities: deny beats ask beats allow", () => {
    const e = engine({ default: "allow", capabilities: { "fs.write": "ask", "fs.delete": "deny" } });
    expect(e.staticMode("read_file")).toBe("allow");
    expect(e.staticMode("write_file")).toBe("ask");
    expect(e.staticMode("move_path")).toBe("deny"); // needs fs.write AND fs.delete
    expect(e.staticMode("copy_path")).toBe("ask"); // fs.read allow + fs.write ask
    expect(e.isVisible("delete_path")).toBe(false);
    expect(e.isVisible("write_file")).toBe(true);
  });
  it("per-tool overrides win in both directions", () => {
    const e = engine({ default: "deny", capabilities: { "fs.read": "allow" }, tools: { read_file: "deny", run_command: "allow" } });
    expect(e.staticMode("read_file")).toBe("deny");
    expect(e.staticMode("run_command")).toBe("allow");
    expect(e.staticMode("list_dir")).toBe("allow");
  });
  it("a denied tool is refused with a clear reason", async () => {
    const e = engine({ default: "deny" });
    const d = await e.authorize("write_file", { path: "/tmp/x" });
    expect(d).toMatchObject({ allowed: false, mode: "deny", asked: false });
    expect(d.reason).toContain('tool write_file is not permitted by policy "custom"');
  });
});

describe("file scope (real files, real symlinks)", () => {
  /**
   *
   * @returns Paths inside and outside the sandbox root.
   */
  function sandbox(): { root: string; inside: string; outside: string } {
    const root = path.join(tmpDir(), "proj");
    const outside = path.join(tmpDir(), "secret");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(path.join(root, "src"), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(outside, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path.join(root, "src/a.txt"), "a");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path.join(outside, "key.txt"), "k");
    return { root, inside: path.join(root, "src/a.txt"), outside: path.join(outside, "key.txt") };
  }

  it("allow-list confines every file tool", async () => {
    const { root, inside, outside } = sandbox();
    const e = engine({ default: "allow", paths: { allow: [root] } });
    expect(await allowed(e, "read_file", { path: inside })).toBe(true);
    expect(await allowed(e, "write_file", { path: path.join(root, "new/dir/f.txt") })).toBe(true); // not yet existing
    expect(await reason(e, "read_file", { path: outside })).toContain("outside the allowed paths");
    expect(await allowed(e, "copy_path", { src: inside, dst: outside })).toBe(false);
    expect(await allowed(e, "move_path", { src: outside, dst: inside })).toBe(false);
    expect(await allowed(e, "list_dir", { path: root })).toBe(true);
    expect(await allowed(e, "find_files", { pattern: "*", root: "/" })).toBe(false);
  });

  it("a symlink inside the allowed tree cannot reach outside it", async () => {
    const { root, outside } = sandbox();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    symlinkSync(path.dirname(outside), path.join(root, "escape"));
    const e = engine({ default: "allow", paths: { allow: [root] } });
    expect(await reason(e, "read_file", { path: path.join(root, "escape/key.txt") })).toContain("outside the allowed paths");
    expect(await allowed(e, "write_file", { path: path.join(root, "escape/new.txt") })).toBe(false); // new file under a link
  });

  it("deny beats allow, matches lexical and real paths, and supports globs", async () => {
    const { root, inside } = sandbox();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(path.join(root, ".git"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path.join(root, ".git/config"), "x");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path.join(root, "src/.env"), "S=1");
    const e = engine({ default: "allow", paths: { allow: [root], deny: [`${root}/.git`, `${root}/**/.env`] } });
    expect(await reason(e, "read_file", { path: path.join(root, ".git/config") })).toContain("denied by policy");
    expect(await allowed(e, "read_file", { path: path.join(root, "src/.env") })).toBe(false);
    expect(await allowed(e, "read_file", { path: inside })).toBe(true);
    const link = path.join(root, "gitlink");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    symlinkSync(path.join(root, ".git"), link);
    expect(await allowed(e, "read_file", { path: path.join(link, "config") })).toBe(false); // denied via the REAL path
  });

  it("readOnly paths can be read but not written, deleted or moved", async () => {
    const { root, inside } = sandbox();
    const e = engine({ default: "allow", paths: { readOnly: [root] } });
    expect(await allowed(e, "read_file", { path: inside })).toBe(true);
    for (const [tool, args] of [["write_file", { path: inside }], ["edit_file", { path: inside }], ["delete_path", { path: inside }], ["make_dir", { path: `${root}/n` }], ["move_path", { src: inside, dst: "/tmp/z" }]] as const) {
      expect(await reason(e, tool, { ...args }), tool).toContain("read-only");
    }
  });

  it("expands ~ and checks relative paths against the real cwd", async () => {
    const e = engine({ default: "allow", paths: { deny: ["~/.ssh"] } });
    expect(await allowed(e, "read_file", { path: "~/.ssh/id_rsa" })).toBe(false);
    expect(await allowed(e, "read_file", { path: path.join(os.homedir(), ".ssh") })).toBe(false);
    expect(await allowed(e, "read_file", { path: "~/notes.txt" })).toBe(true);
    const rel = engine({ default: "allow", paths: { allow: [process.cwd()] } });
    expect(await allowed(rel, "read_file", { path: "package.json" })).toBe(true);
  });

  it("open_path scopes files but not URLs; run_command scopes its cwd", async () => {
    const { root, outside } = sandbox();
    const e = engine({ default: "allow", paths: { allow: [root] } });
    expect(await allowed(e, "open_path", { target: "https://example.com" })).toBe(true);
    expect(await allowed(e, "open_path", { target: outside })).toBe(false);
    expect(await allowed(e, "run_command", { command: "ls", cwd: outside })).toBe(false);
    expect(await allowed(e, "run_command", { command: "ls" })).toBe(true);
  });

  it("pathRegExp and canonicalPath", async () => {
    const d = tmpDir();
    const r = pathRegExp("/a/b/**/c.txt");
    expect(r.test("/a/b/c.txt")).toBe(true);
    expect(r.test("/a/b/x/y/c.txt")).toBe(true);
    expect(r.test("/a/bb/c.txt")).toBe(false);
    expect(pathRegExp("/a/*.js").test("/a/x.js")).toBe(true);
    expect(pathRegExp("/a/*.js").test("/a/x/y.js")).toBe(false);
    expect(pathRegExp("/a/?.js").test("/a/x.js")).toBe(true);
    expect(pathRegExp("/a/b").test("/a/b/c/d")).toBe(true); // subtree
    expect(pathRegExp("/a/b").test("/a/bc")).toBe(false);
    expect(pathRegExp("/a/**").test("/a")).toBe(true);
    expect(pathRegExp("/").test("/anything/at/all")).toBe(true);
    expect(pathRegExp("/a/**x").test("/a/zzx")).toBe(true);
    expect(pathRegExp("/a.b+c").test("/a.b+c")).toBe(true);
    expect(pathRegExp("/a.b").test("/aXb")).toBe(false);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    symlinkSync(d, path.join(tmpDir(), "ln-unused")); // (just exercising symlink creation on temp dirs)
    const real = path.join(d, "real");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(real);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    symlinkSync(real, path.join(d, "ln"));
    expect(await canonicalPath(path.join(d, "ln/missing/deeper"))).toBe((await canonicalPath(real)) + "/missing/deeper");
    expect(await canonicalPath("/")).toBe("/");
  });

  it("case-insensitive matching on Windows/macOS", () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(pathRegExp("/Users/Me").test("/users/me/x")).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
    expect(pathRegExp("/Users/Me").test("/users/me/x")).toBe(false);
  });
});

describe("shell scope", () => {
  it("deny patterns and dangerous blocking", async () => {
    const e = engine({ default: "allow", commands: { deny: ["curl"], blockDangerous: true } });
    expect(await reason(e, "run_command", { command: "CURL http://x" })).toContain("denied pattern");
    expect(await reason(e, "run_command", { command: "sudo ls" })).toContain("dangerous");
    expect(await allowed(e, "run_command", { command: "ls -la" })).toBe(true);
  });
  it("an allow-list is exclusive and refuses chaining (the classic bypass)", async () => {
    const e = engine({ default: "allow", commands: { allow: ["^git (status|log)", "^ls\\b"] } });
    expect(await allowed(e, "run_command", { command: "git status" })).toBe(true);
    expect(await reason(e, "run_command", { command: "rm -rf /" })).toContain("not on the allow-list");
    for (const bad of ["git status; rm -rf /", "git status && curl x", "ls | sh", "ls `id`", "ls $(id)", "ls > /etc/x", "ls\nrm x", "ls & rm x"]) {
      expect(await reason(e, "run_command", { command: bad }), bad).toContain("chaining");
    }
    const chain = engine({ default: "allow", commands: { allow: ["^ls"], allowChaining: true } });
    expect(await allowed(chain, "run_command", { command: "ls; ls" })).toBe(true);
  });
});

describe("network scope", () => {
  it("restricts fetch_url hosts", async () => {
    const e = engine({ default: "allow", network: { allowHosts: ["(^|\\.)example\\.com$"], denyHosts: ["^evil\\.example\\.com$"] } });
    expect(await allowed(e, "fetch_url", { url: "https://docs.example.com/a" })).toBe(true);
    expect(await reason(e, "fetch_url", { url: "https://evil.example.com/" })).toContain("denied");
    expect(await reason(e, "fetch_url", { url: "https://other.org/" })).toContain("not on the allow-list");
    expect(await reason(e, "fetch_url", { url: "not a url" })).toContain("invalid URL");
    expect(await allowed(e, "web_search", { query: "x" })).toBe(true);
  });
});

describe("GUI scope", () => {
  const box = { x: 100, y: 100, width: 400, height: 300 };
  it("clicks and drags must stay inside the allowed regions", async () => {
    const e = engine({ default: "allow", gui: { regions: [box] } });
    expect(await allowed(e, "click", { x: 100, y: 100 })).toBe(true);
    expect(await allowed(e, "click", { x: 499, y: 399 })).toBe(true);
    expect(await reason(e, "click", { x: 500, y: 399 })).toContain("outside the allowed screen regions");
    expect(await allowed(e, "move_mouse", { x: 0, y: 0 })).toBe(false);
    expect(await allowed(e, "mouse_drag", { from_x: 150, from_y: 150, to_x: 200, to_y: 200 })).toBe(true);
    expect(await allowed(e, "mouse_drag", { from_x: 150, from_y: 150, to_x: 900, to_y: 200 })).toBe(false);
    expect(await allowed(e, "screen_color_at", { x: 50, y: 50 })).toBe(false);
  });
  it("captures need a region inside the allowed area", async () => {
    const e = engine({ default: "allow", gui: { regions: [box] } });
    expect(await reason(e, "screenshot", {})).toContain("whole screen is not allowed");
    expect(await allowed(e, "screenshot", { x: 120, y: 120, width: 50, height: 50 })).toBe(true);
    expect(await reason(e, "screenshot", { x: 90, y: 120, width: 50, height: 50 })).toContain("outside the allowed screen regions");
    expect(await allowed(e, "screen_read_text", { x: 100, y: 100, width: 400, height: 300 })).toBe(true);
    expect(await allowed(e, "screen_read_text", {})).toBe(false);
    expect(await allowed(e, "screen_highlight", { x: 100, y: 100, width: 10, height: 10 })).toBe(true);
    expect(await allowed(e, "screen_highlight", { x: 0, y: 0, width: 10, height: 10 })).toBe(false);
    const free = engine({ default: "allow" });
    expect(await allowed(free, "screenshot", {})).toBe(true);
    expect(await allowed(free, "screen_highlight", { x: 0, y: 0, width: 10, height: 10 })).toBe(true);
  });
  it("blocks hotkeys regardless of order, alias or extra modifiers", async () => {
    const e = engine({ default: "allow", gui: { blockedKeys: ["ctrl+alt+delete", "meta+l"] } });
    expect(await allowed(e, "press_key", { keys: ["Delete", "Control", "Alt"] })).toBe(false);
    expect(await allowed(e, "press_key", { keys: ["ctrl", "alt", "shift", "del"] })).toBe(false);
    expect(await allowed(e, "key_down", { keys: ["win", "l"] })).toBe(false);
    expect(await allowed(e, "press_key", { keys: ["cmd", "l"] })).toBe(false);
    expect(await allowed(e, "press_key", { keys: ["ctrl", "c"] })).toBe(true);
    expect(await allowed(e, "press_key", { keys: ["l"] })).toBe(true);
  });
  it("limits typed text", async () => {
    const e = engine({ default: "allow", gui: { maxTypeChars: 5, blockedText: ["\\b\\d{16}\\b", "password"] } });
    expect(await allowed(e, "type_text", { text: "hello" })).toBe(true);
    expect(await reason(e, "type_text", { text: "hello!" })).toContain("longer than 5");
    expect(await allowed(e, "type_text", { text: "😀😀😀😀😀" })).toBe(true); // counted in characters, not UTF-16 units
    const e2 = engine({ default: "allow", gui: { blockedText: ["\\b\\d{16}\\b", "PASSWORD"] } });
    expect(await reason(e2, "type_text", { text: "card 4111111111111111" })).toContain("blocked pattern");
    expect(await allowed(e2, "clipboard_paste", { text: "my password" })).toBe(false);
    expect(await allowed(e2, "clipboard_set", { text: "my password" })).toBe(false);
    expect(await allowed(e2, "type_text", { text: "fine" })).toBe(true);
  });
  it("input only goes to allowed windows (checked against the active window)", async () => {
    let title: string | undefined = "Calculator";
    const e = engine({ default: "allow", gui: { windows: ["^Calculator$"] } }, { activeWindowTitle: async () => title });
    expect(await allowed(e, "click", { x: 1, y: 1 })).toBe(true);
    expect(await allowed(e, "type_text", { text: "1+1" })).toBe(true);
    title = "Terminal";
    expect(await reason(e, "type_text", { text: "rm" })).toContain('active window "Terminal" is not in the allowed windows');
    title = undefined;
    expect(await reason(e, "click", { x: 1, y: 1 })).toContain("(unknown)");
    expect(await allowed(e, "screenshot", {})).toBe(true); // capture is not input
    const noProbe = engine({ default: "allow", gui: { windows: ["x"] } });
    expect(await allowed(noProbe, "click", { x: 1, y: 1 })).toBe(false);
  });
  it("assertWindow (used by window tools) and currentEngine scoping", async () => {
    const e = engine({ default: "allow", gui: { windows: ["^Notes"] } });
    expect(() => e.assertWindow("Notes - draft")).not.toThrow();
    expect(() => e.assertWindow("Bank")).toThrow(PermissionDenied);
    expect(() => engine({ default: "allow" }).assertWindow("anything")).not.toThrow();
    expect(currentEngine()).toBeUndefined();
    let seen: PermissionEngine | undefined;
    const probe = defineTool({ name: "get_env", description: "", shape: {}, run: () => ((seen = currentEngine()), "ok") });
    await e.wrap(probe).run({});
    expect(seen).toBe(e);
    expect(currentEngine()).toBeUndefined();
  });
});

describe("limits", () => {
  it("rate limit uses a sliding minute", async () => {
    let t = 1_000_000;
    const e = engine({ default: "allow", limits: { maxActionsPerMinute: 2 } }, { now: () => t });
    expect(await allowed(e, "get_env")).toBe(true);
    t += 10_000;
    expect(await allowed(e, "get_env")).toBe(true);
    expect(await reason(e, "get_env")).toContain("rate limit of 2 actions per minute");
    t += 50_001; // the first call has left the window
    expect(await allowed(e, "get_env")).toBe(true);
    expect(await allowed(e, "get_env")).toBe(false);
  });
  it("total budget, and denied calls do not consume it", async () => {
    const e = engine({ default: "allow", capabilities: { "fs.delete": "deny" }, limits: { maxTotalActions: 2 } });
    expect(await allowed(e, "delete_path", { path: "/x" })).toBe(false);
    expect(await allowed(e, "get_env")).toBe(true);
    expect(await allowed(e, "get_env")).toBe(true);
    expect(await reason(e, "get_env")).toContain("budget of 2 is used up");
  });
});

describe("asking", () => {
  const asks: AskRequest[] = [];
  const ask = (answer: boolean | undefined) => async (r: AskRequest) => (asks.push(r), answer);
  it("asks for ask-mode tools and honours the answer", async () => {
    asks.length = 0;
    const yes = engine({ default: "ask" }, { ask: ask(true) });
    expect((await yes.authorize("write_file", { path: "/tmp/a", content: "secret body" })).allowed).toBe(true);
    expect(asks[0]?.tool).toBe("write_file");
    expect(asks[0]?.args).toEqual({ path: "/tmp/a", content: "<11 chars>" }); // bodies are never shown
    expect(asks[0]?.summary).toContain('write_file(path="/tmp/a", content="<11 chars>")');
    const no = engine({ default: "ask" }, { ask: ask(false) });
    expect(await reason(no, "write_file", { path: "/tmp/a", content: "x" })).toBe("the user did not approve");
  });
  it("shortens very long values for display", async () => {
    asks.length = 0;
    const e = engine({ default: "ask" }, { ask: ask(true) });
    await e.authorize("run_command", { command: "x".repeat(300) });
    expect(asks[0]?.args.command).toBe("<300 chars>");
  });
  it("nobody to ask: falls back to askFallback", async () => {
    const none = engine({ default: "ask" });
    expect(await reason(none, "write_file", { path: "/tmp/a", content: "x" })).toContain("nobody could be asked");
    const lenient = engine({ default: "ask", askFallback: "allow" });
    expect(await allowed(lenient, "write_file", { path: "/tmp/a", content: "x" })).toBe(true);
    const undef = engine({ default: "ask" }, { ask: ask(undefined) });
    expect(await allowed(undef, "write_file", { path: "/tmp/a", content: "x" })).toBe(false);
  });
  it("never asks about something that would be denied anyway", async () => {
    asks.length = 0;
    const e = engine({ default: "ask", paths: { deny: ["/etc"] } }, { ask: ask(true) });
    expect(await allowed(e, "write_file", { path: "/etc/passwd", content: "x" })).toBe(false);
    expect(asks).toHaveLength(0);
  });
});

describe("audit log", () => {
  it("writes one JSON line per decision, without arguments by default", async () => {
    const f = path.join(tmpDir(), "audit.log");
    const e = engine({ name: "t", default: "deny", capabilities: { "fs.read": "allow" }, audit: { file: f } }, { now: () => Date.UTC(2026, 0, 2) });
    await e.authorize("read_file", { path: "/etc/hostname" });
    await e.authorize("write_file", { path: "/tmp/x", content: "TOPSECRET" });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ts: "2026-01-02T00:00:00.000Z", policy: "t", tool: "read_file", allowed: true, mode: "allow", asked: false, args: ["path"] });
    expect(lines[1]).toMatchObject({ tool: "write_file", allowed: false });
    expect(lines[1].reason).toContain("not permitted");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(readFileSync(f, "utf8")).not.toContain("TOPSECRET");
  });
  it("logArgs records values but still never typed text or file contents", async () => {
    const f = path.join(tmpDir(), "audit.log");
    const e = engine({ default: "allow", audit: { file: f, logArgs: true } });
    await e.authorize("type_text", { text: "hunter2" });
    await e.authorize("write_file", { path: "/tmp/p", content: "BODY" });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const text = readFileSync(f, "utf8");
    expect(text).toContain('"path":"/tmp/p"');
    expect(text).toContain("<7 chars>");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("BODY");
  });
  it("FAILS CLOSED when the audit log cannot be written", async () => {
    const dir = tmpDir();
    const e = engine({ default: "allow", audit: { file: path.join(dir, "no/such/dir/a.log") } });
    const d = await e.authorize("get_env", {});
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("audit log unavailable");
    const custom = engine({ default: "allow" }, { writeAudit: async () => { throw new Error("disk full"); } });
    expect(await reason(custom, "get_env")).toContain("disk full");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    chmodSync(dir, 0o755);
  });
});

describe("wrap and describe", () => {
  it("wrap throws PermissionDenied and passes allowed calls through", async () => {
    const e = engine({ default: "deny", capabilities: { "fs.read": "allow" } });
    const ok = await e.wrap(readFileTool).run({ path: "package.json", offset: 0, limit: 1 });
    expect(String(ok)).toContain("1\t");
    const blocked = e.wrap(defineTool({ name: "write_file", description: "", shape: { path: z.string() }, run: () => "should not run" }));
    await expect(blocked.run({ path: "x" })).rejects.toThrow(/^\[permission denied\] tool write_file is not permitted/);
    await expect(blocked.run(undefined)).rejects.toBeInstanceOf(PermissionDenied);
    const nameless = e.wrap({ ...readFileTool, name: "mystery" } as Tool);
    await expect(nameless.run({})).rejects.toThrow(/no permission metadata/);
    const noReason = new PermissionEngine(PolicySchema.parse({ default: "allow" }));
    noReason.authorize = async () => ({ allowed: false, mode: "deny", asked: false });
    await expect(noReason.wrap(readFileTool).run({})).rejects.toThrow(/not permitted/);
  });
  it("describe summarises what is allowed, asked, hidden and scoped", () => {
    const tools = [readFileTool, { ...readFileTool, name: "write_file" }, { ...readFileTool, name: "delete_path" }] as Tool[];
    const e = engine({
      name: "demo", default: "allow", capabilities: { "fs.write": "ask", "fs.delete": "deny" },
      paths: { allow: ["/work"], deny: ["~/.ssh"], readOnly: ["/work/ro"] }, commands: { allow: ["^git"], blockDangerous: true },
      network: { allowHosts: ["example.com"] }, gui: { regions: [{ x: 1, y: 2, width: 3, height: 4 }], windows: ["Calc"], blockedKeys: ["ctrl+alt+delete"] },
      limits: { maxActionsPerMinute: 5, maxTotalActions: 9 },
    });
    const text = e.describe(tools.slice(0, 2));
    for (const s of ["Permission policy: demo", "Allowed: read_file", "Needs user approval: write_file", "Not available:", "delete_path", "Files limited to: /work", "Files never touched: ~/.ssh", "Read-only files: /work/ro", "Shell limited to commands matching: ^git", "Dangerous shell commands are refused.", "Web limited to hosts: example.com", "Screen limited to regions: 3x4+1+2", "Input limited to windows titled: Calc", "Blocked hotkeys: ctrl+alt+delete", "Rate limit: 5 actions/minute", "Action budget: 9"]) {
      expect(text, s).toContain(s);
    }
    expect(engine({ default: "allow" }).describe([readFileTool])).toBe("Permission policy: custom\nAllowed: read_file");
  });
});
