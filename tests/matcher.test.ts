import { describe, expect, it } from "vitest";
import { findTemplate, findTemplateScaled, type Bitmap } from "../src/plugins/matcher.js";

/**
 * Build a bitmap from a per-pixel function returning [r,g,b,a?].
 * @param w - Bitmap width.
 * @param h - Bitmap height.
 * @param fn - Pixel colour function.
 * @returns The constructed bitmap.
 */
const bmp = (w: number, h: number, fn: (x: number, y: number) => number[]): Bitmap => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r = 0, g = 0, b = 0, a = 255] = fn(x, y); data.set([r, g, b, a], (y * w + x) * 4); }
  return { width: w, height: h, data };
};
// a patterned background so nothing matches by accident, and a distinctive 8x8 sprite
const noise = (x: number, y: number): number[] => [(x * 37 + y * 11) % 200, (x * 13 + y * 29) % 200, (x * 7 + y * 53) % 200];
const sprite = bmp(8, 8, (x, y) => [x * 30, y * 30, (x + y) * 15]);
const paste = (hay: Bitmap, s: Bitmap, ox: number, oy: number): Bitmap => {
  const out = { ...hay, data: hay.data.slice() };
  for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) out.data.set(s.data.subarray((y * s.width + x) * 4, (y * s.width + x) * 4 + 4), ((oy + y) * hay.width + ox + x) * 4);
  return out;
};
const field = (): Bitmap => bmp(80, 60, noise);

describe("template matcher", () => {
  it("finds an exact copy at the right position with confidence 1", () => {
    const [m] = findTemplate(paste(field(), sprite, 33, 21), sprite);
    expect(m).toMatchObject({ x: 33, y: 21, width: 8, height: 8 });
    expect(m?.confidence).toBeCloseTo(1, 5);
  });

  it("returns nothing when it is not there", () => {
    expect(findTemplate(field(), sprite)).toEqual([]);
  });

  it("tolerates noise according to the confidence", () => {
    const noisy = bmp(8, 8, (x, y) => [x * 30 + ((x + y) % 2 ? 30 : 0), y * 30, (x + y) * 15]); // ~2% error (32 px x 30 of 64 x 3 x 255)
    const hay = paste(field(), noisy, 10, 10);
    expect(findTemplate(hay, sprite, { confidence: 0.99 })).toEqual([]);
    const [m] = findTemplate(hay, sprite, { confidence: 0.95 });
    expect(m).toMatchObject({ x: 10, y: 10 });
    expect(m?.confidence).toBeLessThan(1);
    expect(m?.confidence).toBeGreaterThan(0.95);
  });

  it("ignores transparent pixels of the template (alpha mask)", () => {
    const masked = bmp(8, 8, (x, y) => (x < 2 ? [0, 0, 0, 0] : [x * 30, y * 30, (x + y) * 15, 255])); // left 2 columns transparent
    const hay = paste(field(), sprite, 40, 30); // the hay has real, different pixels under the transparent part
    expect(findTemplate(hay, masked)[0]).toMatchObject({ x: 40, y: 30 });
    expect(findTemplate(field(), bmp(4, 4, () => [0, 0, 0, 0]))).toEqual([]); // fully transparent: nothing to match
  });

  it("finds several copies, best first, and merges neighbouring hits", () => {
    let hay = paste(field(), sprite, 5, 5);
    hay = paste(hay, sprite, 50, 40);
    const all = findTemplate(hay, sprite, { maxResults: 5, confidence: 0.9 });
    expect(all.map((m) => [m.x, m.y]).sort()).toEqual([[5, 5], [50, 40]]);
    expect(findTemplate(hay, sprite, { maxResults: 1 })).toHaveLength(1);
  });

  it("degenerate sizes", () => {
    expect(findTemplate(bmp(4, 4, noise), bmp(8, 8, noise))).toEqual([]);
    expect(findTemplate(field(), { width: 0, height: 0, data: new Uint8Array(0) })).toEqual([]);
  });

  it("searches several template scales and reports which one matched", () => {
    const big = bmp(16, 16, (x, y) => [Math.floor(x / 2) * 30, Math.floor(y / 2) * 30, (Math.floor(x / 2) + Math.floor(y / 2)) * 15]); // sprite at 2x
    const hay = paste(field(), big, 20, 12);
    const hit = findTemplateScaled(hay, [{ scale: 1, bitmap: sprite }, { scale: 2, bitmap: big }], { confidence: 0.98 });
    expect(hit[0]).toMatchObject({ x: 20, y: 12, width: 16, height: 16, scale: 2 });
    expect(findTemplateScaled(field(), [{ scale: 1, bitmap: sprite }])).toEqual([]);
  });
});
