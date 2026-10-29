/** New mouse / keyboard / screen features, driven against the real X server and observed with real X clients. */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Jimp from "jimp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as gui from "../../src/tools/gui.js";
import { callTool } from "../../src/tools/base.js";
import { rectOf } from "../../src/nut/runtime.js";
import { hasBinary, sleep, tmpDir } from "../helpers.js";
import { haveX, haveXev, startXev, stopAll, type Xev } from "../x.js";

type Shot = [{ text: string }, { source: { data: string } }];
const png = (s: Shot): Buffer => Buffer.from(s[1].source.data, "base64");
const dims = (b: Buffer): [number, number] => [b.readUInt32BE(16), b.readUInt32BE(20)];

/** Park the pointer mid-screen with nut directly (the fail-safe would refuse our own tools in a corner). */
async function centerPointer(): Promise<void> {
  const n = await import("@nut-tree-fork/nut-js");
  await n.mouse.setPosition(new n.Point(640, 400));
}
afterEach(async () => { stopAll(); await gui.releaseHeldInputs(); if (haveX) await centerPointer(); });
beforeAll(() => { if (haveX) spawnSync("xsetroot", ["-solid", "#102030"]); });
afterAll(() => stopAll());

describe.skipIf(!haveXev)("mouse (observed by a real X client)", () => {
  /**
   *
   * @returns The running xev process.
   */
  async function over(): Promise<Xev> {
    const ev = await startXev();
    await gui.moveMouse(250, 250);
    await sleep(200);
    return ev;
  }

  it("reports and moves the pointer, absolutely and relatively (clamped to the screen)", async () => {
    await gui.moveMouse(400, 300);
    expect(await gui.mousePosition()).toBe("(400,300)");
    expect(await gui.moveRelative(25, -50)).toBe("moved by (25,-50) to (425,250)");
    expect(await gui.mousePosition()).toBe("(425,250)");
    expect(await gui.moveRelative(-5000, 5000)).toBe("moved by (-5000,5000) to (0,799)");
    await expect(gui.moveMouse(300, 300)).rejects.toThrow(/fail-safe/); // the pointer is now in a corner: input is refused
  });

  it("press and release hold a button until told otherwise", async () => {
    const ev = await over();
    expect(await gui.mousePress("right")).toContain("right button pressed");
    await ev.settle(200);
    expect(ev.buttons("ButtonPress")).toEqual(["3"]);
    expect(ev.buttons("ButtonRelease")).toEqual([]); // still held
    expect(await gui.mouseRelease("right")).toBe("right button released");
    await ev.settle();
    expect(ev.buttons("ButtonRelease")).toEqual(["3"]);
  });

  it("releaseHeldInputs lets go of everything held (shutdown safety net)", async () => {
    const ev = await over();
    await gui.mousePress("left");
    await gui.keyDown(["shift"]);
    await gui.releaseHeldInputs();
    await gui.releaseHeldInputs(); // nothing left: a no-op
    await ev.settle();
    expect(ev.buttons("ButtonRelease")).toEqual(["1"]);
    expect(ev.out).toContain("KeyRelease");
  });

  it("drags: press at the start, move, release at the end", async () => {
    const ev = await over();
    expect(await gui.mouseDrag(150, 150, 350, 300)).toBe("dragged (150,150) -> (350,300) with the left button");
    await ev.settle();
    expect(ev.buttons("ButtonPress")).toEqual(["1"]);
    expect(ev.buttons("ButtonRelease")).toEqual(["1"]);
    expect(ev.motions()).toBeGreaterThan(3);
    expect(await gui.mousePosition()).toBe("(350,300)");
    await gui.mouseDrag(150, 150, 160, 160, "middle");
    await ev.settle();
    expect(ev.buttons("ButtonRelease")).toEqual(["1", "2"]);
  });

  it("scrolls horizontally: positive = right = X button 7 (nut.js alone has this reversed on X11)", async () => {
    const ev = await over();
    expect(await gui.scroll(2, true)).toBe("scrolled horizontally 2");
    expect(await gui.scroll(-1, true)).toBe("scrolled horizontally -1");
    expect(await gui.scroll(0, true)).toBe("scrolled horizontally 0");
    await ev.settle();
    expect(ev.buttons("ButtonPress")).toEqual(["7", "7", "6"]);
  });

  it("tools validate arguments", async () => {
    const t = Object.fromEntries(gui.guiTools.map((x) => [x.name, x]));
    expect(await callTool(t.mouse_move_relative!, { dx: 1, dy: 1 })).toContain("moved by (1,1)");
    expect(await callTool(t.mouse_position!, {})).toMatch(/^\(\d+,\d+\)$/);
    expect(await callTool(t.scroll!, { amount: 1 })).toBe("scrolled 1");
    await expect(callTool(t.mouse_drag!, { from_x: 1, from_y: 1, to_x: "a", to_y: 1 })).rejects.toThrow();
    await expect(callTool(t.mouse_press!, { button: "side" })).rejects.toThrow();
  });
});

