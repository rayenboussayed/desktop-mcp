/**
 * One private Xvfb (with a window manager) for the whole test run, started BEFORE any worker exists.
 *
 * Why not per test file: libnut reads DISPLAY from the C-level environment. Assigning `process.env.DISPLAY` inside
 * a test worker is not guaranteed to reach it (in worker threads it never does), which crashed the worker with
 * "Could not open main display". Starting the server here puts DISPLAY into every worker's initial environment.
 * It also guarantees the tests never touch a developer's real desktop.
 *
 * The display stack is self-healing: if it does not come up (stale sockets from a previous run, a slow window
 * manager), the WHOLE stack is torn down cleanly and started again, and the run aborts with a clear message
 * rather than letting every GUI test fail mysteriously.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const have = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM lets Xvfb remove its own socket and lock file; SIGKILL only if it ignores that.
 * @param p - Child process to terminate.
 */
async function terminate(p: ChildProcess | undefined): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  p.kill("SIGTERM");
  for (let i = 0; i < 20 && p.exitCode === null && p.signalCode === null; i++) await sleep(50);
  if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
}

interface Stack { display: string; stop: () => Promise<void> }

/**
 *
 * @returns The display stack, or `undefined` when tools are unavailable.
 */
async function startStack(): Promise<Stack | undefined> {
  const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  const children: ChildProcess[] = [xvfb];
  const stop = async (): Promise<void> => {
    for (const child of children) await terminate(child);
  };
  const display = await new Promise<string | undefined>((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve(undefined), 10_000);
    (xvfb.stdio[3] as NodeJS.ReadableStream).on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) { clearTimeout(timer); resolve(`:${buf.trim()}`); }
    });
    xvfb.once("exit", () => { clearTimeout(timer); resolve(undefined); });
  });
  if (!display) { await stop(); return undefined; }
  const env = { ...process.env, DISPLAY: display };
  // wait until the server really completes X handshakes (not merely listens)
  if (have("xdpyinfo")) {
    for (let i = 0; i < 100 && spawnSync("xdpyinfo", ["-display", display]).status !== 0; i++) await sleep(50);
  }
  if (!have("openbox") || !have("xprop") || !have("xterm")) return { display, stop };
  // "Ready" means the WM really manages windows. It advertises itself well before it does, and a window that
  // maps while it is still starting is never adopted, so a single probe can miss it forever: re-launch the probe
  // (a NEW window, mapped while the WM is certainly running) until the WM lists it as a client.
  children.push(spawn("openbox", [], { stdio: "ignore", env }));
  let ready = false;
  for (let round = 0; round < 8 && !ready; round++) {
    const probe = spawn("xterm", ["-T", "wm-ready-probe", "-e", "sleep", "60"], { stdio: "ignore", env });
    for (let i = 0; i < 30 && !ready; i++) {
      ready = spawnSync("xprop", ["-root", "_NET_CLIENT_LIST"], { env }).stdout.toString().includes("0x");
      if (!ready) await sleep(50);
    }
    await terminate(probe);
  }
  await sleep(300);
  if (!ready) { await stop(); return undefined; }
  return { display, stop };
}

/**
 *
 * @returns A teardown function for the test display stack.
 */
export default async function setup(): Promise<() => Promise<void>> {
  delete process.env.DISPLAY; // never drive a real desktop from the tests
  delete process.env.WAYLAND_DISPLAY; // force tests onto the private Xvfb instead of a Wayland session
  delete process.env.XDG_SESSION_TYPE;
  if (!have("Xvfb")) return async () => {};
  for (let attempt = 1; attempt <= 3; attempt++) {
    const stack = await startStack();
    if (stack) {
      process.env.DISPLAY = stack.display;
      process.once("exit", () => void 0);
      return stack.stop;
    }
  }
  const why = "test setup: the virtual display with its window manager did not come up after 3 full attempts";
  process.stderr.write(`\n${why}\n`); // vitest cannot always print a setup error itself
  throw new Error(why);
}
