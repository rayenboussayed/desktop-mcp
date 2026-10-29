/**
 * Window management through nut.js: list, active, focus, move, resize, minimize, restore, close, wait.
 *
 * Linux needs care (verified against a real window manager, see README):
 *  - nut's `getWindows()` returns the WM's FRAME windows and 1x1 helper windows, which have no title; we list the
 *    real client windows from the EWMH `_NET_CLIENT_LIST` and wrap them in nut `Window` objects instead;
 *  - nut reports client geometry relative to its frame; we read absolute geometry with `xwininfo`;
 *  - `minimize`/`restore` are "not implemented in libnut" on Linux: `xdotool` does them, `wmctrl` closes politely.
 */
import { z } from "zod";
import { execText } from "../exec.js";
import { tapKeys } from "../nut/keys.js";
import { nut, sleep, type Nut } from "../nut/runtime.js";
import { currentOs } from "../platform.js";
import { currentEngine } from "../policy/engine.js";
import { defineTool } from "./base.js";

export interface WinInfo {
  handle: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  active: boolean;
}

export interface Selector {
  handle?: number;
  /** Regular expression (case-insensitive) matched against window titles. */
  title?: string;
}

const fmt = (w: WinInfo): string =>
  `handle=${w.handle} title=${JSON.stringify(w.title)} at (${w.x},${w.y}) ${w.width}x${w.height}${w.active ? " [active]" : ""}`;

/**
 * nut.js keeps the native handle in a field that its typings mark private.
 * @param w - Window or bitmap width.
 * @returns The native window handle.
 */
const handleOf = (w: unknown): number => (w as { windowHandle: number }).windowHandle;

const isLinux = (): boolean => currentOs() === "linux";

// ------------------------------------------------------------ Linux helpers
/**
 *
 * @param cmd - Command to execute.
 * @param args - Arguments to use.
 * @returns The command's standard output.
 */
