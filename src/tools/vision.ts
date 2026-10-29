/**
 * Screen understanding tools: image matching, OCR, AI location, recording and plugin status. These are the
 * open-source counterparts of nut.js' plugin-based features (see src/plugins/status.ts for the full mapping).
 */
import { readFile } from "node:fs/promises";
import type Jimp from "jimp";
import { z } from "zod";
import { grab, nut, rectOf, sleep, type Nut, type Rect } from "../nut/runtime.js";
import { resolveUserPath } from "../platform.js";
import { findTemplateScaled, type Match } from "../plugins/matcher.js";
import { findColorRegions, parseColor } from "../plugins/color.js";
import { findText, recognize, type TextHit, type TextMatchMode } from "../plugins/ocr.js";
import { registerProviders } from "../plugins/providers.js";
import { record } from "../plugins/recorder.js";
import { formatStatus, pluginStatus } from "../plugins/status.js";
import { defineTool } from "./base.js";
import { click, regionShape, type ButtonName } from "./gui.js";
import { mkdir } from "node:fs/promises";

let providersRegistered = false;
/**
 * Register the open-source image/text/window finders with nut.js so its native `screen.find` works too.
 * @param n - Nut.js module or runtime instance.
 */
export function ensureProviders(n: Nut): void {
  if (providersRegistered) return;
  registerProviders(n);
  providersRegistered = true;
}
/** Test hook. */
export function __resetProviders(): void {
  providersRegistered = false;
}

interface Located { x: number; y: number; width: number; height: number; cx: number; cy: number; confidence: number }

const located = (m: { x: number; y: number; width: number; height: number; confidence: number }, ox: number, oy: number, d: number): Located => {
  const [x, y, width, height] = [ox + m.x / d, oy + m.y / d, m.width / d, m.height / d].map((v) => Math.round(v * 10) / 10) as [number, number, number, number];
  return { x, y, width, height, cx: Math.round(x + width / 2), cy: Math.round(y + height / 2), confidence: m.confidence };
};
const line = (i: number, l: Located, extra = ""): string =>
  `match ${i + 1}: x=${l.x} y=${l.y} width=${l.width} height=${l.height} center=(${l.cx},${l.cy}) confidence=${l.confidence.toFixed(3)}${extra}`;

/**
 *
 * @param template - Template image path.
 * @param base64 - Base64-encoded image data.
 * @returns The loaded template image.
 */
