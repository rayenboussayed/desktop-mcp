import { afterAll, describe, expect, it } from "vitest";
import * as gui from "../../src/tools/gui.js";

const okNut = () => ({
  Key: { LeftControl: 1 },
  keyboard: { config: { autoDelayMs: 0 }, pressKey: async () => {}, releaseKey: async () => {} },
  mouse: { config: { autoDelayMs: 0, mouseSpeed: 3000 }, releaseButton: async () => {}, getPosition: async () => ({ x: 1, y: 1 }) },
    screen: { width: async () => 100, height: async () => 100 },
  Button: {},
});

const failingNut = () => ({
  Key: { LeftControl: 1 },
  keyboard: { config: { autoDelayMs: 0 }, pressKey: async () => {}, releaseKey: async () => { throw new Error("release boom"); } },
  mouse: { config: { autoDelayMs: 0, mouseSpeed: 3000 }, releaseButton: async () => {}, getPosition: async () => ({ x: 1, y: 1 }) },
    screen: { width: async () => 100, height: async () => 100 },
  Button: {},
});

afterAll(() => gui.__setNutLoader(undefined));

describe("GUI held-input cleanup", () => {
  it("clears its records even if a key cannot be released", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gui.__setNutLoader(failingNut as any);
    expect(await gui.keyDown(["ctrl"])).toBe("holding ctrl (call key_up to release)");
    await expect(gui.releaseHeldInputs()).rejects.toThrow(/release boom/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gui.__setNutLoader(okNut as any);
    expect(await gui.keyUp()).toBe("no keys were held");
  });
});
