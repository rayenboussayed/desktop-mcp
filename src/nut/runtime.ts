/**
 * Shared nut.js runtime: loading, the display guard, the fail-safe, and screen capture.
 *
 * Uses the community build `@nut-tree-fork/nut-js` (Apache-2.0, public npm, prebuilt native binaries). The official
 * `@nut-tree/nut-js` prebuilt packages sit behind a paid nutjs.dev registry; the API is the same, so change
 * `PACKAGE` and the `loader` below if you have access.
 *
 * macOS: grant your terminal Screen Recording + Accessibility permission.
 * Linux: needs an X11 display (real, or Xvfb). libnut ABORTS THE WHOLE PROCESS when it cannot open the display,
 * and reads DISPLAY from the C environment, so we check it first and the display must exist when the process starts.
 */
import type Jimp from "jimp";
import { createConnection } from "node:net";
import { currentOs } from "../platform.js";

export type Nut = typeof import("@nut-tree-fork/nut-js");

const PACKAGE = "@nut-tree-fork/nut-js";
let loader: () => Promise<Nut> = () => import("@nut-tree-fork/nut-js");
let cached: Nut | undefined;
let envSource: () => NodeJS.ProcessEnv = () => process.env;

/**
 * Test hook: replace the module loader (and drop the cache).
 * @param fn - Loader to install, or `undefined` to restore the default.
 */
export function __setNutLoader(fn: (() => Promise<Nut>) | undefined): void {
  loader = fn ?? (() => import("@nut-tree-fork/nut-js"));
  cached = undefined;
}

/**
 * Test hook: where the display guard reads `DISPLAY` from (never mutate the real environment next to native code).
 * @param env - Environment to inspect.
 */
export function __setEnv(env: NodeJS.ProcessEnv | undefined): void {
  envSource = env ? () => env : () => process.env;
}

/**
 * Can we actually connect to the X server's unix socket? (A crashed Xvfb leaves a stale socket file behind.)
 * @param socketPath - Unix socket path.
 * @param timeoutMs - Timeout in milliseconds.
 * @param connect - Socket connect implementation.
 * @returns Whether the socket accepted a connection.
 */
export function canConnect(socketPath: string, timeoutMs = 1000, connect: typeof createConnection = createConnection): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ path: socketPath });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Linux only: refuse to touch libnut unless an X server is really reachable.
 * @param env - Environment to inspect.
 * @param platform - Platform to check.
 */
export async function assertDisplay(env: NodeJS.ProcessEnv = envSource(), platform = currentOs()): Promise<void> {
  if (platform !== "linux") return;
  const display = env.DISPLAY;
  if (!display) {
    throw new Error(
      "GUI tools need an X11 display, but DISPLAY is not set. Run inside a desktop session, or under a virtual " +
        "display (e.g. `xvfb-run omcps --allow-all`). Wayland-only sessions are not supported.",
    );
  }
  const local = /^:(\d+)(\.\d+)?$/.exec(display);
  if (local && !(await canConnect(`/tmp/.X11-unix/X${local[1]}`))) {
    throw new Error(
      `GUI tools need an X11 display, but nothing is accepting connections on DISPLAY=${display} ` +
        "(no X server, or it crashed and left a stale socket). Start Xvfb or fix DISPLAY.",
    );
  }
}

/**
 * The loaded nut.js module, after the display guard.
 * @returns The nut.js runtime.
 */
export async function nut(): Promise<Nut> {
  await assertDisplay();
  if (cached) return cached;
  try {
    cached = await loader();
  } catch (e) {
    throw new Error(`GUI tools need ${PACKAGE}: npm install ${PACKAGE} (${(e as Error).message})`, { cause: e });
  }
  cached.mouse.config.autoDelayMs = 100;
  cached.mouse.config.mouseSpeed = 3000;
  return cached;
}

/**
 * Abort when the pointer sits in a screen corner (the pyautogui-style fail-safe).
 * @param n - Nut.js runtime instance.
 */
export async function failsafe(n: Nut): Promise<void> {
  const [pos, w, h] = [await n.mouse.getPosition(), await n.screen.width(), await n.screen.height()];
  if ((pos.x <= 0 || pos.x >= w - 1) && (pos.y <= 0 || pos.y >= h - 1)) {
    throw new Error("fail-safe triggered: the mouse pointer is in a screen corner. Move it away to continue.");
  }
}

export interface Rect { x: number; y: number; width: number; height: number }

export interface Shot {
  jimp: Jimp;
  /** Logical (click-coordinate) screen size. */
  screenW: number;
  screenH: number;
  /** Captured pixels per logical pixel (2 on a Retina display). */
  density: number;
}

/**
 * Capture the screen, optionally cropped to a region given in LOGICAL pixels. (The fork's `screen.grab(region)`
 * ignores the region, so we crop ourselves.)
 * @param n - Nut.js runtime instance.
 * @param rect - Screen region.
 * @returns The screenshot bitmap and its pixel density.
 */
export async function grab(n: Nut, rect?: Rect): Promise<Shot> {
  const jimp = await n.imageToJimp(await n.screen.grab());
  const [screenW, screenH] = [await n.screen.width(), await n.screen.height()];
  const density = jimp.getWidth() / screenW;
  if (rect) {
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > screenW || rect.y + rect.height > screenH) {
      throw new Error(`region ${rect.width}x${rect.height}+${rect.x}+${rect.y} is outside the ${screenW}x${screenH} screen`);
    }
    jimp.crop(Math.round(rect.x * density), Math.round(rect.y * density), Math.round(rect.width * density), Math.round(rect.height * density));
  }
  return { jimp, screenW, screenH, density };
}

/**
 * Optional `x y width height` tool arguments -> a Rect (all four or none).
 * @param a - Optional geometry arguments (`x`, `y`, `width`, `height`).
 * @param a.x - X coordinate of the region.
 * @param a.y - Y coordinate of the region.
 * @param a.width - Width of the region.
 * @param a.height - Height of the region.
 * @returns The rectangle, or `undefined` when no geometry was supplied.
 */
export function rectOf(a: { x?: number; y?: number; width?: number; height?: number }): Rect | undefined {
  const given = [a.x, a.y, a.width, a.height].filter((v) => v !== undefined).length;
  if (given === 0) return undefined;
  if (given !== 4) throw new Error("a region needs all of x, y, width and height");
  return { x: a.x as number, y: a.y as number, width: a.width as number, height: a.height as number };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
