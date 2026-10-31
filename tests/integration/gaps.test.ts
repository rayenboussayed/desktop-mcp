/** Targeted tests for branches the feature tests do not reach: error paths, platform branches, injected streams. */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, __setSdkLoader, type ContentBlock, type MessagesClient } from "../../src/agent.js";
import { execText, killTree, signalCode } from "../../src/exec.js";
import { listKeyNames } from "../../src/nut/keys.js";
import { canConnect } from "../../src/nut/runtime.js";
import { describePlatform } from "../../src/platform.js";
import { __setOcrEngine, recognize, shutdownOcr } from "../../src/plugins/ocr.js";
import { formatStatus, pluginStatus } from "../../src/plugins/status.js";
import { PermissionEngine, pathRegExp } from "../../src/policy/engine.js";
import { PolicySchema } from "../../src/policy/schema.js";
import { callTool } from "../../src/tools/base.js";
import { listDir } from "../../src/tools/files.js";
import { runCommand } from "../../src/tools/shell.js";
import { runCommandTool } from "../../src/tools/shell.js";
import { DEFAULT_SEARCH_URL, fetchUrl, parseResults, searchUrl } from "../../src/tools/search.js";
import * as sys from "../../src/tools/system.js";
import { main as cliMain, makeLineReader, type CliIo } from "../../src/cli.js";
import { main as mcpMain, serveHttp } from "../../src/mcpServer.js";
import { makeBin, sleep, tmpDir, withEnv, withPlatform } from "../helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("exec: process-tree kill and capture limits", () => {
  it("killTree handles a child without a pid, win32 (taskkill), and failing kills", async () => {
    expect(() => killTree({ pid: undefined })).not.toThrow();
    withPlatform("win32", () => expect(() => killTree({ pid: 99_999_999 })).not.toThrow()); // taskkill is absent here: the error is swallowed
    const fallback = vi.fn();
    killTree({ pid: 4_194_000, kill: fallback }); // no such process group: falls back to child.kill
    expect(fallback).toHaveBeenCalledWith("SIGKILL");
    expect(() => killTree({ pid: 4_194_000 })).not.toThrow(); // no fallback available: nothing left to kill
    expect(() => killTree({ pid: 4_194_000, kill: () => { throw new Error("gone"); } })).not.toThrow();
    await sleep(50);
  });
  it("a synchronous spawn failure becomes an error result", async () => {
    const res = await execText("a\0b", []);
    expect(res.error).toBeDefined();
    expect(res.code).toBeNull();
  });
  it("runs without a timeout, and caps captured output at 8 MiB per stream", async () => {
    expect((await execText(process.execPath, ["-e", "1"])).code).toBe(0);
    const big = await execText(process.execPath, ["-e", "process.stdout.write('x'.repeat(9<<20)); process.stderr.write('y'.repeat(9<<20))"], { timeoutMs: 60_000 });
    expect(big.stdout.length).toBeGreaterThanOrEqual(8 << 20);
    expect(big.stdout.length).toBeLessThan(9 << 20);
    expect(big.stderr.length).toBeGreaterThanOrEqual(8 << 20);
    expect(big.stderr.length).toBeLessThan(9 << 20);
  });
  it("writing input to a process that exits without reading it is not an error (EPIPE is swallowed)", async () => {
    const res = await execText("sh", ["-c", "exit 0"], { input: "x".repeat(4 << 20), timeoutMs: 10_000 });
    expect(res.code).toBe(0);
    expect(res.error).toBeUndefined();
  });
  it("signalCode", () => {
    expect(signalCode(null)).toBeNull();
    expect(signalCode("SIGKILL")).toBe(-9);
    expect(signalCode("SIGNOPE" as NodeJS.Signals)).toBe(-1);
  });
});



