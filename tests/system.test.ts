import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as sys from "../src/tools/system.js";
import { hasBinary, isPosix, makeBin, sleep, startXvfb, tmpDir, withEnv, withPlatform, type Xvfb } from "./helpers.js";

describe("system_info / env", () => {
  it("summarises the machine", async () => {
    const out = await sys.systemInfo();
    for (const s of ["OS:", "CPU cores:", "CPU load:", "Memory:", "Disk (home):", "Uptime:"]) expect(out).toContain(s);
  });
  it("reads env vars", () => {
    expect(withEnv({ OSAGENT_X: "42" }, () => sys.getEnv("OSAGENT_X"))).toBe("42");
    expect(sys.getEnv("OSAGENT_NOT_SET_EVER")).toBe("[not set]");
    expect(sys.getEnv().split("\n")).toContain("PATH");
  });
});

describe.skipIf(!isPosix)("processes (real)", () => {
  it("lists this very process and filters by name", async () => {
    const all = await sys.listProcesses();
    expect(all.startsWith("pid\tname\tmemory\tuser")).toBe(true);
    expect(all).toContain(`\n${process.pid}\t`);
    // the runtime's process name differs between node, test runners and embedding hosts: use our own row
    const row = all.split("\n").find((line) => line.startsWith(`${process.pid}\t`)) as string;
    const name = row.split("\t")[1] as string;
    expect(name.length).toBeGreaterThan(0);
    const filtered = await sys.listProcesses(name.toUpperCase(), 5);
    expect(filtered.split("\n").length).toBeLessThanOrEqual(6);
    expect(filtered).toContain(name);
    expect(await sys.listProcesses("zzz-no-such-process")).toBe("pid\tname\tmemory\tuser\n");
  });

  it("terminates and force-kills real children", async () => {
    const a = spawn("sleep", ["60"]);
    const out = await sys.killProcess(a.pid as number);
    expect(out).toMatch(/^terminated \d+ \(sleep\)$/);
    await sleep(100);
    expect(a.exitCode !== null || a.signalCode !== null).toBe(true);

    const b = spawn("sleep", ["60"]);
    expect(await sys.killProcess(b.pid as number, true)).toMatch(/^killed \d+ \(sleep\)$/);
  });

  it("reports a stubborn process and succeeds when forced", async () => {
    const stubborn = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
    await sleep(300);
    const soft = await sys.killProcess(stubborn.pid as number);
    expect(soft).toContain("still running; retry with force=true");
    expect(await sys.killProcess(stubborn.pid as number, true)).toContain("killed");
  }, 20_000);

  it("handles zombies, missing pids and the server itself", async () => {
    // a child we never reap is a zombie after it dies: still counts as gone
    const child = spawn("sleep", ["60"], { detached: true });
    child.unref();
    const msg = await sys.killProcess(child.pid as number, true);
    expect(msg).toMatch(/^killed/);
    expect(await sys.killProcess(2 ** 22 - 3)).toMatch(/^\[error\] no such process/);
    expect(await sys.killProcess(process.pid)).toBe("[refused] will not kill the MCP server itself");
  });

  it("reports access denied for pid 1 when not root", async () => {
    if (process.getuid?.() === 0) return;
    expect(await sys.killProcess(1)).toBe("[error] access denied for pid 1");
  });
});

