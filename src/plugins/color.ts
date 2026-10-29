/**
 * Colour search: find regions of a given colour. Pure local pixel work; the stand-in for nut.js' colour finder with
 * connected-region grouping so "the red button" comes back as one rectangle, not a million pixels.
 */
import type { Bitmap } from "./matcher.js";

export type RGB = [number, number, number];

export interface ColorRegion { x: number; y: number; width: number; height: number; pixels: number }

/**
 * `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `r,g,b`.
 * @param text - Colour string to parse.
 * @returns The parsed RGB colour.
 */
export function parseColor(text: string): RGB {
  const t = text.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return [...(m[1] as string)].map((c) => parseInt(c + c, 16)) as RGB;
  m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt((m?.[1] as string).slice(i, i + 2), 16)) as RGB;
  m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(t) ?? /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(t);
  if (m && [m[1], m[2], m[3]].every((v) => Number(v) <= 255)) return [Number(m[1]), Number(m[2]), Number(m[3])];
  throw new Error(`cannot read colour ${JSON.stringify(text)}: use #rrggbb, #rgb or rgb(r, g, b)`);
}

/**
 * Connected regions (4-neighbourhood) of pixels within `tolerance` of `color`, largest first.
 * @param bmp - Bitmap to scan.
 * @param color - RGB colour to match.
 * @param tolerance - Maximum per-channel colour difference.
 * @param minPixels - Minimum region size in pixels.
 * @param maxResults - Maximum results to return.
 * @returns Connected regions of matching pixels, largest first.
 */
export function findColorRegions(bmp: Bitmap, color: RGB, tolerance = 10, minPixels = 1, maxResults = 20): ColorRegion[] {
  const { width: w, height: h, data } = bmp;
  const near = (i: number): boolean =>
    Math.abs((data[i * 4] as number) - color[0]) <= tolerance && Math.abs((data[i * 4 + 1] as number) - color[1]) <= tolerance && Math.abs((data[i * 4 + 2] as number) - color[2]) <= tolerance;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: ColorRegion[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !near(start)) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let [x0, y0, x1, y1, n] = [w, h, 0, 0, 0];
    while (sp > 0) {
      const i = stack[--sp] as number;
      const [x, y] = [i % w, Math.floor(i / w)];
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && near(j)) {
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
    }
    if (n >= minPixels) out.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: n });
  }
  return out.sort((a, b) => b.pixels - a.pixels).slice(0, maxResults);
}