describe("shell and exec safety", () => {
  it("guarded killTree ignores zero and negative PIDs even in Windows mode", async () => {
    expect(() => killTree({ pid: 0 })).not.toThrow();
    expect(() => killTree({ pid: -1 })).not.toThrow();
    withPlatform("win32", () => expect(() => killTree({ pid: 99_999_999 })).not.toThrow());
  });
  it("runCommand validates its timeout and cwd before spawning a shell", async () => {
    expect(await runCommand("echo hi", 0)).toBe("[error] timeout must be a positive number of seconds (got 0)");
    expect(await runCommand("echo hi", 60, "")).toBe("[error] cwd must be a non-empty string (got )");
    expect(await runCommand("echo hi", 60, 8)).toBe("[error] cwd must be a non-empty string (got 8)");
  });
  it("schema rejects an invalid timeout before runCommand is reached", async () => {
    await expect(callTool(runCommandTool, { command: "echo hi", timeout: 0 })).rejects.toThrow();
  });
  it("runs the Windows PowerShell branch with a custom working directory", async () => {
    const bin = tmpDir();
    makeBin(bin, "powershell", "printf '%s\\n' \"$*\"");
    await withPlatform("win32", () => withEnv({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
      expect(await runCommand("echo hi", 3, ".")).not.toMatch(/\[error\]/);
    }));
  });
});

describe("platform and keys", () => {
  it("falls back to environment variables when the OS cannot name the user", () => {
    vi.spyOn(os, "userInfo").mockImplementation(() => { throw new Error("no passwd entry"); });
    expect(withEnv({ USER: "alice", USERNAME: undefined }, describePlatform)).toContain("User: alice");
    expect(withEnv({ USER: undefined, USERNAME: "bob" }, describePlatform)).toContain("User: bob");
    expect(withEnv({ USER: undefined, USERNAME: undefined }, describePlatform)).toContain("User: unknown");
  });
  it("listKeyNames only lists names that exist in this nut.js build", () => {
    const names = listKeyNames({ Key: { Return: 1, A: 2 } });
    expect(names).toEqual(["enter", "return", "a"]);
  });
  it("canConnect times out on a socket that never answers", async () => {
    const fake = { setTimeout: (_ms: number, cb: () => void) => cb(), once: () => fake, destroy: () => {} };
    const fakeConnect = (() => fake) as (options: { path: string }) => { setTimeout(ms: number, cb: () => void): void; once(event: string, cb: (...a: unknown[]) => void): unknown; destroy(): void };
    expect(await canConnect("/x", 5, fakeConnect)).toBe(false);
  });
});

describe("OCR worker lifecycle", () => {
  it("a failed worker start is not cached; a missing block list yields an empty result", async () => {
    let starts = 0;
    __setOcrEngine(async () => ({
      createWorker: async () => {
        if (++starts === 1) throw new Error("wasm failed");
        return { recognize: async () => ({ data: { text: "hi", confidence: 90, blocks: null } }), terminate: async () => {} };
      },
    }));
    await expect(recognize(Buffer.from(""), "eng")).rejects.toThrow("wasm failed");
    expect(await recognize(Buffer.from(""), "eng")).toEqual({ text: "hi", confidence: 0.9, lines: [], words: [] });
    expect(starts).toBe(2);
    await shutdownOcr();
    __setOcrEngine(undefined);
  });
});

describe("plugin status with injected package lookups", () => {
  it("reports missing optional dependencies and installed official packages", () => {
    const none = pluginStatus({}, () => false);
    expect(none.find((x) => x.official.includes("template-matcher"))).toMatchObject({ status: "unavailable", detail: "needs the optional dependency 'jimp'" });
    expect(none.find((x) => x.official.includes("plugin-ocr"))?.status).toBe("unavailable");
    expect(none.find((x) => x.official.includes("azure"))?.detail).not.toContain("is installed");
    const all = pluginStatus({}, () => true);
    expect(all.find((x) => x.official.includes("azure"))?.detail).toContain("The official package @nut-tree/plugin-azure is installed but is not wired in here.");
    expect(formatStatus(all)).toContain("[x]");
  });
  it("mentions ffmpeg for recording only when it is installed", () => {
    const bin = tmpDir();
    makeBin(bin, "ffmpeg", "true");
    expect(withEnv({ PATH: bin }, () => pluginStatus().find((x) => x.official.includes("screenrecording"))?.detail)).toBe("PNG frames, encoded to MP4 with ffmpeg");
    expect(withEnv({ PATH: tmpDir() }, () => pluginStatus().find((x) => x.official.includes("screenrecording"))?.detail)).toBe("PNG frames (install ffmpeg for MP4)");
  });
});

