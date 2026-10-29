/** Helpers for tests that need real X clients (see globalSetup.ts for the display and window manager). */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { hasBinary, sleep } from "./helpers.js";

export const haveX = hasBinary("Xvfb") && !!process.env.DISPLAY;
export const haveXev = haveX && hasBinary("xev");
export const haveXterm = haveX && hasBinary("xterm");
export const haveWm = haveX && hasBinary("openbox") && hasBinary("xprop") && hasBinary("xwininfo") && hasBinary("xdotool") && hasBinary("wmctrl");

const procs: ChildProcess[] = [];
/**
 *
 */
export function stopAll(): void {
  while (procs.length) (procs.pop() as ChildProcess).kill("SIGKILL");
}

export const xrun = (cmd: string, args: string[]): string => spawnSync(cmd, args, { encoding: "utf8" }).stdout;

/** A real X client that logs the events it receives. */
export class Xev {
  out = "";
  private proc: ChildProcess;
  constructor(geometry = "500x400+50+50") {
    this.proc = spawn("xev", ["-geometry", geometry], { env: process.env });
    procs.push(this.proc);
    this.proc.stdout?.on("data", (d) => (this.out += d));
  }
  async ready(): Promise<this> { await sleep(700); return this; }
  async settle(ms = 400): Promise<this> { await sleep(ms); return this; }
  keys(): string[] { return [...this.out.matchAll(/KeyPress[\s\S]*?keysym 0x[0-9a-f]+, (\S+?)\)/g)].map((m) => m[1] as string); }
  buttons(kind: "ButtonPress" | "ButtonRelease" = "ButtonPress"): string[] {
    return [...this.out.matchAll(new RegExp(`${kind} event[\\s\\S]*?button (\\d)`, "g"))].map((m) => m[1] as string);
  }
  motions(): number { return (this.out.match(/MotionNotify/g) ?? []).length; }
  stop(): void { this.proc.kill("SIGKILL"); }
}

/**
 *
 * @returns The running xev process.
 */
export async function startXev(): Promise<Xev> {
  const ev = await new Xev().ready();
  return ev;
}

/**
 * A titled xterm window that stays open; the title is not overwritten by a shell prompt.
 * @param title - Initial window title.
 * @param opts - Window options.
 * @param opts.geometry - Window geometry.
 * @param opts.text - Initial terminal text.
 * @param opts.font - Font size.
 * @param opts.bg - Background colour.
 * @returns The xterm child process.
 */
export async function openWindow(title: string, opts: { geometry?: string; text?: string; font?: number; bg?: string } = {}): Promise<ChildProcess> {
  const args = ["-T", title, "-geometry", opts.geometry ?? "50x8+100+100"];
  if (opts.font) args.push("-fa", "Monospace", "-fs", String(opts.font));
  if (opts.bg) args.push("-bg", opts.bg);
  args.push("-e", "sh", "-c", `${opts.text ? `echo '${opts.text}'; ` : ""}sleep 600`);
  const p = spawn("xterm", args, { env: process.env });
  procs.push(p);
  for (let i = 0; i < 100; i++) {
    if (xrun("xprop", ["-root", "_NET_CLIENT_LIST"]).match(/0x/) && xrun("sh", ["-c", `xdotool search --name '^${title}$' | head -1`]).trim()) break;
    await sleep(50);
  }
  await sleep(300);
  return p;
}