export async function x11(cmd: string, args: string[]): Promise<string> {
  const r = await execText(cmd, args, { timeoutMs: 5000 });
  if (r.error) throw new Error(`${cmd} is needed for window control on Linux (${r.error.message}); install x11-utils / xdotool / wmctrl`);
  if (r.code !== 0) throw new Error(`${cmd} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

const hex = (n: number): string => `0x${n.toString(16)}`;
const parseIds = (s: string): number[] => (s.match(/0x[0-9a-f]+/gi) ?? []).map(Number);

/**
 *
 * @param handle - X11 window handle.
 * @returns The window geometry.
 */
export async function x11Geometry(handle: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const out = await x11("xwininfo", ["-id", String(handle)]);
  const num = (label: string): number => Number(new RegExp(`${label}:\\s+(-?\\d+)`).exec(out)?.[1] ?? 0);
  return { x: num("Absolute upper-left X"), y: num("Absolute upper-left Y"), width: num("Width"), height: num("Height") };
}

/**
 *
 * @param handle - X11 window handle.
 * @returns The window title.
 */
export async function x11Title(handle: number): Promise<string> {
  const out = await x11("xprop", ["-id", String(handle), "_NET_WM_NAME", "WM_NAME"]);
  return /_NET_WM_NAME\(\w+\) = "(.*)"/.exec(out)?.[1] ?? /WM_NAME\(\w+\) = "(.*)"/.exec(out)?.[1] ?? "";
}

/**
 *
 * @returns The active window handle, or `undefined`.
 */
export async function x11Active(): Promise<number | undefined> {
  const id = parseIds(await x11("xprop", ["-root", "_NET_ACTIVE_WINDOW"]))[0];
  return id === undefined || id === 0 ? undefined : id;
}

// ---------------------------------------------------------------- listing
/**
 *
 * @param w - Window or bitmap width.
 * @param active - Handle of the currently active window, when known.
 * @returns The resulting value.
 */
async function infoFor(w: InstanceType<Nut["Window"]>, active: number | undefined): Promise<WinInfo> {
  const handle = handleOf(w);
  if (isLinux()) {
    const title = (await w.title) || (await x11Title(handle).catch(() => ""));
    return { handle, title, ...(await x11Geometry(handle)), active: handle === active };
  }
  const r = await w.region;
  return { handle, title: await w.title, x: r.left, y: r.top, width: r.width, height: r.height, active: handle === active };
}

/**
 * Real, titled top-level windows.
 * @returns The collected items.
 */
export async function listWindows(): Promise<WinInfo[]> {
  const n = await nut();
  if (isLinux()) {
    const ids = parseIds(await x11("xprop", ["-root", "_NET_CLIENT_LIST"]));
    const active = await x11Active();
    const out: WinInfo[] = [];
    for (const id of ids) out.push(await infoFor(new n.Window(n.providerRegistry, id), active));
    return out;
  }
  const active = handleOf(await n.getActiveWindow());
  const out: WinInfo[] = [];
  for (const w of await n.getWindows()) {
    const info = await infoFor(w, active);
    if (info.title && info.width > 1 && info.height > 1) out.push(info);
  }
  return out;
}

/**
 *
 * @returns The active window, or `undefined` when none is active.
 */
export async function activeWindow(): Promise<WinInfo | undefined> {
  const n = await nut();
  if (isLinux()) {
    const id = await x11Active();
    return id === undefined ? undefined : infoFor(new n.Window(n.providerRegistry, id), id);
  }
  const w = await n.getActiveWindow();
  return infoFor(w, handleOf(w));
}

/**
 * Title of the focused window, or undefined (used by the permission engine for `gui.windows`).
 * @returns The active window title, or `undefined` when none is active.
 */
export async function activeWindowTitle(): Promise<string | undefined> {
  try {
    return (await activeWindow())?.title;
  } catch {
    return undefined;
  }
}

/**
 *
 * @param sel - Window selector.
 * @returns The matching window.
 */
async function resolve(sel: Selector): Promise<WinInfo> {
  if (sel.handle === undefined && sel.title === undefined) {
    const a = await activeWindow();
    if (!a) throw new Error("there is no active window");
    return a;
  }
  const all = await listWindows();
  let re: RegExp | undefined;
  if (sel.title !== undefined) {
    try {
      re = new RegExp(sel.title, "i");
    } catch (e) {
      throw new Error(`invalid title pattern: ${(e as Error).message}`, { cause: e });
    }
  }
  const hit = all.find((w) => (sel.handle === undefined || w.handle === sel.handle) && (re === undefined || re.test(w.title)));
  if (!hit) throw new Error(`no window matches ${JSON.stringify(sel)}`);
  return hit;
}

/**
 * Resolve the target window and make sure the permission policy lets the AI control it.
 * @param sel - Window selector.
 * @returns The nut.js module, window info and window object.
 */
async function target(sel: Selector): Promise<{ n: Nut; info: WinInfo; win: InstanceType<Nut["Window"]> }> {
  const n = await nut();
  const info = await resolve(sel);
  currentEngine()?.assertWindow(info.title);
  return { n, info, win: new n.Window(n.providerRegistry, info.handle) };
}

const refreshed = async (handle: number): Promise<string> => {
  await sleep(150); // let the window manager apply the change
  const w = (await listWindows()).find((x) => x.handle === handle);
  return w ? fmt(w) : `handle=${handle}`;
};

// -------------------------------------------------------------- operations
/**
 *
 * @returns A human-readable result.
 */
export async function windowList(): Promise<string> {
  const all = await listWindows();
  return all.length === 0 ? "[no windows]" : all.map(fmt).join("\n");
}

/**
 *
 * @returns A human-readable result.
 */
export async function windowActive(): Promise<string> {
  const a = await activeWindow();
  return a ? fmt(a) : "[no active window]";
}

/**
 *
 * @param sel - Window selector.
 * @returns A human-readable result.
 */
export async function windowFocus(sel: Selector): Promise<string> {
  const { win, info } = await target(sel);
  await win.focus();
  return `focused ${await refreshed(info.handle)}`;
}

/**
 *
 * @param sel - Window selector.
 * @param x - X coordinate in screen pixels.
 * @param y - Y coordinate in screen pixels.
 * @returns A human-readable result.
 */
export async function windowMove(sel: Selector, x: number, y: number): Promise<string> {
  const { n, win, info } = await target(sel);
  await win.move(new n.Point(x, y));
  return `moved ${await refreshed(info.handle)}`;
}

/**
 *
 * @param sel - Window selector.
 * @param width - Width in pixels.
 * @param height - Height in pixels.
 * @returns A human-readable result.
 */
export async function windowResize(sel: Selector, width: number, height: number): Promise<string> {
  const { n, win, info } = await target(sel);
  await win.resize(new n.Size(width, height));
  return `resized ${await refreshed(info.handle)}`;
}

/**
 *
 * @param sel - Window selector.
 * @returns A human-readable result.
 */
export async function windowMinimize(sel: Selector): Promise<string> {
  const { win, info } = await target(sel);
  if (isLinux()) await x11("xdotool", ["windowminimize", String(info.handle)]);
  else await win.minimize();
  return `minimized handle=${info.handle} ${JSON.stringify(info.title)}`;
}

/**
 *
 * @param sel - Window selector.
 * @returns A human-readable result.
 */
export async function windowRestore(sel: Selector): Promise<string> {
  const { win, info } = await target(sel);
  if (isLinux()) {
    await x11("xdotool", ["windowmap", String(info.handle)]);
    await x11("xdotool", ["windowactivate", String(info.handle)]);
  } else await win.restore();
  return `restored ${await refreshed(info.handle)}`;
}

/**
 * Ask a window to close (like clicking its close button; the application may refuse or ask to save).
 * @param sel - Window selector.
 * @returns A human-readable result.
 */
export async function windowClose(sel: Selector): Promise<string> {
  const { win, info } = await target(sel);
  if (isLinux()) await x11("wmctrl", ["-i", "-c", hex(info.handle)]);
  else {
    await win.focus();
    await tapKeys(currentOs() === "macos" ? ["meta", "w"] : ["alt", "f4"]);
  }
  return `asked to close handle=${info.handle} ${JSON.stringify(info.title)}`;
}

/**
 * Wait until a window whose title matches appears.
 * @param title - Window title pattern.
 * @param timeoutMs - Timeout in milliseconds.
 * @param intervalMs - Polling interval in milliseconds.
 * @returns A human-readable result.
 */
export async function windowWaitFor(title: string, timeoutMs = 10_000, intervalMs = 250): Promise<string> {
  const re = new RegExp(title, "i");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await listWindows()).find((w) => re.test(w.title));
    if (hit) return fmt(hit);
    if (Date.now() >= deadline) throw new Error(`no window titled /${title}/ appeared within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

// ------------------------------------------------------------------- tools
const selector = {
  handle: z.number().int().optional().describe("Window handle from window_list."),
  title: z.string().optional().describe("Regex matched against window titles (case-insensitive). Omit both for the active window."),
};

export const windowListTool = defineTool({ name: "window_list", description: "List open windows (handle, title, position, size).", shape: {}, run: () => windowList(), readOnly: true });
export const windowActiveTool = defineTool({ name: "window_active", description: "The focused window.", shape: {}, run: () => windowActive(), readOnly: true });
export const windowFocusTool = defineTool({ name: "window_focus", description: "Bring a window to the front and focus it.", shape: selector, run: (a) => windowFocus(a) });
export const windowMoveTool = defineTool({ name: "window_move", description: "Move a window to screen coordinates (the window frame's top-left).", shape: { ...selector, x: z.number().int(), y: z.number().int() }, run: ({ x, y, ...s }) => windowMove(s, x, y) });
export const windowResizeTool = defineTool({ name: "window_resize", description: "Resize a window (the window manager may add a few pixels for borders).", shape: { ...selector, width: z.number().int().positive(), height: z.number().int().positive() }, run: ({ width, height, ...s }) => windowResize(s, width, height) });
export const windowMinimizeTool = defineTool({ name: "window_minimize", description: "Minimise a window.", shape: selector, run: (a) => windowMinimize(a) });
export const windowRestoreTool = defineTool({ name: "window_restore", description: "Restore a minimised window.", shape: selector, run: (a) => windowRestore(a) });
export const windowCloseTool = defineTool({ name: "window_close", description: "Ask a window to close (the application may prompt to save).", shape: selector, run: (a) => windowClose(a), risky: true, destructive: true });
export const windowWaitForTool = defineTool({
  name: "window_wait_for", description: "Wait until a window whose title matches a regex appears.",
  shape: { title: z.string(), timeout_ms: z.number().int().positive().default(10_000) }, run: ({ title, timeout_ms }) => windowWaitFor(title, timeout_ms), readOnly: true,
});

export const windowTools = [
  windowListTool, windowActiveTool, windowFocusTool, windowMoveTool, windowResizeTool, windowMinimizeTool,
  windowRestoreTool, windowCloseTool, windowWaitForTool,
];