describe("files and search edge cases", () => {
  it("list_dir shows a dangling symlink without a size", async () => {
    const d = tmpDir();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    symlinkSync(path.join(d, "nowhere"), path.join(d, "dangling"));
    expect(await listDir(d)).toBe("file\t\tdangling");
  });
  it("search URL default and override", () => {
    expect(searchUrl({})).toBe(DEFAULT_SEARCH_URL);
    expect(searchUrl({ OSAGENT_SEARCH_URL: "http://x/s" })).toBe("http://x/s");
  });
  it("result links: a malformed redirect URL and a link that only mentions uddg", () => {
    const html = (href: string) => `<a class="result__a" href="${href}">T</a><a class="result__snippet" href="#">S</a>`;
    expect(parseResults(html("http://[uddg="), 1)[0]?.url).toBe("http://[uddg=");
    expect(parseResults(html("/l/?q=notuddg=1"), 1)[0]?.url).toBe("/l/?q=notuddg=1");
  });
  it("fetch_url copes with a response that has no content type", async () => {
    const srv: Server = createServer((_req, res) => res.end("plain body"));
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      expect(await fetchUrl(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`)).toBe("plain body");
    } finally {
      srv.close();
    }
  });
});

describe("system tools: error and platform branches", () => {
  it("cpu load is 0 when no time elapsed between samples", async () => {
    vi.spyOn(os, "cpus").mockReturnValue([{ model: "m", speed: 1, times: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 } }]);
    expect(await sys.systemInfo()).toContain("CPU load: 0%");
  });
  it("list_processes on macOS uses the plain user column; a missing ps is an error", async () => {
    expect(await withPlatform("darwin", () => sys.listProcesses("node", 3))).toContain("pid\tname\tmemory\tuser");
    await expect(withEnv({ PATH: tmpDir() }, () => sys.listProcesses())).rejects.toThrow();
  });
  it("kill_process reports a process that vanished, denied access, and unexpected errors", async () => {
    const child = spawn("sleep", ["60"]);
    const pid = child.pid as number;
    const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    const spy = vi.spyOn(process, "kill");
    spy.mockImplementation(() => { throw err("ESRCH"); });
    expect(await sys.killProcess(pid)).toBe(`[error] no such process ${pid}`);
    spy.mockImplementation(() => { throw err("EPERM"); });
    expect(await sys.killProcess(pid)).toBe(`[error] access denied for pid ${pid}`);
    spy.mockImplementation(() => { throw err("EIO"); });
    await expect(sys.killProcess(pid)).rejects.toThrow("EIO");
    spy.mockRestore();
    child.kill("SIGKILL");
  });
  it("search_in_files skips files over 10 MiB", async () => {
    const d = tmpDir();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path.join(d, "huge.txt"), "needle" + "x".repeat(11 << 20));
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path.join(d, "small.txt"), "needle");
    expect(await sys.searchInFiles("needle", d)).toBe(`${path.join(d, "small.txt")}:1: needle`);
  });
  it("the tool wrappers call through with validated defaults", async () => {
    const d = tmpDir();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path.join(d, "a.txt"), "findme");
    expect(await callTool(sys.findFilesTool, { pattern: "*.txt", root: d })).toBe(path.join(d, "a.txt"));
    expect(await callTool(sys.searchInFilesTool, { text: "findme", root: d })).toContain("a.txt:1: findme");
    const child = spawn("sleep", ["60"]);
    expect(await callTool(sys.killProcessTool, { pid: child.pid, force: true })).toMatch(/^killed \d+ \(sleep\)$/);
  });
});

describe("engine path patterns", () => {
  it("a bare /** covers the whole filesystem", () => {
    expect(pathRegExp("/**").test("/any/where")).toBe(true);
  });
});

describe("agent: default client and permission policy", () => {
  const serve = async (body: () => string): Promise<{ url: string; close: () => void }> => {
    const srv = createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(body()); }); });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
  };

  it("builds its own Ollama client (host from the environment)", async () => {
    const body = () => JSON.stringify({ model: "m", created_at: new Date().toISOString(), message: { role: "assistant", content: "hello from the stand-in API" }, done: true, done_reason: "stop", total_duration: 0, load_duration: 0, prompt_eval_count: 1, prompt_eval_duration: 0, eval_count: 1, eval_duration: 0 });
    const s = await serve(() => body());
    try {
      const out = await withEnv({ OLLAMA_HOST: s.url }, () => new Agent({ search: false }).run("hi"));
      expect(out).toBe("hello from the stand-in API");
    } finally {
      s.close();
    }
  });

  const scripted = (turns: ContentBlock[][]): MessagesClient => ({ messages: { create: async () => ({ content: turns.shift() ?? [{ type: "text", text: "done" }] }) } });
  const use = (id: string, name: string, input: unknown): ContentBlock => ({ type: "tool_use", id, name, input });
  const resultsOf = async (agent: Agent): Promise<{ content: string; is_error: boolean }[]> => {
    const last = agent.messages.filter((m) => m.role === "user" && Array.isArray(m.content)).at(-1);
    return last?.content as { content: string; is_error: boolean }[];
  };

  it("without the optional Anthropic SDK the standalone agent says how to install it (omcps never needs it)", async () => {
    __setSdkLoader(() => Promise.reject(new Error("Cannot find package")));
    try {
      await expect(new Agent({ search: false }).run("hi")).rejects.toThrow(/needs the Ollama SDK: npm install ollama \(the desktop-mcp MCP server does not\)/);
    } finally {
      __setSdkLoader(undefined);
    }
  });

  it("a text block without text is an empty answer", async () => {
    expect(await new Agent({ client: scripted([[{ type: "text" }]]), search: false }).run("x")).toBe("");
  });

  it("hides tools the policy denies, describes the policy, and refuses calls outside it", async () => {
    const engine = new PermissionEngine(PolicySchema.parse({ name: "agent-ro", default: "deny", capabilities: { "fs.read": "allow", "system.info": "allow" } }));
    const client = scripted([[use("a", "permissions_describe", {}), use("b", "write_file", { path: "/tmp/x", content: "x" }), use("c", "read_file", { path: "package.json", offset: 0, limit: 1 })], [{ type: "text", text: "ok" }]]);
    const agent = new Agent({ client, search: false, policy: engine });
    await agent.run("x");
    const res = await resultsOf(agent);
    expect(res[0]?.content).toContain("Permission policy: agent-ro");
    expect(res[1]).toMatchObject({ content: "[error] unknown tool write_file", is_error: true }); // hidden, so unknown
    expect(res[2]?.is_error).toBe(false);
  });

  it("routes approvals to the confirm callback; with none, nobody can be asked", async () => {
    const mk = (confirm?: (n: string) => boolean) => {
      const engine = new PermissionEngine(PolicySchema.parse({ name: "ask-all", default: "ask" }));
      return new Agent({ client: scripted([[use("a", "run_command", { command: "echo approved" })], [{ type: "text", text: "ok" }]]), search: false, policy: engine, confirm });
    };
    const yes = mk(() => true);
    await yes.run("x");
    expect((await resultsOf(yes))[0]?.content).toContain("approved");
    const no = mk(() => false);
    await no.run("x");
    expect((await resultsOf(no))[0]).toMatchObject({ content: "[permission denied] the user did not approve", is_error: true });
    const nobody = mk();
    await nobody.run("x");
    expect((await resultsOf(nobody))[0]?.content).toContain("nobody could be asked");
  });
});

describe("cli: policy flags, default streams and default agent", () => {
  const harness = () => {
    const out: string[] = [];
    const created: Parameters<CliIo["createAgent"]>[0][] = [];
    const tasks: string[] = [];
    const io: Partial<CliIo> = { out: (s) => out.push(s), createAgent: (o) => (created.push(o), { run: async (t) => (tasks.push(t), `ran:${t}`) }) };
    return { io, out, created, tasks };
  };

  it("builds a permission engine from --preset / --policy / --deny-tool / --allow-tool", async () => {
    const h = harness();
    expect(await cliMain(["--preset", "readonly", "--deny-tool", "web_search", "--allow-tool", "think", "go"], h.io)).toBe(0);
    expect(h.created[0]?.policy?.policy.name).toBe("readonly");
    expect(h.created[0]?.policy?.staticMode("web_search")).toBe("deny");
    const f = path.join(tmpDir(), "p.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(f, '{"name":"filepol","default":"allow"}');
    const h2 = harness();
    await cliMain(["--policy", f, "go"], h2.io);
    expect(h2.created[0]?.policy?.policy.name).toBe("filepol");
    const h3 = harness();
    await cliMain(["go"], h3.io);
    expect(h3.created[0]?.policy).toBeUndefined();
  });

  it("--policy-show lists what the agent may do, with and without --gui", async () => {
    const h = harness();
    expect(await cliMain(["--preset", "readonly", "--policy-show"], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("Permission policy: readonly");
    expect(h.out.join("\n")).toContain("Not available:");
    const h2 = harness();
    expect(await cliMain(["--preset", "locked", "--gui", "--no-search", "--policy-show"], h2.io)).toBe(0);
    expect(h2.out.join("\n")).toContain("Permission policy: locked");
  });

  it("reports an invalid policy and an unknown preset", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await cliMain(["--preset", "nonsense", "x"], harness().io)).toBe(2);
    const bad = path.join(tmpDir(), "p.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(bad, '{"commands":{"allow":["("]}}');
    expect(await cliMain(["--policy", bad, "x"], harness().io)).toBe(2);
    expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/unknown preset 'nonsense'[\s\S]*invalid commands\.allow pattern/);
  });

  it("prints to the console by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await cliMain(["--info"], {})).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain("OS:");
  });

  it("reads tasks and approvals from injected streams until EOF", async () => {
    const h = harness();
    const input = new PassThrough();
    const output = new PassThrough();
    const done = cliMain([], { ...h.io, input, output });
    input.write("first task\n");
    await sleep(100);
    input.end("second task\n");
    expect(await done).toBe(0);
    expect(h.tasks).toEqual(["first task", "second task"]);
    expect(String(output.read())).toContain("Task> ");
  });

  it("makeLineReader: queued lines, waiting readers, EOF and close", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = makeLineReader(input, output);
    input.write("a\nb\n");
    await sleep(50);
    expect(await reader.ask("1> ")).toBe("a"); // queued before anyone asked
    const second = reader.ask("2> "); // answered from the queue as well
    expect(await second).toBe("b");
    const waiting = reader.ask("3> "); // nothing yet: waits
    input.write("c\n");
    expect(await waiting).toBe("c");
    const pending = reader.ask("4> ");
    input.end();
    expect(await pending).toBeNull(); // EOF releases waiting readers
    expect(await reader.ask("5> ")).toBeNull(); // and every later ask
    reader.close();
    expect(String(output.read())).toContain("1> ");
  });

  it("uses the real Agent when none is injected (events are printed)", async () => {
    const srv = createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "m", created_at: new Date().toISOString(), message: { role: "assistant", content: "real agent reply" }, done: true, done_reason: "stop", total_duration: 0, load_duration: 0, prompt_eval_count: 1, prompt_eval_duration: 0, eval_count: 1, eval_duration: 0 })); }); });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const out: string[] = [];
    try {
      const code = await withEnv({ OLLAMA_HOST: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` }, () => cliMain(["--no-search", "hello"], { out: (s) => out.push(s) }));
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("real agent reply");
    } finally {
      srv.close();
    }
  });
});

