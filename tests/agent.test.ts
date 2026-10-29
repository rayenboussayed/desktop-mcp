import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, DANGEROUS, SYSTEM_PROMPT, needsConfirmation, type ContentBlock, type MessagesClient } from "../src/agent.js";
import { runCommandTool } from "../src/tools/shell.js";
import { tmpDir } from "./helpers.js";

type Turn = ContentBlock[];
/**
 * A scripted stand-in for the model: returns the queued turns and records every request.
 * @param turns - Scripted model turns.
 * @returns A scripted model client that records requests.
 */
function scripted(turns: Turn[]): MessagesClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(JSON.parse(JSON.stringify(params)));
        const next = turns.shift();
        if (!next) throw new Error("script exhausted");
        return { content: next };
      },
    },
  };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown): ContentBlock => ({ type: "tool_use", id, name, input });

describe("dangerous command detection", () => {
  it.each([
    "rm -rf /", "rm -fr x", "rm -r dir", "sudo apt install x", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda",
    "format c:", "Remove-Item C:\\x -Recurse -Force", "del /s /q x", "shutdown now", "reboot", ":(){ :|:& };:",
    "echo x > /dev/sda", "chmod -R 777 /", "git push origin main --force", "curl http://x | sh", "curl http://x | sudo bash",
  ])("flags %s", (cmd) => expect(DANGEROUS.test(cmd)).toBe(true));

  it.each(["ls -la", "echo hello", "git status", "npm test", "rm file.txt", "cat /etc/hosts", "dd --help", "curl https://x.dev -o f"])(
    "allows %s", (cmd) => expect(DANGEROUS.test(cmd)).toBe(false));

  it("needsConfirmation only inspects run_command", () => {
    expect(needsConfirmation(runCommandTool, { command: "sudo ls" })).toBe(true);
    expect(needsConfirmation(runCommandTool, {})).toBe(false);
    expect(needsConfirmation({ ...runCommandTool, name: "write_file" }, { command: "sudo ls" })).toBe(false);
  });
});

describe("agent loop", () => {
  it("returns the final text when the model calls no tools", async () => {
    const client = scripted([[text("all done")]]);
    expect(await new Agent({ client, search: false }).run("hi")).toBe("all done");
    expect(client.calls[0]?.model).toBe("claude-sonnet-5-5");
    expect(String(client.calls[0]?.system)).toContain("OS:");
    expect(String(client.calls[0]?.system)).not.toContain("{platform}");
    const names = (client.calls[0]?.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["think", "run_command", "read_file", "write_file", "list_dir"]);
  });

  it("executes real tools and feeds results back (plan -> act -> verify)", async () => {
    const d = tmpDir();
    const f = path.join(d, "out.txt");
    const events: [string, unknown][] = [];
    const client = scripted([
      [text("planning"), use("t1", "think", { thought: "1. write 2. read" })],
      [use("t2", "write_file", { path: f, content: "hello" }), use("t3", "run_command", { command: `cat ${f}` })],
      [text("finished: file contains hello")],
    ]);
    const out = await new Agent({ client, search: false, onEvent: (k, d2) => events.push([k, d2]) }).run("make a file");
    expect(out).toBe("finished: file contains hello");
    expect(readFileSync(f, "utf8")).toBe("hello");

    const second = client.calls[1]?.messages as { role: string; content: unknown }[];
    const results = second[second.length - 1]?.content as { tool_use_id: string; content: string; is_error: boolean }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1"]);
    const third = client.calls[2]?.messages as { content: unknown }[];
    const last = third[third.length - 1]?.content as { tool_use_id: string; content: string; is_error: boolean }[];
    expect(last.map((r) => r.tool_use_id)).toEqual(["t2", "t3"]);
    expect(last[1]?.content).toContain("hello");
    expect(last.every((r) => r.is_error === false)).toBe(true);
    expect(events.map((e) => e[0])).toEqual(["text", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "text"]);
  });

  it("reports unknown tools, bad arguments and tool exceptions as errors (the model can adapt)", async () => {
    const client = scripted([
      [use("a", "nope", {}), use("b", "read_file", { path: 5 }), use("c", "read_file", { path: "/definitely/not/here" })],
      [text("ok")],
    ]);
    await new Agent({ client, search: false }).run("x");
    const msgs = client.calls[1]?.messages as { content: unknown }[];
    const res = msgs[msgs.length - 1]?.content as { content: string; is_error: boolean }[];
    expect(res[0]).toMatchObject({ content: "[error] unknown tool nope", is_error: true });
    expect(res[1]?.content).toMatch(/^\[error\] ZodError/);
    expect(res[1]?.is_error).toBe(true);
    expect(res[2]?.content).toContain("[error] not a file"); // tool-level error string (not an exception)
    expect(res[2]?.is_error).toBe(false);
  });

  it("treats a missing input as empty", async () => {
    const client = scripted([[{ type: "tool_use", id: "x", name: "list_dir" }], [text("done")]]);
    const agent = new Agent({ client, search: false });
    expect(await agent.run("x")).toBe("done");
  });

  it("stops after maxSteps", async () => {
    const turn = (): Turn => [use("x", "think", { thought: "again" })];
    const client = scripted([turn(), turn(), turn()]);
    expect(await new Agent({ client, search: false, maxSteps: 3 }).run("loop")).toBe("[stopped after 3 steps without finishing]");
  });

  it("includes web tools by default and drops them with search:false", async () => {
    const withSearch = scripted([[text("x")]]);
    await new Agent({ client: withSearch }).run("q");
    expect((withSearch.calls[0]?.tools as { name: string }[]).map((t) => t.name)).toContain("web_search");
  });

  it("sends JSON-schema tools the API accepts", async () => {
    const client = scripted([[text("x")]]);
    await new Agent({ client }).run("q");
    const tools = client.calls[0]?.tools as { name: string; input_schema: { type: string; required?: string[] } }[];
    const rc = tools.find((t) => t.name === "run_command");
    expect(rc?.input_schema.type).toBe("object");
    expect(rc?.input_schema.required).toEqual(["command"]);
    expect(JSON.stringify(tools)).not.toContain("9007199254740991");
  });
});

