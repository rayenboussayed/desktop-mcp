import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import type Jimp from "jimp";
import {
  __setEnv,
  __setExternalCapture,
  __setNutLoader,
  captureExternal,
  grab,
  isWayland,
  nut,
} from "../../src/nut/runtime.js";

const mkJimp = (w: number, h: number) => ({
  getWidth: () => w,
  getHeight: () => h,
  crop: () => undefined,
  getBufferAsync: async () => Buffer.from([]),
  getPixelColor: () => 0,
} as unknown as Jimp);

const mkShot = (w: number, h: number) => ({
  jimp: mkJimp(w, h),
  screenW: w,
  screenH: h,
  density: 1,
});

describe("nut runtime capture", () => {
  it("detects Wayland sessions", () => {
    expect(isWayland({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(isWayland({ XDG_SESSION_TYPE: "Wayland" })).toBe(true);
    expect(isWayland({ DISPLAY: ":0", WAYLAND_DISPLAY: "   " })).toBe(false);
    expect(isWayland({ DISPLAY: ":0" })).toBe(false);
  });

  it("captures through the override on Wayland", async () => {
    const shot = mkShot(100, 50);
    __setExternalCapture(async () => shot);
    __setEnv({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" });
    try {
      expect(await grab({} as never, { x: 1, y: 2, width: 3, height: 4 } as never)).toBe(shot);
    } finally {
      __setExternalCapture(undefined);
      __setEnv(undefined);
    }
  });

  it("captures natively on X11", async () => {
    const jimp = mkJimp(20, 20);
    const native = { imageToJimp: async () => jimp, screen: { grab: async () => ({}), width: async () => 20, height: async () => 20 } };
    __setNutLoader(async () => native as never);
    __setEnv({ DISPLAY: ":0" });
    try {
      const shot = await grab(await nut(), { x: 1, y: 1, width: 5, height: 5 } as never);
      expect(shot.density).toBe(1);
      expect(shot.screenW).toBe(20);
    } finally {
      __setNutLoader(undefined);
      __setEnv(undefined);
    }
  });

  it("rejects out-of-bounds regions natively", async () => {
    const jimp = mkJimp(10, 10);
    const native = { imageToJimp: async () => jimp, screen: { grab: async () => ({}), width: async () => 10, height: async () => 10 } };
    __setNutLoader(async () => native as never);
    __setEnv({ DISPLAY: ":0" });
    try {
      await expect(grab(await nut(), { x: 5, y: 5, width: 10, height: 10 } as never)).rejects.toThrow(/outside the/);
    } finally {
      __setNutLoader(undefined);
      __setEnv(undefined);
    }
  });

  it("falls back to external capture on native failure", async () => {
    const shot = mkShot(8, 6);
    const native = { imageToJimp: async () => { throw new Error("native boom"); }, screen: { grab: async () => { throw new Error("native boom"); }, width: async () => 8, height: async () => 6 } };
    __setNutLoader(async () => native as never);
    __setExternalCapture(async () => shot);
    __setEnv({ DISPLAY: ":0" });
    try {
      await expect(grab(await nut())).resolves.toBe(shot);
    } finally {
      __setNutLoader(undefined);
      __setExternalCapture(undefined);
      __setEnv(undefined);
    }
  });

  it("throws when both native and fallback fail", async () => {
    const native = { imageToJimp: async () => { throw new Error("native boom"); }, screen: { grab: async () => { throw new Error("native boom"); }, width: async () => 1, height: async () => 1 } };
    __setNutLoader(async () => native as never);
    __setExternalCapture(async () => { throw new Error("fallback boom"); });
    __setEnv({ DISPLAY: ":0" });
    try {
      await expect(grab(await nut())).rejects.toThrow(/fallback: fallback boom/);
    } finally {
      __setNutLoader(undefined);
      __setExternalCapture(undefined);
      __setEnv(undefined);
    }
  });

  it("throws on Wayland when the external capture fails", async () => {
    __setExternalCapture(async () => { throw new Error("external boom"); });
    __setEnv({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" });
    try {
      await expect(grab({} as never)).rejects.toThrow(/screen capture failed on this Wayland session/);
    } finally {
      __setExternalCapture(undefined);
      __setEnv(undefined);
    }
  });

  it("exercises the real external capture path", async () => {
    // Only run where spectacle is actually installed; otherwise skip but keep file healthy.
    let available = true;
    try {
      execFileSync("spectacle", ["--version"], { stdio: "ignore" });
    } catch {
      available = false;
    }
    if (!available) return;
    __setEnv({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" });
    try {
      const shot = await captureExternal();
      expect(shot.screenW).toBeGreaterThan(0);
      expect(shot.screenH).toBeGreaterThan(0);
      const withRegion = await captureExternal({ x: 0, y: 0, width: 2, height: 2 });
      expect(withRegion.jimp.getWidth()).toBe(2);
      // out-of-bounds branch
      await expect(captureExternal({ x: 0, y: 0, width: shot.screenW + 10, height: 1 })).rejects.toThrow(/outside the/);
    } finally {
      __setEnv(undefined);
    }
  });

  it("returns the injected shot from captureExternal", async () => {
    const shot = mkShot(3, 3);
    __setExternalCapture(async () => shot);
    try {
      expect(await captureExternal()).toBe(shot);
    } finally {
      __setExternalCapture(undefined);
    }
  });
});