describe("mcp server: remaining edges", () => {
  it("a request without a Host header is refused by a local-only server", async () => {
    const http = await serveHttp({ policy: "readonly" }, "127.0.0.1", 0);
    try {
      const status = await new Promise<string>((resolve) => {
        const s = netConnect((http.address() as AddressInfo).port, "127.0.0.1", () => s.write("POST /mcp HTTP/1.0\r\ncontent-length: 2\r\n\r\n{}"));
        let got = "";
        s.on("data", (d) => (got += d));
        s.on("close", () => resolve(got.split("\r\n")[0] as string));
      });
      expect(status).toContain("403");
    } finally {
      http.close();
    }
  });

  it("an internal failure while building the server is a 500, not a crash", async () => {
    const engine = new PermissionEngine(PolicySchema.parse({ default: "allow" }));
    engine.isVisible = () => { throw new Error("engine exploded"); };
    const http = await serveHttp({ engine }, "127.0.0.1", 0);
    try {
      const res = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("engine exploded");
    } finally {
      http.close();
    }
  });

  it("main reports a policy that fails for a non-policy reason", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = path.join(tmpDir(), "p.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(f, '{"commands":{"deny":["("]}}');
    expect(await mcpMain(["--policy", f])).toBe(2);
    expect(err.mock.calls.join("\n")).toContain("invalid commands.deny pattern");
  });

  it("main falls back to the process streams", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const sin = Object.getOwnPropertyDescriptor(process, "stdin") as PropertyDescriptor;
    const sout = Object.getOwnPropertyDescriptor(process, "stdout") as PropertyDescriptor;
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
    try {
      const done = mcpMain(["--preset", "locked"]);
      await sleep(100);
      stdin.end();
      expect(await done).toBe(0);
    } finally {
      Object.defineProperty(process, "stdin", sin);
      Object.defineProperty(process, "stdout", sout);
    }
  });
});