async function loadTemplate(template?: string, base64?: string): Promise<Jimp> {
  const J = (await import("jimp")).default;
  if (base64) return J.read(Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
  if (!template) throw new Error("give a template file path or template_base64");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return J.read(await readFile(resolveUserPath(template)));
}

// ------------------------------------------------------------ image search
export interface ImageQuery {
  template?: string;
  template_base64?: string;
  confidence: number;
  scales: number[];
  region?: Rect;
  max: number;
}

/**
 *
 * @param q - Query parameters.
 * @returns Image matches.
 */
async function searchImage(q: ImageQuery): Promise<Located[]> {
  const n = await nut();
  ensureProviders(n);
  const needleImg = await loadTemplate(q.template, q.template_base64);
  const needles = q.scales.map((s) => {
    const j = s === 1 ? needleImg : needleImg.clone().resize(Math.max(1, Math.round(needleImg.getWidth() * s)), Math.max(1, Math.round(needleImg.getHeight() * s)));
    return { scale: s, bitmap: j.bitmap };
  });
  const { jimp, density } = await grab(n, q.region);
  const found = findTemplateScaled(jimp.bitmap, needles, { confidence: q.confidence, maxResults: q.max });
  return found.map((m: Match) => located(m, q.region?.x ?? 0, q.region?.y ?? 0, density));
}

/**
 *
 * @param q - Query parameters.
 * @returns A human-readable result.
 */
export async function findImage(q: ImageQuery): Promise<string> {
  const hits = await searchImage({ ...q, max: q.max });
  return hits.length === 0 ? "[no match]" : hits.map((h, i) => line(i, h)).join("\n");
}

/**
 *
 * @param q - Query parameters.
 * @param timeoutMs - Timeout in milliseconds.
 * @param intervalMs - Polling interval in milliseconds.
 * @returns A human-readable result.
 */
export async function waitForImage(q: ImageQuery, timeoutMs: number, intervalMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = await searchImage({ ...q, max: 1 });
    if (hits[0]) return line(0, hits[0]);
    if (Date.now() >= deadline) throw new Error(`the image did not appear within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

/**
 *
 * @param q - Query parameters.
 * @param button - Mouse button to use.
 * @param clicks - Number of clicks.
 * @param dx - Horizontal offset in pixels.
 * @param dy - Vertical offset in pixels.
 * @returns A human-readable result.
 */
export async function clickImage(q: ImageQuery, button: ButtonName, clicks: number, dx: number, dy: number): Promise<string> {
  const hit = (await searchImage({ ...q, max: 1 }))[0];
  if (!hit) return "[no match: nothing clicked]";
  return `${line(0, hit)}\n${await click(hit.cx + dx, hit.cy + dy, button, clicks)}`;
}

// ------------------------------------------------------------------- OCR
export interface OcrQuery { region?: Rect; lang: string; scale: number }

/**
 *
 * @param q - Query parameters.
 * @returns The OCR result and a coordinate mapper.
 */
async function readScreen(q: OcrQuery): Promise<{ result: Awaited<ReturnType<typeof recognize>>; map: (h: { x: number; y: number; width: number; height: number; confidence: number }) => Located }> {
  const n = await nut();
  ensureProviders(n);
  const { jimp, density } = await grab(n, q.region);
  if (q.scale !== 1) jimp.resize(Math.round(jimp.getWidth() * q.scale), Math.round(jimp.getHeight() * q.scale));
  const result = await recognize(await jimp.getBufferAsync("image/png"), q.lang);
  return { result, map: (h) => located(h, q.region?.x ?? 0, q.region?.y ?? 0, density * q.scale) };
}

/**
 *
 * @param q - Query parameters.
 * @param format - Output format.
 * @returns A human-readable result.
 */
export async function readText(q: OcrQuery, format: "text" | "words"): Promise<string> {
  const { result, map } = await readScreen(q);
  if (format === "text") return result.text.trim() === "" ? "[no text found]" : result.text.trim();
  if (result.words.length === 0) return "[no text found]";
  return ["text\tx\ty\twidth\theight\tconfidence", ...result.words.map((w) => { const l = map(w); return `${w.text}\t${l.x}\t${l.y}\t${l.width}\t${l.height}\t${w.confidence.toFixed(2)}`; })].join("\n");
}

/**
 *
 * @param text - Text to find.
 * @param mode - Text matching mode.
 * @param q - Query parameters.
 * @returns Text hits and their screen positions.
 */
async function searchText(text: string, mode: TextMatchMode, q: OcrQuery): Promise<{ hit: TextHit; at: Located }[]> {
  const { result, map } = await readScreen(q);
  return findText(result, text, mode).map((hit) => ({ hit, at: map(hit) }));
}

/**
 *
 * @param text - Text to find.
 * @param mode - Text matching mode.
 * @param q - Query parameters.
 * @param max - Maximum number of matches.
 * @returns A human-readable result.
 */
export async function findOnScreenText(text: string, mode: TextMatchMode, q: OcrQuery, max: number): Promise<string> {
  const hits = (await searchText(text, mode, q)).slice(0, max);
  return hits.length === 0 ? "[no match]" : hits.map((h, i) => line(i, h.at, ` text=${JSON.stringify(h.hit.text)}`)).join("\n");
}

/**
 *
 * @param text - Text to find.
 * @param mode - Text matching mode.
 * @param q - Query parameters.
 * @param timeoutMs - Timeout in milliseconds.
 * @param intervalMs - Polling interval in milliseconds.
 * @returns A human-readable result.
 */
export async function waitForText(text: string, mode: TextMatchMode, q: OcrQuery, timeoutMs: number, intervalMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = (await searchText(text, mode, q))[0];
    if (h) return line(0, h.at, ` text=${JSON.stringify(h.hit.text)}`);
    if (Date.now() >= deadline) throw new Error(`the text did not appear within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

/**
 *
 * @param text - Text to find.
 * @param mode - Text matching mode.
 * @param q - Query parameters.
 * @param occurrence - One-based occurrence to click.
 * @param button - Mouse button to use.
 * @param clicks - Number of clicks.
 * @returns A human-readable result.
 */
export async function clickText(text: string, mode: TextMatchMode, q: OcrQuery, occurrence: number, button: ButtonName, clicks: number): Promise<string> {
  const hit = (await searchText(text, mode, q))[occurrence - 1];
  if (!hit) return "[no match: nothing clicked]";
  return `${line(0, hit.at, ` text=${JSON.stringify(hit.hit.text)}`)}\n${await click(hit.at.cx, hit.at.cy, button, clicks)}`;
}

// ------------------------------------------------------------------ colour
/**
 *
 * @param color - Colour to match.
 * @param tolerance - Maximum per-channel colour difference.
 * @param minPixels - Minimum region size in pixels.
 * @param max - Maximum number of matches.
 * @param region - Screen region.
 * @returns A human-readable result.
 */
export async function findColor(color: string, tolerance: number, minPixels: number, max: number, region?: Rect): Promise<string> {
  const rgb = parseColor(color);
  const n = await nut();
  const { jimp, density } = await grab(n, region);
  const hits = findColorRegions(jimp.bitmap, rgb, tolerance, minPixels, max);
  if (hits.length === 0) return "[no match]";
  return hits.map((h, i) => line(i, located({ ...h, confidence: 1 }, region?.x ?? 0, region?.y ?? 0, density)).replace(/ confidence=\S+$/, ` pixels=${h.pixels}`)).join("\n");
}

// ---------------------------------------------------------------- record
/**
 *
 * @param outDir - Directory for recorded frames.
 * @param seconds - Recording duration in seconds.
 * @param fps - Frames per second.
 * @param region - Screen region.
 * @param video - Whether to encode an MP4 video.
 * @returns A human-readable result.
 */
async function recordScreen(outDir: string, seconds: number, fps: number, region: Rect | undefined, video: boolean): Promise<string> {
  const dir = resolveUserPath(outDir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(dir, { recursive: true });
  const r = await record(dir, seconds, fps, region, video);
  return `recorded ${r.frames} frames to ${r.dir}${r.video ? `; video: ${r.video}` : ""}${r.note ? `; ${r.note}` : ""}`;
}

// ------------------------------------------------------------------- tools
const imageShape = {
  template: z.string().optional().describe("Path of a PNG/JPEG of the thing to find."),
  template_base64: z.string().optional().describe("The template as base64 (alternative to a file)."),
  confidence: z.number().min(0).max(1).default(0.9),
  scales: z.array(z.number().positive()).min(1).default([1]).describe("Template scale factors to try, e.g. [0.75, 1, 1.25]."),
  ...regionShape,
};
const textShape = {
  ...regionShape,
  lang: z.string().default("eng"),
  scale: z.number().min(0.25).max(4).default(1).describe("Upscale factor before OCR; 2 helps with small text."),
};
const mode = z.enum(["exact", "contains", "fuzzy"]).default("contains");
const btn = z.enum(["left", "right", "middle"]).default("left");
type ImageArgs = { template?: string; template_base64?: string; confidence: number; scales: number[]; x?: number; y?: number; width?: number; height?: number };
type TextArgs = { x?: number; y?: number; width?: number; height?: number; lang: string; scale: number };
const iq = (a: ImageArgs, max = 1): ImageQuery => ({ template: a.template, template_base64: a.template_base64, confidence: a.confidence, scales: a.scales, region: rectOf(a), max });
const oq = (a: TextArgs): OcrQuery => ({ region: rectOf(a), lang: a.lang, scale: a.scale });

const findImageTool = defineTool({ name: "screen_find_image", description: "Find where an image (a button, icon, ...) appears on screen. Returns screen coordinates and confidence.", shape: imageShape, run: (a) => findImage(iq(a)), readOnly: true });
const findImagesTool = defineTool({ name: "screen_find_images", description: "Find every place an image appears on screen.", shape: { ...imageShape, max_results: z.number().int().positive().default(20) }, run: (a) => findImage(iq(a, a.max_results)), readOnly: true });
const waitForImageTool = defineTool({ name: "screen_wait_for_image", description: "Wait until an image appears on screen.", shape: { ...imageShape, timeout_ms: z.number().int().positive().default(10_000), interval_ms: z.number().int().positive().default(500) }, run: (a) => waitForImage(iq(a), a.timeout_ms, a.interval_ms), readOnly: true });
const clickImageTool = defineTool({ name: "click_image", description: "Find an image on screen and click its centre (optionally offset).", shape: { ...imageShape, button: btn, clicks: z.number().int().min(1).default(1), offset_x: z.number().int().default(0), offset_y: z.number().int().default(0) }, run: (a) => clickImage(iq(a), a.button, a.clicks, a.offset_x, a.offset_y), risky: true });
const readTextTool = defineTool({ name: "screen_read_text", description: "Read the text visible on screen (OCR). format=words adds each word's screen coordinates.", shape: { ...textShape, format: z.enum(["text", "words"]).default("text") }, run: (a) => readText(oq(a), a.format), readOnly: true });
const findTextTool = defineTool({ name: "screen_find_text", description: "Find a word or phrase on screen with OCR. Returns screen coordinates.", shape: { ...textShape, text: z.string(), match: mode, max_results: z.number().int().positive().default(10) }, run: (a) => findOnScreenText(a.text, a.match, oq(a), a.max_results), readOnly: true });
const waitForTextTool = defineTool({ name: "screen_wait_for_text", description: "Wait until text appears on screen.", shape: { ...textShape, text: z.string(), match: mode, timeout_ms: z.number().int().positive().default(10_000), interval_ms: z.number().int().positive().default(1000) }, run: (a) => waitForText(a.text, a.match, oq(a), a.timeout_ms, a.interval_ms), readOnly: true });
const clickTextTool = defineTool({ name: "click_text", description: "Find text on screen with OCR and click its centre.", shape: { ...textShape, text: z.string(), match: mode, occurrence: z.number().int().positive().default(1), button: btn, clicks: z.number().int().min(1).default(1) }, run: (a) => clickText(a.text, a.match, oq(a), a.occurrence, a.button, a.clicks), risky: true });
export const findColorTool = defineTool({ name: "screen_find_color", description: "Find regions of a colour on screen (e.g. '#ff0000'), largest first. Local pixel search, no network.", shape: { color: z.string(), tolerance: z.number().int().min(0).max(255).default(10), min_pixels: z.number().int().positive().default(20), max_results: z.number().int().positive().default(10), ...regionShape }, run: ({ color, tolerance, min_pixels, max_results, ...r }) => findColor(color, tolerance, min_pixels, max_results, rectOf(r)), readOnly: true });
export const recordTool = defineTool({ name: "screen_record", description: "Record the screen as PNG frames (and an MP4 when ffmpeg is installed). Max 60 s at 10 fps.", shape: { out_dir: z.string(), duration_seconds: z.number().positive().default(3), fps: z.number().positive().default(2), video: z.boolean().default(true), ...regionShape }, run: ({ out_dir, duration_seconds, fps, video, ...r }) => recordScreen(out_dir, duration_seconds, fps, rectOf(r), video) });
export const pluginStatusTool = defineTool({ name: "plugin_status", description: "Which nut.js plugin features are available here, which tool provides each, and which are unavailable.", shape: {}, run: (): string => formatStatus(pluginStatus()), readOnly: true });

export const visionTools = [
  findImageTool, findImagesTool, waitForImageTool, clickImageTool, readTextTool, findTextTool, waitForTextTool, clickTextTool,
  findColorTool, recordTool, pluginStatusTool,
];