describe.skipIf(!haveXev)("keyboard: hold and release", () => {
  it("key_down holds modifiers across other input; key_up releases them", async () => {
    const ev = await startXev();
    await gui.moveMouse(250, 250);
    expect(await gui.keyDown(["shift"])).toBe("holding shift (call key_up to release)");
    await gui.pressKey(["a"]);
    expect(await gui.keyUp(["shift"])).toBe("released shift");
    await gui.pressKey(["a"]);
    await ev.settle();
    expect(ev.keys()).toEqual(["Shift_L", "A", "a"]);
  });

  it("key_up with no names releases everything held; with nothing held it says so", async () => {
    const ev = await startXev();
    await gui.moveMouse(250, 250);
    expect(await gui.keyUp()).toBe("no keys were held");
    expect(await gui.keyUp([])).toBe("no keys were held");
    await gui.keyDown(["ctrl", "alt"]);
    expect(await gui.keyUp()).toBe("released all held keys");
    await ev.settle();
    expect(ev.out.match(/KeyRelease/g)?.length).toBe(2);
  });

  it("rejects unknown keys before pressing anything", async () => {
    await expect(gui.keyDown(["ctrl", "nonsense"])).rejects.toThrow(/unknown key/);
    await expect(gui.keyUp(["nonsense"])).rejects.toThrow(/unknown key/);
  });

  it("lists key names including media keys, and media keys can be pressed", async () => {
    const names = (await gui.listKeys()).split(", ");
    for (const k of ["enter", "ctrl", "a", "f12", "kp_5", "volume_up", "mute", "media_next", "printscreen"]) expect(names).toContain(k);
    await expect(gui.pressKey(["volume_up"])).resolves.toBe("pressed volume_up"); // reaches the X server without error
    const ev = await startXev();
    await gui.moveMouse(250, 250);
    await gui.pressKey(["kp_5"]);
    await ev.settle();
    expect(ev.keys()[0]).toMatch(/^KP_(5|Begin)$/); // KP_Begin when NumLock is off
  });
});

describe.skipIf(!haveX)("screen", () => {
  it("captures a region, cropped to the requested size", async () => {
    spawnSync("xsetroot", ["-solid", "#ff0000"]);
    await sleep(150);
    const s = (await gui.screenshot(1280, { x: 200, y: 100, width: 120, height: 60 })) as unknown as Shot;
    expect(dims(png(s))).toEqual([120, 60]);
    expect(s[0].text).toContain("region 120x60+200+100 of a 1280x800 screen");
    expect(s[0].text).toContain("Real screen coordinates = (200 + image_x / 1.000, 100 + image_y / 1.000)");
    const px = Jimp.intToRGBA((await Jimp.read(png(s))).getPixelColor(5, 5));
    expect([px.r, px.g, px.b]).toEqual([255, 0, 0]);
    const small = (await gui.screenshot(60, { x: 200, y: 100, width: 120, height: 60 })) as unknown as Shot;
    expect(dims(png(small))).toEqual([60, 30]);
    expect(small[0].text).toContain("scaled by 0.500");
  });

  it("rejects regions outside the screen or only partly specified", async () => {
    await expect(gui.screenshot(1280, { x: 1200, y: 0, width: 200, height: 10 })).rejects.toThrow(/outside the 1280x800 screen/);
    await expect(gui.screenshot(1280, { x: -1, y: 0, width: 10, height: 10 })).rejects.toThrow(/outside/);
    expect(() => rectOf({ x: 1, y: 2 })).toThrow(/needs all of/);
    expect(rectOf({})).toBeUndefined();
  });

  it("saves full-resolution screenshots to a file (creating folders)", async () => {
    const out = path.join(tmpDir(), "deep/er/shot.png");
    expect(await gui.screenshotSave(out)).toBe(`saved 1280x800 screenshot to ${out}`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(dims(readFileSync(out))).toEqual([1280, 800]);
    const part = path.join(tmpDir(), "part.png");
    expect(await gui.screenshotSave(part, { x: 0, y: 0, width: 64, height: 32 })).toContain("saved 64x32");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(statSync(part).size).toBeGreaterThan(50);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(out)).toBe(true);
  });

  it("reads exact pixel colours", async () => {
    for (const [hex, rgb] of [["#ff0000", "rgb(255, 0, 0) #ff0000"], ["#00ff00", "rgb(0, 255, 0) #00ff00"], ["#0000ff", "rgb(0, 0, 255) #0000ff"], ["#102030", "rgb(16, 32, 48) #102030"]] as const) {
      spawnSync("xsetroot", ["-solid", hex]);
      await sleep(150);
      expect(await gui.colorAt(640, 400)).toBe(rgb);
    }
    await expect(gui.colorAt(-1, 0)).rejects.toThrow(/outside the 1280x800 screen/);
    await expect(gui.colorAt(1280, 0)).rejects.toThrow(/outside/);
    await expect(gui.colorAt(0, 800)).rejects.toThrow(/outside/);
  });

  it("highlights a region (the overlay is native; the call must succeed)", async () => {
    expect(await gui.highlight({ x: 100, y: 100, width: 200, height: 100 }, 50, 0.3)).toBe("highlighted 200x100+100+100 for 50 ms");
    const t = Object.fromEntries(gui.guiTools.map((x) => [x.name, x]));
    expect(await callTool(t.screen_highlight!, { x: 1, y: 1, width: 5, height: 5, duration_ms: 20 })).toContain("highlighted 5x5+1+1");
    expect(await callTool(t.screen_color_at!, { x: 3, y: 3 })).toMatch(/^rgb\(/);
    const shot = (await callTool(t.screenshot!, { x: 0, y: 0, width: 10, height: 10 })) as unknown[];
    expect(shot).toHaveLength(2);
    expect(await callTool(t.screenshot_save!, { path: path.join(tmpDir(), "t.png"), x: 0, y: 0, width: 10, height: 10 })).toContain("saved 10x10");
  });

  it.skipIf(!hasBinary("xsetroot"))("rejects a half-given region at the tool layer", async () => {
    const t = Object.fromEntries(gui.guiTools.map((x) => [x.name, x]));
    await expect(callTool(t.screenshot!, { x: 1, y: 1 })).rejects.toThrow(/needs all of/);
  });
});
