import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { currentOs, defaultShell, describePlatform, expandUser, which } from "../src/platform.js";
import { buildToolset } from "../src/tools/index.js";
import { callTool, defineTool, toApi, truncate } from "../src/tools/base.js";
import { listDir, readFile, splitLines, writeFile } from "../src/tools/files.js";
import { makeBin, tmpDir, withEnv, withPlatform } from "./helpers.js";
import os from "node:os";

describe("platform", () => {
  it("detects the real OS", () => {
    expect(["windows", "linux", "macos"]).toContain(currentOs());
    expect(describePlatform()).toContain(currentOs());
    expect(describePlatform()).toContain(`Node: ${process.version}`);
  });

  it.each([["win32", "windows"], ["darwin", "macos"], ["linux", "linux"], ["freebsd", "linux"], ["cygwin", "linux"]] as const)(
    "maps %s -> %s", (p, expected) => {
      expect(withPlatform(p as NodeJS.Platform, currentOs)).toBe(expected);
    });

  it("default shell variants", () => {
    const bin = tmpDir();
    makeBin(bin, "powershell", "true");
    expect(withPlatform("win32", () => withEnv({ PATH: bin }, defaultShell))).toBe("powershell");
    expect(withPlatform("win32", () => withEnv({ PATH: tmpDir() }, defaultShell))).toBe("cmd");
    expect(withEnv({ SHELL: "/bin/zsh" }, defaultShell)).toBe("/bin/zsh");
    expect(withEnv({ SHELL: undefined }, defaultShell)).toBe("/bin/sh");
  });

  it("which finds executables only", () => {
    const bin = tmpDir();
    makeBin(bin, "mytool", "true");
    writeFileSync(path.join(bin, "notexec"), "x");
    chmodSync(path.join(bin, "notexec"), 0o644);
    mkdirSync(path.join(bin, "adir"));
    withEnv({ PATH: bin }, () => {
      expect(which("mytool")).toBe(path.join(bin, "mytool"));
      expect(which("notexec")).toBeUndefined();
      expect(which("adir")).toBeUndefined();
      expect(which("missing")).toBeUndefined();
    });
    expect(withEnv({ PATH: undefined }, () => which("x"))).toBeUndefined();
  });

  it("which honours PATHEXT on windows", () => {
    const bin = tmpDir();
    writeFileSync(path.join(bin, "tool.EXE"), "x");
    withPlatform("win32", () =>
      withEnv({ PATH: bin, PATHEXT: ".EXE;.CMD" }, () => expect(which("tool")).toBe(path.join(bin, "tool.EXE"))));
    withPlatform("win32", () => withEnv({ PATH: bin, PATHEXT: undefined }, () => expect(which("tool")).toBe(path.join(bin, "tool.EXE"))));
  });

  it("expands ~", () => {
    expect(expandUser("~")).toBe(os.homedir());
    expect(expandUser("~/x")).toBe(os.homedir() + "/x");
    expect(expandUser("~\\x")).toBe("~\\x"); // POSIX: literal
    expect(withPlatform("win32", () => expandUser("~\\x"))).toBe(os.homedir() + "\\x");
    expect(expandUser("/abs")).toBe("/abs");
  });
});

describe("tool base", () => {
  it("truncates keeping head and tail", () => {
    expect(truncate("short")).toBe("short");
    const out = truncate("a".repeat(100) + "b".repeat(100), 50);
    expect(out).toContain("truncated 150 chars");
    expect(out.startsWith("a") && out.endsWith("b")).toBe(true);
  });

  it("derives the Anthropic tool schema from the zod shape", () => {
    const t = defineTool({
      name: "demo", description: "d",
      shape: { a: z.string(), n: z.number().int().default(3), o: z.string().optional() },
      run: ({ a, n }) => `${a}${n}`,
    });
    const api = toApi(t);
    expect(api.name).toBe("demo");
    expect(api.input_schema.type).toBe("object");
    expect(api.input_schema.required).toEqual(["a"]); // defaulted + optional fields are not required
    expect(JSON.stringify(api)).not.toContain("9007199254740991");
    expect(api.input_schema).not.toHaveProperty("$schema");
  });

  it("callTool validates and applies defaults", async () => {
    const t = defineTool({ name: "d", description: "", shape: { a: z.string(), n: z.number().default(7) }, run: ({ a, n }) => `${a}:${n}` });
    expect(await callTool(t, { a: "x" })).toBe("x:7");
    await expect(callTool(t, { a: 1 })).rejects.toThrow();
    const none = defineTool({ name: "n", description: "", shape: {}, run: () => "ok" });
    expect(await callTool(none, undefined)).toBe("ok");
  });

  it("builds the agent toolset", async () => {
    const base = [...(await buildToolset(false, false)).keys()];
    expect(base).toEqual(["think", "run_command", "read_file", "write_file", "list_dir"]);
    expect([...(await buildToolset()).keys()]).toEqual([...base, "web_search", "fetch_url"]);
    const gui = await buildToolset(true, true);
    const names = [...gui.keys()];
    expect(names.slice(0, base.length + 2)).toEqual([...base, "web_search", "fetch_url"]);
    for (const t of ["screenshot", "click", "type_text", "window_list", "screen_find_text", "screen_find_image", "clipboard_paste", "plugin_status", "list_keys"]) expect(names).toContain(t);
    expect(names).not.toContain("delete_path"); // the agent keeps its small core set; the MCP server exposes the rest
    expect([...gui.values()].filter((t) => ["click", "type_text", "press_key", "run_command", "write_file"].includes(t.name)).every((t) => t.risky)).toBe(true);
  });
});

describe("file tools", () => {
  it("round-trips a file", async () => {
    const p = path.join(tmpDir(), "sub", "a.txt");
    expect(await writeFile(p, "one\ntwo\nthree\n")).toContain("wrote 14 chars");
    expect(await readFile(p)).toContain("2\ttwo");
    const listing = await listDir(path.dirname(p));
    expect(listing).toContain("a.txt");
    expect(listing).toContain("file\t14\ta.txt");
  });

  it("counts characters, not UTF-16 units", async () => {
    expect(await writeFile(path.join(tmpDir(), "e.txt"), "héllo 😀")).toContain("wrote 7 chars");
  });

  it("pages and reports errors", async () => {
    const d = tmpDir();
    const p = path.join(d, "big.txt");
    await writeFile(p, Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"));
    const out = await readFile(p, 2, 3);
    expect(out).toContain("3\tline2");
    expect(out).toContain("5\tline4");
    expect(out).not.toContain("line5");
    expect(out).toContain("[5 more lines]");
    expect(await readFile(path.join(d, "nope"))).toContain("[error] not a file");
    expect(await listDir(path.join(d, "nope"))).toContain("[error] not a directory");
    expect(await listDir(d)).toContain("big.txt");
    mkdirSync(path.join(d, "empty"));
    expect(await listDir(path.join(d, "empty"))).toBe("[empty]");
    expect(await listDir(d)).toContain("dir \t\tempty");
  });

  it("splits lines like Python", () => {
    expect(splitLines("a\r\nb\rc\n")).toEqual(["a", "b", "c"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("x")).toEqual(["x"]);
  });
});
