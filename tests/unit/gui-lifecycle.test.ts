import { afterAll, describe, expect, it } from "vitest";
import * as gui from "../../src/tools/gui.js";

type Nut = typeof import("@nut-tree-fork/nut-js");

const okNut = () => Object.assign({} as Nut, {
  Key: { LeftControl: 1 },
  keyboard: { config: { autoDelayMs: 0 }, pressKey: async () => {}, releaseKey: async () => {} },
  mouse: { config: { autoDelayMs: 0, mouseSpeed: 3000 }, releaseButton: async () => {}, getPosition: async () => ({ x: 1, y: 1 }) },
    screen: { width: async () => 100, height: async () => 100 },
  Button: {},
});

const failingNut = () => Object.assign({} as Nut, {
  Key: { LeftControl: 1 },
  keyboard: { config: { autoDelayMs: 0 }, pressKey: async () => {}, releaseKey: async () => { throw new Error("release boom"); } },
  mouse: { config: { autoDelayMs: 0, mouseSpeed: 3000 }, releaseButton: async () => {}, getPosition: async () => ({ x: 1, y: 1 }) },
    screen: { width: async () => 100, height: async () => 100 },
  Button: {},
});

afterAll(() => gui.__setNutLoader(undefined));

describe("GUI held-input cleanup", () => {
  it("clears its records even if a key cannot be released", async () => {
    gui.__setNutLoader(async () => failingNut());
    expect(await gui.keyDown(["ctrl"])).toBe("holding ctrl (call key_up to release)");
    await expect(gui.releaseHeldInputs()).rejects.toThrow(/release boom/);
    gui.__setNutLoader(async () => okNut());
    expect(await gui.keyUp()).toBe("no keys were held");
  });
});
