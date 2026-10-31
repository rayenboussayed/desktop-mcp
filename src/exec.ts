/** Async process helper: captures output as text, enforces a timeout, kills the whole process tree. */
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";

export interface ExecOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  /** Treat `file` as a full shell command line (/bin/sh -c semantics). */
  shell?: boolean;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

const MAX_CAPTURE = 8 * 1024 * 1024;

/** The minimal child-process surface `killTree` needs. */
interface KillableChild {
  pid?: number;
  kill?: (signal?: number | NodeJS.Signals) => unknown;
}

/**
 * @param child - Child process to terminate.
 */
export function killTree(child: KillableChild): void {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      process.kill(-pid, "SIGKILL"); // negative pid = the whole process group (we spawn detached)
    }
  } catch {
    if (typeof child.kill === "function") try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 *
 * @param file - Executable to run.
 * @param args - Command-line arguments.
 * @param opts - Execution options.
 * @returns The process exit code, output and timing.
 */
export function execText(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    const stdio: ["pipe" | "ignore", "pipe", "pipe"] = [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"];
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        shell: opts.shell === true,
        stdio,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, error: e as Error });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (r: Partial<ExecResult>): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        code: null, signal: null, timedOut,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        ...r,
      });
    };

    child.stdout?.on("data", (d: Buffer) => {
      if (outLen < MAX_CAPTURE) { out.push(d); outLen += d.length; }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (errLen < MAX_CAPTURE) { err.push(d); errLen += d.length; }
    });
    child.on("error", (e) => finish({ error: e }));
    // Daemonising tools (xclip, wl-copy) keep the pipes open after exiting: do not wait for them forever.
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(() => finish({ code, signal }), 300);
    });
    child.on("close", (code, signal) => finish({ code, signal }));

    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        setTimeout(() => finish({}), 200); // let the pipes drain; never hang
      }, opts.timeoutMs);
    }
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
}

/**
 * Negative signal number, like Python's returncode for a signalled child.
 * @param signal - Signal name.
 * @returns The conventional exit code for the signal.
 */
export function signalCode(signal: NodeJS.Signals | null): number | null {
  if (!signal) return null;
  // eslint-disable-next-line security/detect-object-injection
  const n = (os.constants.signals as Record<string, number>)[signal];
  return n === undefined ? -1 : -n;
}
