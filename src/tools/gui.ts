/**
 * Desktop control through nut.js (https://nutjs.dev): mouse, keyboard and screen. Windows, clipboard and the
 * plugin-style features (image matching, OCR, ...) live in their own modules. See src/nut/runtime.ts for the
 * platform notes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { keyFromName, keysForChar, listKeyNames, segmentForLinux, tapKeys } from "../nut/keys.js";
import { failsafe, grab, nut, rectOf, type Nut, type Rect } from "../nut/runtime.js";
import { currentOs, resolveUserPath } from "../platform.js";
import { defineTool, type ContentBlock } from "./base.js";
import { pasteText } from "./clipboard.js";

export { __setEnv, __setNutLoader, assertDisplay } from "../nut/runtime.js";
export { keyFromName, keysForChar, segmentForLinux } from "../nut/keys.js";

const BUTTONS = { left: "LEFT", middle: "MIDDLE", right: "RIGHT" } as const;
export type ButtonName = keyof typeof BUTTONS;

// ------------------------------------------------------------- held inputs
const heldKeys = new Set<number>();
const heldButtons = new Set<number>();

/** Release every key and mouse button this process is holding down (call on shutdown). */
export async function releaseHeldInputs(): Promise<void> {
  if (heldKeys.size === 0 && heldButtons.size === 0) return;
  const n = await nut();
  try {
    for (const k of [...heldKeys]) await n.keyboard.releaseKey(k);
    for (const b of [...heldButtons]) await n.mouse.releaseButton(b);
  } finally {
    heldKeys.clear();
    heldButtons.clear();
  }
}

// ------------------------------------------------------------------ screen
const shotText = (sw: number, sh: number, scale: number, rect?: Rect): string =>
  rect
    ? `region ${rect.width}x${rect.height}+${rect.x}+${rect.y} of a ${sw}x${sh} screen; image scaled by ${scale.toFixed(3)}. ` +
      `Real screen coordinates = (${rect.x} + image_x / ${scale.toFixed(3)}, ${rect.y} + image_y / ${scale.toFixed(3)}).`
    : `screen ${sw}x${sh}; image scaled by ${scale.toFixed(3)}. Coordinates you give must be in real screen pixels (divide image coords by the scale).`;

/**
 * Capture the screen (or a region of it) as an image.
 * @param maxWidth - Maximum image width in pixels.
 * @param region - Screen region.
 * @returns Image content blocks for the model.
 */
