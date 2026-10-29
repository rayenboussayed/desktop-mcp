import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/tools/shell.js";
import { makeBin, tmpDir, withPlatform, isPosix, sleep } from "./helpers.js";
import { withEnv } from "./helpers.js";
import { execFileSync } from "node:child_process";

const NODE = `"${process.execPath}"`;

describe("run_command (real subprocesses)", () => {
  it("runs a real command", async () => {
    const out = await runCommand("echo hello-osagent");
    expect(out).toContain("exit_code: 0");
    expect(out).toContain("hello-osagent");
  });

  it("reports failure and stderr", async () => {
    const out = await runCommand(`${NODE} -e "process.stderr.write('boom'); process.exit(3)"`);
    expect(out).toContain("exit_code: 3");
    expect(out).toContain("boom");
  });

  it("times out and returns partial output", async () => {
    const t0 = Date.now();
    const out = await runCommand(`echo partial-out; ${NODE} -e "setTimeout(()=>{}, 20000)"`, 1);
    expect(out).toContain("[timeout after 1s]");
    expect(out).toContain("partial-out");
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it.skipIf(!isPosix)("kills the whole process tree on timeout", async () => {
    const d = tmpDir();
    const marker = path.join(d, "alive");
    // a grandchild that would write the marker after 2.5s if it survived
    await runCommand(`(sleep 2.5; touch ${marker}) & wait`, 1);
    await sleep(3200);
    expect(() => execFileSync("test", ["-e", marker])).toThrow();
  });

  it("honours cwd and reports a bad cwd", async () => {
    const d = tmpDir();
    expect(await runCommand(`${NODE} -e "console.log(process.cwd())"`, 30, d)).toContain(path.basename(d));
    expect(await runCommand("echo hi", 30, "/definitely/not/here")).toContain("[error]");
  });

  it.skipIf(!isPosix)("reports death by signal like a negative code", async () => {
    expect(await runCommand("kill -9 $$")).toContain("exit_code: -9");
  });

  it("does not let children read the parent's stdin", async () => {
    // an inherited stdin would hang/steal the MCP protocol stream; ours is closed
    const out = await runCommand(`${NODE} -e "process.stdin.on('data',()=>{}).on('end',()=>console.log('eof'))"`, 10);
    expect(out).toContain("eof");
  });

  it.skipIf(!isPosix)("uses PowerShell on windows", async () => {
    const bin = tmpDir();
    makeBin(bin, "powershell", 'echo "ARGS: $*"; pwd');
    const out = await withPlatform("win32", () => withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => runCommand("Get-Date", 10, "~")));
    expect(out).toContain("ARGS: -NoProfile -NonInteractive -Command Get-Date");
    expect(out).toContain("exit_code: 0");
  });

  it("surfaces a missing powershell as a tool error", async () => {
    const out = await withPlatform("win32", () => withEnv({ PATH: tmpDir() }, () => runCommand("x")));
    expect(out).toContain("[error]");
  });

  it("reports an internal failure while building the process call as a tool error", async () => {
    expect(await runCommand("echo hi", 10, 5 as never)).toContain("[error]"); // cwd is not a string
  });
});
