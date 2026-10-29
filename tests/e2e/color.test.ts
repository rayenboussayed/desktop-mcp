import { describe, expect, it } from "vitest";
import { findColorRegions, parseColor } from "../../src/plugins/color.js";
import type { Bitmap } from "../../src/plugins/matcher.js";
import { callTool } from "../../src/tools/base.js";
import * as vision from "../../src/tools/vision.js";
import { listWindows, type WinInfo } from "../../src/tools/window.js";
import { afterAll, beforeAll } from "vitest";
import { haveWm, haveXterm, openWindow, stopAll } from "../x.js";

const paint = (w: number, h: number, rects: [number, number, number, number, number[]][]): Bitmap => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([0, 0, 0, 255], i * 4);
  for (const [x, y, rw, rh, c] of rects) for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) data.set([...(c as number[]), 255], (j * w + i) * 4);
  return { width: w, height: h, data };
};

describe("colour parsing", () => {
  it("accepts hex, short hex and rgb() forms", () => {
    expect(parseColor("#ff8000")).toEqual([255, 128, 0]);
    expect(parseColor(" #F80 ")).toEqual([255, 136, 0]);
    expect(parseColor("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
    expect(parseColor("10,20,30")).toEqual([10, 20, 30]);
  });
  it("rejects anything else with a helpful message", () => {
    for (const bad of ["red", "#12", "#1234567", "rgb(256,0,0)", "1,2", "", "rgb(1,2,3"]) expect(() => parseColor(bad), bad).toThrow(/cannot read colour .*#rrggbb/);
  });
});

describe("colour regions (pure)", () => {
  const img = paint(60, 40, [[5, 5, 10, 8, [255, 0, 0]], [30, 20, 20, 10, [250, 5, 3]], [40, 2, 3, 3, [255, 0, 0]]]);
  it("groups connected pixels into rectangles, largest first", () => {
    const r = findColorRegions(img, [255, 0, 0], 10);
    expect(r).toEqual([
      { x: 30, y: 20, width: 20, height: 10, pixels: 200 },
      { x: 5, y: 5, width: 10, height: 8, pixels: 80 },
      { x: 40, y: 2, width: 3, height: 3, pixels: 9 },
    ]);
  });
  it("tolerance, minimum size and result limit", () => {
    expect(findColorRegions(img, [255, 0, 0], 0).map((x) => x.pixels)).toEqual([80, 9]); // the slightly different blob needs tolerance
    expect(findColorRegions(img, [255, 0, 0], 10, 50).map((x) => x.pixels)).toEqual([200, 80]);
    expect(findColorRegions(img, [255, 0, 0], 10, 1, 1)).toHaveLength(1);
    expect(findColorRegions(img, [0, 255, 0])).toEqual([]);
  });
  it("only edge-connected pixels join (a diagonal touch does not)", () => {
    const d = paint(6, 6, [[0, 0, 1, 1, [9, 9, 9]], [1, 1, 1, 1, [9, 9, 9]]]);
    expect(findColorRegions(d, [9, 9, 9], 0)).toHaveLength(2);
  });
  it("handles regions on every image edge", () => {
    const e = paint(5, 5, [[0, 0, 5, 5, [1, 2, 3]]]);
    expect(findColorRegions(e, [1, 2, 3], 0)).toEqual([{ x: 0, y: 0, width: 5, height: 5, pixels: 25 }]);
  });
});

let red: WinInfo;
beforeAll(async () => {
  if (!haveWm || !haveXterm) return;
  await openWindow("red-win", { geometry: "30x6+120+120", bg: "#ff0000" });
  red = (await listWindows()).find((w) => w.title === "red-win") as WinInfo;
});
afterAll(() => stopAll());

describe.skipIf(!haveWm || !haveXterm)("colour search on the real screen", () => {
  it("finds the red window as one region, in screen coordinates", async () => {
    const out = await vision.findColor("#ff0000", 10, 500, 5);
    const m = /match 1: x=(\d+) y=(\d+) width=(\d+) height=(\d+) center=\((\d+),(\d+)\) pixels=(\d+)/.exec(out);
    expect(m).not.toBeNull();
    const [x, y, w, h] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3]), Number(m?.[4])];
    expect(x).toBeGreaterThanOrEqual(red.x - 2);
    expect(y).toBeGreaterThanOrEqual(red.y - 2);
    expect(x + w).toBeLessThanOrEqual(red.x + red.width + 2);
    expect(y + h).toBeLessThanOrEqual(red.y + red.height + 2);
    expect(Number(m?.[7])).toBeGreaterThan(1000);
  });
  it("restricts to a region (offsetting the result) and reports no match", async () => {
    const out = await vision.findColor("rgb(255,0,0)", 10, 20, 3, { x: red.x, y: red.y, width: 80, height: 60 });
    // eslint-disable-next-line security/detect-non-literal-regexp
    expect(out).toMatch(new RegExp(`x=${red.x} y=${red.y} `));
    expect(await vision.findColor("#12ab34", 2, 50, 3)).toBe("[no match]");
    await expect(vision.findColor("blue-ish", 5, 5, 5)).rejects.toThrow(/cannot read colour/);
  });
  it("works through the tool wrapper", async () => {
    expect(await callTool(vision.findColorTool, { color: "#ff0000" })).toContain("match 1");
    await expect(callTool(vision.findColorTool, { color: "#f00", tolerance: 300 })).rejects.toThrow();
    expect(vision.findColorTool.readOnly).toBe(true);
  });
});