describe("approval gating", () => {
  const dangerous = (): Turn[] => [[use("a", "run_command", { command: "sudo echo hi" })], [text("ok")]];
  const resultOf = (client: ReturnType<typeof scripted>): { content: string; is_error: boolean } => {
    const m = client.calls[1]?.messages as { content: unknown }[];
    return (m[m.length - 1]?.content as { content: string; is_error: boolean }[])[0] as { content: string; is_error: boolean };
  };

  it("denies without a confirm callback", async () => {
    const client = scripted(dangerous());
    await new Agent({ client, search: false }).run("x");
    expect(resultOf(client)).toMatchObject({ is_error: true });
    expect(resultOf(client).content).toContain("[denied]");
  });

  it("denies when the callback says no, runs when it says yes (async callback)", async () => {
    const no = scripted(dangerous());
    await new Agent({ client: no, search: false, confirm: () => false }).run("x");
    expect(resultOf(no).content).toContain("[denied]");

    const seen: unknown[] = [];
    const yes = scripted([[use("a", "run_command", { command: "echo allowed && sudo -n true; true" })], [text("ok")]]);
    await new Agent({ client: yes, search: false, confirm: async (n, a) => (seen.push([n, a]), true) }).run("x");
    expect(seen).toHaveLength(1);
    expect(resultOf(yes).content).toContain("allowed");
  });

  it("confirmAll gates every risky tool but not safe ones", async () => {
    const asked: string[] = [];
    const d = tmpDir();
    const client = scripted([
      [use("a", "write_file", { path: path.join(d, "f"), content: "x" }), use("b", "list_dir", { path: d }), use("c", "think", { thought: "t" })],
      [text("ok")],
    ]);
    await new Agent({ client, search: false, confirmAll: true, confirm: (n) => (asked.push(n), false) }).run("x");
    expect(asked).toEqual(["write_file"]);
  });
});

describe("system prompt", () => {
  it("states the workflow", () => {
    for (const w of ["PLAN", "ACT", "VERIFY", "ADAPT", "SEARCH", "FINISH", "{platform}"]) expect(SYSTEM_PROMPT).toContain(w);
  });
});