describe("clipboard", () => {
  let x: Xvfb | undefined;
  beforeAll(async () => { x = await startXvfb(); });
  afterAll(() => x?.stop());

  it.skipIf(!hasBinary("xclip") || !hasBinary("Xvfb"))("round-trips through a real X clipboard", async () => {
    await withEnv({ DISPLAY: x?.display, WAYLAND_DISPLAY: undefined }, async () => {
      expect(await sys.clipboardSet("héllo clipboard 😀")).toBe("copied 17 chars");
      expect(await sys.clipboardGet()).toBe("héllo clipboard 😀");
    });
  });

  it("explains when there is no tool", async () => {
    await withEnv({ PATH: tmpDir() }, async () => {
      expect(await sys.clipboardGet()).toContain("no clipboard tool found");
      expect(await sys.clipboardSet("x")).toContain("no clipboard tool found");
    });
  });

  it.skipIf(!isPosix)("surfaces tool failures (fake xclip that fails / that cannot start)", async () => {
    const bin = tmpDir();
    makeBin(bin, "xclip", 'echo "no display" >&2; exit 1');
    await withEnv({ PATH: bin }, async () => {
      expect(await sys.clipboardGet()).toBe("[error] no display");
      expect(await sys.clipboardSet("x")).toBe("[error] no display");
    });
    // isolated PATH: execvp keeps searching PATH when a shebang interpreter is missing, which would reach the real xclip
    const bad = tmpDir();
    writeFileSync(path.join(bad, "xclip"), "#!/nonexistent/interp\n");
    chmodSync(path.join(bad, "xclip"), 0o755);
    await withEnv({ PATH: bad }, async () => {
      expect(await sys.clipboardGet()).toContain("[error]");
      expect(await sys.clipboardSet("x")).toContain("[error]");
    });
  });

  it.skipIf(!isPosix)("picks the right tool per OS and the preferred Linux tool", async () => {
    const bin = tmpDir();
    makeBin(bin, "pbpaste", "printf mac-text");
    makeBin(bin, "wl-paste", "printf wayland-text");
    // isolated PATH: a real xclip in /usr/bin must not shadow the fakes
    expect(await withPlatform("darwin", () => withEnv({ PATH: bin }, () => sys.clipboardGet()))).toBe("mac-text");
    expect(await withPlatform("linux", () => withEnv({ PATH: bin }, () => sys.clipboardGet()))).toBe("wayland-text");
    const xsel = tmpDir();
    makeBin(xsel, "xsel", "printf xsel-text");
    expect(await withEnv({ PATH: xsel }, () => sys.clipboardGet())).toBe("xsel-text");
  });

  it.skipIf(!isPosix)("uses PowerShell/clip on windows", async () => {
    const bin = tmpDir();
    makeBin(bin, "powershell", "printf ps-text");
    expect(await withPlatform("win32", () => withEnv({ PATH: `${bin}:/usr/bin:/bin` }, () => sys.clipboardGet()))).toBe("ps-text");
  });
});

describe.skipIf(!isPosix)("open_path", () => {
  it("launches the OS opener without waiting for it", async () => {
    const bin = tmpDir();
    const log = path.join(tmpDir(), "opened");
    makeBin(bin, "xdg-open", `echo "$@" > ${log}`);
    makeBin(bin, "open", `echo "mac $@" > ${log}`);
    expect(await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, () => sys.openPath("https://example.com"))).toBe("opened https://example.com");
    await sleep(300);
    expect(readFileSync(log, "utf8").trim()).toBe("https://example.com");
    await withPlatform("darwin", () => withEnv({ PATH: `${bin}:/usr/bin:/bin` }, () => sys.openPath("/tmp")));
    await sleep(300);
    expect(readFileSync(log, "utf8").trim()).toBe("mac /tmp");
  });
  it("reports a missing opener", async () => {
    expect(await withEnv({ PATH: tmpDir() }, () => sys.openPath("x"))).toMatch(/^\[error\]/);
  });
  it("uses cmd start on windows", async () => {
    const bin = tmpDir();
    const log = path.join(tmpDir(), "w");
    makeBin(bin, "cmd", `printf '%s\\n' "$*" > ${log}`);
    await withPlatform("win32", () => withEnv({ PATH: `${bin}:/usr/bin:/bin` }, () => sys.openPath("C:\\f.txt")));
    await sleep(300);
    expect(readFileSync(log, "utf8").trim()).toBe("/c start  C:\\f.txt");
  });
});