export async function screenshot(maxWidth = 1280, region?: Rect): Promise<ContentBlock[]> {
  const n = await nut();
  const { jimp, screenW, screenH } = await grab(n, region);
  const w = jimp.getWidth();
  const h = jimp.getHeight();
  if (w > maxWidth) jimp.resize(maxWidth, Math.max(1, Math.round((h * maxWidth) / w)));
  // Scale is relative to LOGICAL pixels (what click/move expect), which differ from the captured pixels on HiDPI.
  const scale = jimp.getWidth() / (region ? region.width : screenW);
  const png = await jimp.getBufferAsync("image/png");
  return [
    { type: "text", text: shotText(screenW, screenH, scale, region) },
    { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
  ];
}

/**
 * Capture the screen (or a region) to a PNG file at full resolution.
 * @param file - Destination PNG path.
 * @param region - Screen region.
 * @returns A human-readable result.
 */
export async function screenshotSave(file: string, region?: Rect): Promise<string> {
  const n = await nut();
  const { jimp } = await grab(n, region);
  const full = resolveUserPath(file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(path.dirname(full), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(full, await jimp.getBufferAsync("image/png"));
  return `saved ${jimp.getWidth()}x${jimp.getHeight()} screenshot to ${full}`;
}

/**
 * Real screen size in pixels and the current mouse position.
 * @returns A human-readable result.
 */
export async function screenSize(): Promise<string> {
  const n = await nut();
  const [w, h, p] = [await n.screen.width(), await n.screen.height(), await n.mouse.getPosition()];
  return `screen ${w}x${h}, mouse at (${p.x},${p.y})`;
}

/**
 * RGB colour of one screen pixel.
 * @param x - X coordinate in screen pixels.
 * @param y - Y coordinate in screen pixels.
 * @returns A human-readable result.
 */
export async function colorAt(x: number, y: number): Promise<string> {
  const n = await nut();
  const { jimp, screenW, screenH, density } = await grab(n);
  if (x < 0 || y < 0 || x >= screenW || y >= screenH) throw new Error(`(${x},${y}) is outside the ${screenW}x${screenH} screen`);
  const c = (await import("jimp")).default.intToRGBA(jimp.getPixelColor(Math.floor(x * density), Math.floor(y * density)));
  const hex = [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `rgb(${c.r}, ${c.g}, ${c.b}) #${hex}`;
}

/**
 * Flash a rectangle on the screen so a human can see where the agent is looking.
 * @param rect - Screen region.
 * @param durationMs - Highlight duration in milliseconds.
 * @param opacity - Highlight opacity from 0 to 1.
 * @returns A human-readable result.
 */
export async function highlight(rect: Rect, durationMs = 500, opacity = 0.25): Promise<string> {
  const n = await nut();
  n.screen.config.highlightDurationMs = durationMs;
  n.screen.config.highlightOpacity = opacity;
  await n.screen.highlight(new n.Region(rect.x, rect.y, rect.width, rect.height));
  return `highlighted ${rect.width}x${rect.height}+${rect.x}+${rect.y} for ${durationMs} ms`;
}

// ------------------------------------------------------------------- mouse
/**
 *
 * @returns A human-readable result.
 */
export async function mousePosition(): Promise<string> {
  const n = await nut();
  const p = await n.mouse.getPosition();
  return `(${p.x},${p.y})`;
}

/**
 *
 * @param x - X coordinate in screen pixels.
 * @param y - Y coordinate in screen pixels.
 * @param button - Mouse button to use.
 * @param clicks - Number of clicks.
 * @returns A human-readable result.
 */
export async function click(x: number, y: number, button: ButtonName = "left", clicks = 1): Promise<string> {
  const n = await nut();
  await failsafe(n);
  // eslint-disable-next-line security/detect-object-injection
  const btn = n.Button[BUTTONS[button]];
  await n.mouse.setPosition(new n.Point(x, y));
  if (clicks === 2) await n.mouse.doubleClick(btn);
  else for (let i = 0; i < clicks; i++) await n.mouse.click(btn);
  return `clicked (${x},${y}) ${button} x${clicks}`;
}

/**
 *
 * @param x - X coordinate in screen pixels.
 * @param y - Y coordinate in screen pixels.
 * @returns A human-readable result.
 */
export async function moveMouse(x: number, y: number): Promise<string> {
  const n = await nut();
  await failsafe(n);
  await n.mouse.move(n.straightTo(new n.Point(x, y)));
  return `moved to (${x},${y})`;
}

/**
 *
 * @param dx - Horizontal offset in pixels.
 * @param dy - Vertical offset in pixels.
 * @returns A human-readable result.
 */
export async function moveRelative(dx: number, dy: number): Promise<string> {
  const n = await nut();
  await failsafe(n);
  const p = await n.mouse.getPosition();
  const [w, h] = [await n.screen.width(), await n.screen.height()];
  const to = new n.Point(Math.min(Math.max(p.x + dx, 0), w - 1), Math.min(Math.max(p.y + dy, 0), h - 1));
  await n.mouse.move(n.straightTo(to));
  return `moved by (${dx},${dy}) to (${to.x},${to.y})`;
}

/**
 *
 * @param button - Mouse button to use.
 * @returns A human-readable result.
 */
export async function mousePress(button: ButtonName = "left"): Promise<string> {
  const n = await nut();
  await failsafe(n);
  // eslint-disable-next-line security/detect-object-injection
  const btn = n.Button[BUTTONS[button]];
  await n.mouse.pressButton(btn);
  heldButtons.add(btn);
  return `${button} button pressed (call mouse_release to let go)`;
}

/**
 *
 * @param button - Mouse button to use.
 * @returns A human-readable result.
 */
export async function mouseRelease(button: ButtonName = "left"): Promise<string> {
  const n = await nut();
  // eslint-disable-next-line security/detect-object-injection
  const btn = n.Button[BUTTONS[button]];
  await n.mouse.releaseButton(btn);
  heldButtons.delete(btn);
  return `${button} button released`;
}

/**
 * Press at the start point, move in a straight line, release at the end point.
 * @param fx - Starting X coordinate.
 * @param fy - Starting Y coordinate.
 * @param tx - Ending X coordinate.
 * @param ty - Ending Y coordinate.
 * @param button - Mouse button to use.
 * @returns A human-readable result.
 */
export async function mouseDrag(fx: number, fy: number, tx: number, ty: number, button: ButtonName = "left"): Promise<string> {
  const n = await nut();
  await failsafe(n);
  // eslint-disable-next-line security/detect-object-injection
  const btn = n.Button[BUTTONS[button]];
  await n.mouse.setPosition(new n.Point(fx, fy));
  await n.mouse.pressButton(btn);
  try {
    await n.mouse.move(n.straightTo(new n.Point(tx, ty)));
  } finally {
    await n.mouse.releaseButton(btn);
  }
  return `dragged (${fx},${fy}) -> (${tx},${ty}) with the ${button} button`;
}

/**
 * Scroll the mouse wheel: positive = up (or right when horizontal).
 * @param amount - Number of wheel steps.
 * @param horizontal - Whether to scroll horizontally.
 * @returns A human-readable result.
 */
export async function scroll(amount: number, horizontal = false): Promise<string> {
  const n = await nut();
  await failsafe(n);
  if (horizontal) {
    // nut.js/libnut has the horizontal wheel reversed on X11: scrollRight sends button 6, which is wheel-LEFT
    // (6 = left, 7 = right). Verified with xev; compensate on Linux only.
    const [right, left] = currentOs() === "linux" ? [n.mouse.scrollLeft, n.mouse.scrollRight] : [n.mouse.scrollRight, n.mouse.scrollLeft];
    if (amount > 0) await right.call(n.mouse, amount);
    else if (amount < 0) await left.call(n.mouse, -amount);
  } else if (amount > 0) await n.mouse.scrollUp(amount);
  else if (amount < 0) await n.mouse.scrollDown(-amount);
  return `scrolled ${horizontal ? "horizontally " : ""}${amount}`;
}

// ---------------------------------------------------------------- keyboard
/**
 *
 * @param n - Nut.js module or runtime instance.
 * @param text - Text to type.
 * @param delayMs - Delay between key events in milliseconds.
 */
async function typeOnLinux(n: Nut, text: string, delayMs: number): Promise<void> {
  for (const seg of segmentForLinux(text)) {
    if (seg.kind === "paste") {
      await pasteText(seg.text);
      continue;
    }
    for (const ch of seg.text) {
      const { key, shift } = keysForChar(ch) as { key: string; shift: boolean };
      await tapKeys(shift ? ["shift", key] : [key], delayMs, n);
    }
  }
}

/**
 *
 * @param text - Text to type.
 * @param interval - Delay between keystrokes in seconds.
 * @returns A human-readable result.
 */
export async function typeText(text: string, interval = 0.02): Promise<string> {
  const n = await nut();
  await failsafe(n);
  n.keyboard.config.autoDelayMs = Math.round(interval * 1000);
  if (currentOs() === "linux") await typeOnLinux(n, text, Math.round(interval * 1000));
  else await n.keyboard.type(text);
  return `typed ${Array.from(text.replace(/\r\n?/g, "\n")).length} chars`;
}

/**
 * One key ('enter') or a combo (['ctrl','c']).
 * @param keys - Key names to use.
 * @returns A human-readable result.
 */
export async function pressKey(keys: string[]): Promise<string> {
  const n = await nut();
  await failsafe(n);
  await tapKeys(keys, 20, n);
  return `pressed ${keys.join("+")}`;
}

/**
 * Hold keys down until `keyUp` (they are also released when the server shuts down).
 * @param keys - Key names to use.
 * @returns A human-readable result.
 */
export async function keyDown(keys: string[]): Promise<string> {
  const n = await nut();
  await failsafe(n);
  const codes = keys.map((k) => keyFromName(n, k));
  n.keyboard.config.autoDelayMs = 20;
  for (const c of codes) {
    await n.keyboard.pressKey(c);
    heldKeys.add(c);
  }
  return `holding ${keys.join("+")} (call key_up to release)`;
}

/**
 * Release the given keys, or every key held with `keyDown` when none are named.
 * @param keys - Key names to use.
 * @returns A human-readable result.
 */
export async function keyUp(keys?: string[]): Promise<string> {
  const n = await nut();
  const codes = keys && keys.length > 0 ? keys.map((k) => keyFromName(n, k)) : [...heldKeys];
  for (const c of [...codes].reverse()) {
    await n.keyboard.releaseKey(c);
    heldKeys.delete(c);
  }
  return codes.length === 0 ? "no keys were held" : `released ${keys && keys.length > 0 ? keys.join("+") : "all held keys"}`;
}

/**
 *
 * @returns A human-readable result.
 */
export async function listKeys(): Promise<string> {
  return listKeyNames(await nut()).join(", ");
}

// ------------------------------------------------------------------- tools
const xy = { x: z.number().int(), y: z.number().int() };
const button = z.enum(["left", "right", "middle"]).default("left");
export const regionShape = {
  x: z.number().int().optional().describe("Region left edge (all four of x, y, width, height or none)."),
  y: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
};

export const screenshotTool = defineTool({
  name: "screenshot",
  description: "Capture the screen (or a region of it) as an image. Click coordinates must be real screen pixels.",
  shape: { max_width: z.number().int().default(1280), ...regionShape },
  run: ({ max_width, ...r }) => screenshot(max_width, rectOf(r)), readOnly: true,
});
export const screenshotSaveTool = defineTool({
  name: "screenshot_save", description: "Save a screenshot (full resolution, PNG) to a file.",
  shape: { path: z.string(), ...regionShape }, run: ({ path: p, ...r }) => screenshotSave(p, rectOf(r)),
});
export const screenSizeTool = defineTool({ name: "screen_size", description: "Real screen size in pixels and the current mouse position.", shape: {}, run: () => screenSize(), readOnly: true });
export const colorAtTool = defineTool({ name: "screen_color_at", description: "RGB colour of the screen pixel at (x, y).", shape: xy, run: ({ x, y }) => colorAt(x, y), readOnly: true });
export const highlightTool = defineTool({
  name: "screen_highlight", description: "Flash a rectangle on the screen so a person can see what the agent is looking at.",
  shape: { x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive(), duration_ms: z.number().int().positive().default(500), opacity: z.number().min(0).max(1).default(0.25) },
  run: ({ duration_ms, opacity, ...r }) => highlight(r, duration_ms, opacity), readOnly: true,
});
export const mousePositionTool = defineTool({ name: "mouse_position", description: "Current mouse pointer position.", shape: {}, run: () => mousePosition(), readOnly: true });
export const clickTool = defineTool({ name: "click", description: "Click at screen coordinates (clicks=2 for a double click).", shape: { ...xy, button, clicks: z.number().int().min(1).default(1) }, run: ({ x, y, button: b, clicks }) => click(x, y, b, clicks), risky: true });
export const moveMouseTool = defineTool({ name: "move_mouse", description: "Move the mouse pointer to screen coordinates. Do not park it in a screen corner: that arms the human fail-safe and blocks further input until a person moves it.", shape: xy, run: ({ x, y }) => moveMouse(x, y) });
export const moveRelativeTool = defineTool({ name: "mouse_move_relative", description: "Move the mouse pointer by an offset from where it is now.", shape: { dx: z.number().int(), dy: z.number().int() }, run: ({ dx, dy }) => moveRelative(dx, dy) });
export const mousePressTool = defineTool({ name: "mouse_press", description: "Press and HOLD a mouse button (use mouse_release to let go).", shape: { button }, run: ({ button: b }) => mousePress(b), risky: true });
export const mouseReleaseTool = defineTool({ name: "mouse_release", description: "Release a held mouse button.", shape: { button }, run: ({ button: b }) => mouseRelease(b) });
export const mouseDragTool = defineTool({
  name: "mouse_drag", description: "Drag with the mouse: press at the start point, move to the end point, release.",
  shape: { from_x: z.number().int(), from_y: z.number().int(), to_x: z.number().int(), to_y: z.number().int(), button },
  run: ({ from_x, from_y, to_x, to_y, button: b }) => mouseDrag(from_x, from_y, to_x, to_y, b), risky: true,
});
export const scrollTool = defineTool({
  name: "scroll", description: "Scroll the mouse wheel (positive = up, or right with horizontal=true).",
  shape: { amount: z.number().int(), horizontal: z.boolean().default(false) }, run: ({ amount, horizontal }) => scroll(amount, horizontal),
});
export const typeTextTool = defineTool({ name: "type_text", description: "Type text into the focused window (any characters; non-ASCII is pasted on Linux).", shape: { text: z.string(), interval: z.number().default(0.02) }, run: ({ text, interval }) => typeText(text, interval), risky: true });
export const pressKeyTool = defineTool({ name: "press_key", description: "Press a key or hotkey combo, e.g. ['ctrl','s'] or ['enter']. See list_keys for names (incl. media keys).", shape: { keys: z.array(z.string()).min(1) }, run: ({ keys }) => pressKey(keys), risky: true });
export const keyDownTool = defineTool({ name: "key_down", description: "Press and HOLD keys (e.g. shift while clicking). Release with key_up.", shape: { keys: z.array(z.string()).min(1) }, run: ({ keys }) => keyDown(keys), risky: true });
export const keyUpTool = defineTool({ name: "key_up", description: "Release held keys (all held keys when none are named).", shape: { keys: z.array(z.string()).optional() }, run: ({ keys }) => keyUp(keys) });
export const listKeysTool = defineTool({ name: "list_keys", description: "Names accepted by press_key / key_down.", shape: {}, run: () => listKeys(), readOnly: true });

export const guiTools = [
  screenshotTool, screenshotSaveTool, screenSizeTool, colorAtTool, highlightTool, mousePositionTool, clickTool, moveMouseTool,
  moveRelativeTool, mousePressTool, mouseReleaseTool, mouseDragTool, scrollTool, typeTextTool, pressKeyTool, keyDownTool,
  keyUpTool, listKeysTool,
];
