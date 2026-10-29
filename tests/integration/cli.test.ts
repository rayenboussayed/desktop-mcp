import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentOptions } from "../../src/agent.js";
import { main, show, type CliIo } from "../../src/cli.js";

const BIN = path.resolve("dist/bin/osagent.js");

/**
 *
 * @param inputs - Queued line inputs.
 * @param run - Command runner used by the reader.
 * @returns The fake readline interface.
 */
function io(inputs: (string | null)[] = [], run = async (t: string): Promise<string> => `answer:${t}`) {
  const out: string[] = [];
  const asked: string[] = [];
  const created: AgentOptions[] = [];
  const tasks: string[] = [];
  const queue = [...inputs];
  const deps: CliIo = {
    out: (s) => out.push(s),
    prompt: async (q) => (asked.push(q), queue.length ? (queue.shift() as string | null) : null),
    createAgent: (o) => (created.push(o), { run: async (t) => (tasks.push(t), run(t)) }),
  };
  return { deps, out, asked, created, tasks };
}

describe("cli (injected I/O)", () => {
  it("runs a one-shot task", async () => {
    const t = io();
    expect(await main(["list", "my", "files"], t.deps)).toBe(0);
    expect(t.tasks).toEqual(["list my files"]);
    expect(t.out.join("\n")).toContain("answer:list my files");
  });

  it("passes flags to the agent", async () => {
    const t = io();
    await main(["--gui", "--no-search", "--confirm-all", "--max-steps", "7", "--model", "m1", "go"], t.deps);
    expect(t.created[0]).toMatchObject({ gui: true, search: false, confirmAll: true, maxSteps: 7, model: "m1" });
  });

  it("defaults", async () => {
    const t = io();
    await main(["go"], t.deps);
    expect(t.created[0]).toMatchObject({ gui: false, search: true, confirmAll: false, maxSteps: 40, model: "claude-sonnet-5-5" });
  });

  it("interactive mode loops until EOF and skips blank lines", async () => {
    const t = io(["first", "   ", "second", null]);
    expect(await main([], t.deps)).toBe(0);
    expect(t.tasks).toEqual(["first", "second"]);
    expect(t.out.join("\n")).toContain("interactive mode");
  });

  it("approval prompt accepts only y/yes", async () => {
    const answers = ["y", "YES", "n", "", null];
    const t = io(answers);
    await main(["x"], t.deps);
    const confirm = t.created[0]?.confirm as (n: string, a: Record<string, unknown>) => Promise<boolean>;
    const got: boolean[] = [];
    for (let i = 0; i < 5; i++) got.push(await confirm("run_command", { command: "sudo x" }));
    expect(got).toEqual([true, true, false, false, false]);
    expect(t.out.join("\n")).toContain("[approval needed] run_command");
  });

  it("--info and --help exit before creating an agent", async () => {
    const t = io();
    expect(await main(["--info"], t.deps)).toBe(0);
    expect(t.out[0]).toContain("OS:");
    expect(await main(["-h"], t.deps)).toBe(0);
    expect(t.out.join("\n")).toContain("Usage: osagent");
    expect(t.created).toHaveLength(0);
  });

  it("rejects bad arguments", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--bogus"], io().deps)).toBe(2);
    expect(await main(["--max-steps", "0", "x"], io().deps)).toBe(2);
    expect(await main(["--max-steps", "abc", "x"], io().deps)).toBe(2);
    expect(err).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });

  it("show() renders events", () => {
    const lines: string[] = [];
    const out = (s: string): void => void lines.push(s);
    show("text", "hello", out);
    show("tool_call", ["think", { thought: "plan" }], out);
    show("tool_call", ["run_command", { command: "ls" }], out);
    show("tool_call", ["click", { x: 1 }], out);
    show("tool_result", ["run_command", "line1\nline2"], out);
    show("tool_result", ["think", "ok"], out);
    show("tool_result", ["screenshot", [{ type: "text", text: "x" }]], out);
    show("other", 1, out);
    expect(lines).toEqual(["\nhello", "\n> think: plan", "\n> run_command: ls", '\n> click: {"x":1}', "  line1\n  line2"]);
  });
});

describe("cli (real process, compiled output)", () => {
  const run = (args: string[], input?: string) => spawnSync("node", [BIN, ...args], { encoding: "utf8", input, env: { ...process.env, ANTHROPIC_API_KEY: "x" } });

  it("--info prints the platform", () => {
    const r = run(["--info"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OS: ");
  });
  it("--help works and bad flags exit 2", () => {
    expect(run(["--help"]).stdout).toContain("Usage: osagent");
    expect(run(["--nope"]).status).toBe(2);
  });
  it("interactive mode exits cleanly on EOF with piped stdin", () => {
    const r = run([], "");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("interactive mode");
  });
});