describe("glob matching", () => {
  it.each([
    ["*.py", "a.py", true], ["*.py", "a.pyc", false], ["a?c", "abc", true], ["a?c", "ac", false],
    ["[ab]x", "bx", true], ["[!ab]x", "bx", false], ["[!ab]x", "cx", true], ["[]]x", "]x", true],
    ["[unclosed", "[unclosed", true], ["a.b", "axb", false], ["*", "anything", true], ["(x)+", "(x)+", true],
    ["[a\\]", "\\", true],
  ])("%s vs %s -> %s", (pat, name, expected) => {
    expect(sys.globToRegExp(pat).test(name)).toBe(expected);
  });
});

describe("file management", () => {
  /**
   *
   * @returns A snapshot of the directory tree.
   */
  function tree(): string {
    const d = tmpDir();
    mkdirSync(path.join(d, "src/deep"), { recursive: true });
    mkdirSync(path.join(d, "node_modules/x"), { recursive: true });
    mkdirSync(path.join(d, ".git"), { recursive: true });
    writeFileSync(path.join(d, "a.txt"), "alpha needle\nbeta\n");
    writeFileSync(path.join(d, "B.TXT"), "needle again");
    writeFileSync(path.join(d, "src/deep/c.py"), "print('needle')\r\nline2");
    writeFileSync(path.join(d, "node_modules/x/skip.txt"), "needle");
    writeFileSync(path.join(d, ".git/skip.txt"), "needle");
    writeFileSync(path.join(d, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    return d;
  }

  it("find_files is recursive, case-insensitive and skips junk dirs", async () => {
    const d = tree();
    const out = (await sys.findFiles("*.txt", d)).split("\n").map((p) => path.relative(d, p));
    expect(out).toEqual(["B.TXT", "a.txt"]);
    expect(await sys.findFiles("*.py", d)).toBe(path.join(d, "src/deep/c.py"));
    expect(await sys.findFiles("*.nothing", d)).toBe("[no matches]");
    expect(await sys.findFiles("*", d, 2)).toContain("[stopped at 2 results]");
    expect(await sys.findFiles("*", path.join(d, "missing"))).toBe("[no matches]");
  });

  it("find_files does not follow directory symlinks but lists file symlinks", async () => {
    const d = tree();
    symlinkSync(path.join(d, "src"), path.join(d, "linkdir"));
    symlinkSync(path.join(d, "a.txt"), path.join(d, "linkfile.txt"));
    symlinkSync(path.join(d, "nowhere"), path.join(d, "dangling"));
    const out = await sys.findFiles("*", d);
    expect(out).not.toContain("linkdir/deep");
    expect(out).toContain("linkfile.txt");
    expect(out).toContain("dangling");
  });

  it("search_in_files finds literals with line numbers, honours glob and limits", async () => {
    const d = tree();
    const all = await sys.searchInFiles("needle", d);
    expect(all).toContain(`${path.join(d, "a.txt")}:1: alpha needle`);
    expect(all).toContain(`${path.join(d, "src/deep/c.py")}:1: print('needle')`);
    expect(all).not.toContain("skip.txt");
    expect(all).not.toContain("bin.dat"); // not valid UTF-8: skipped
    expect(await sys.searchInFiles("needle", d, "*.py")).toBe(`${path.join(d, "src/deep/c.py")}:1: print('needle')`);
    expect(await sys.searchInFiles("zzz", d)).toBe("[no matches]");
    expect(await sys.searchInFiles("needle", d, "*", 1)).toContain("[stopped at 1 results]");
  });

  it("make_dir, copy_path, move_path", async () => {
    const d = tmpDir();
    expect(await sys.makeDir(path.join(d, "x/y"))).toBe(`created ${path.join(d, "x/y")}`);
    writeFileSync(path.join(d, "f.txt"), "data");
    await sys.copyPath(path.join(d, "f.txt"), path.join(d, "new/dir/f2.txt"));
    expect(readFileSync(path.join(d, "new/dir/f2.txt"), "utf8")).toBe("data");
    await sys.copyPath(path.join(d, "new"), path.join(d, "newcopy"));
    expect(existsSync(path.join(d, "newcopy/dir/f2.txt"))).toBe(true);
    await sys.copyPath(path.join(d, "new"), path.join(d, "newcopy")); // merging into an existing dir is allowed
    await sys.movePath(path.join(d, "f.txt"), path.join(d, "moved.txt"));
    expect(existsSync(path.join(d, "f.txt"))).toBe(false);
    expect(readFileSync(path.join(d, "moved.txt"), "utf8")).toBe("data");
    await expect(sys.movePath(path.join(d, "nope"), path.join(d, "z"))).rejects.toThrow();
  });

  it("move_path falls back to copy+delete across filesystems", async () => {
    // /dev/shm is a different filesystem from the temp dir on most Linux hosts
    if (!existsSync("/dev/shm")) return;
    const src = path.join(tmpDir(), "s.txt");
    writeFileSync(src, "x-device");
    const dst = path.join("/dev/shm", `osagent-${process.pid}.txt`);
    try {
      await sys.movePath(src, dst);
      expect(readFileSync(dst, "utf8")).toBe("x-device");
      expect(existsSync(src)).toBe(false);
    } finally {
      await sys.deletePath(dst);
    }
  });

  it("delete_path guards roots, home, and directories", async () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "dir/sub"), { recursive: true });
    writeFileSync(path.join(d, "dir/sub/f"), "x");
    writeFileSync(path.join(d, "file"), "x");
    expect(await sys.deletePath("/", true)).toBe("[refused] will not delete /");
    expect(await sys.deletePath("~", true)).toBe(`[refused] will not delete ${os.homedir()}`);
    expect(await sys.deletePath(path.join(d, "dir"))).toBe("[error] it is a directory; pass recursive=true");
    expect(await sys.deletePath(path.join(d, "dir"), true)).toBe(`deleted ${path.join(d, "dir")}`);
    expect(existsSync(path.join(d, "dir"))).toBe(false);
    expect(await sys.deletePath(path.join(d, "file"))).toContain("deleted");
    expect(await sys.deletePath(path.join(d, "file"))).toContain("[error] not found");
    symlinkSync(d, path.join(tmpDir(), "ln")); // a symlink to a dir is removed as a link, not recursed
    const target = tmpDir();
    writeFileSync(path.join(target, "keep"), "k");
    const link = path.join(tmpDir(), "link");
    symlinkSync(target, link);
    expect(await sys.deletePath(link)).toContain("deleted");
    expect(existsSync(path.join(target, "keep"))).toBe(true);
  });

  it("edit_file replaces exact text", async () => {
    const d = tmpDir();
    const f = path.join(d, "e.txt");
    writeFileSync(f, "one two one\r\n$& stays");
    expect(await sys.editFile(f, "two", "2")).toContain("replaced 1 occurrence(s)");
    expect(readFileSync(f, "utf8")).toBe("one 2 one\r\n$& stays"); // CRLF preserved
    expect(await sys.editFile(f, "one", "1")).toContain("appears 2 times");
    expect(await sys.editFile(f, "one", "1", true)).toContain("replaced 2 occurrence(s)");
    expect(await sys.editFile(f, "stays", "$& $1")).toContain("replaced 1"); // no regexp replacement patterns
    expect(readFileSync(f, "utf8")).toBe("1 2 1\r\n$& $& $1");
    expect(await sys.editFile(f, "absent", "x")).toBe("[error] text to replace was not found");
    expect(await sys.editFile(f, "", "x")).toBe("[error] text to replace must not be empty");
    expect(await sys.editFile(path.join(d, "none"), "a", "b")).toContain("[error] not a file");
  });
});
