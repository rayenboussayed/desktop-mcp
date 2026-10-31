import { describe, expect, it } from "vitest";
import { __setEnv, assertDisplay } from "../../src/tools/gui.js";

describe("assertDisplay", () => {
  it("refuses Wayland sessions with a clear message", async () => {
    __setEnv({ WAYLAND_DISPLAY: "wayland-0" });
    try {
      await expect(assertDisplay()).rejects.toThrow(/do not support Wayland/);
    } finally {
      __setEnv(undefined);
    }
  });
});
