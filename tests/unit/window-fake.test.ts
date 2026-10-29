/**
 * Window and input code paths that cannot run for real here: the non-Linux backends (a fake nut.js stands in for
 * Windows/macOS) and X11 failure handling (shim xprop/xwininfo/xdotool/wmctrl scripts). These verify OUR logic around
 * those tools; they are not evidence of how Windows or macOS themselves behave.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __setNutLoader } from "../../src/nut/runtime.js";
import * as gui from "../../src/tools/gui.js";
import * as win from "../../src/tools/window.js";
import { isPosix, makeBin, tmpDir, withEnv, withPlatform } from "../helpers.js";

type Nut = typeof import("@nut-tree-fork/nut-js");
const calls: [string, ...unknown[]][] = [];
const pressed: number[] = [];

/**
 *
 * @param over - Window overrides.
 * @param over.titles - Window titles by handle.
 * @param over.handles - Window handles or a function returning them.
 * @param over.active - Active window handle.
 * @returns The fake nut.js module.
 */
async function fakeNut(over: { titles?: Record<number, string>; handles?: number[] | (() => number[]); active?: number } = {}): Promise<Nut> {
  const real = await import("@nut-tree-fork/nut-js");
  const titles = over.titles ?? { 1: "One", 2: "Two", 3: "", 4: "Tiny" };
  const regions: Record<number, { left: number; top: number; width: number; height: number }> = {
    1: { left: 10, top: 20, width: 800, height: 600 }, 2: { left: 50, top: 60, width: 640, height: 480 },
    3: { left: 0, top: 0, width: 300, height: 300 }, 4: { left: 0, top: 0, width: 1, height: 1 },
  };
  class FakeWindow {
    constructor(public registry: unknown, public windowHandle: number) {}
    get title() { return Promise.resolve(titles[this.windowHandle] ?? ""); }
    get region() { return Promise.resolve(regions[this.windowHandle] ?? { left: 0, top: 0, width: 0, height: 0 }); }
    async focus() { calls.push(["focus", this.windowHandle]); }
    async move(p: { x: number; y: number }) { calls.push(["move", this.windowHandle, p.x, p.y]); }
    async resize(s: { width: number; height: number }) { calls.push(["resize", this.windowHandle, s.width, s.height]); }
    async minimize() { calls.push(["minimize", this.windowHandle]); }
    async restore() { calls.push(["restore", this.windowHandle]); }
  }
  return {
    ...real,
    Window: FakeWindow,
    providerRegistry: {},
    getWindows: async () => (typeof over.handles === "function" ? over.handles() : (over.handles ?? [1, 2, 3, 4])).map((h) => new FakeWindow({}, h)),
    getActiveWindow: async () => new FakeWindow({}, over.active ?? 2),
    keyboard: { config: {}, pressKey: async (...k: number[]) => void pressed.push(...k), releaseKey: async () => {}, type: async (t: string) => void calls.push(["type", t]) },
    mouse: { config: {}, getPosition: async () => ({ x: 500, y: 500 }), scrollRight: async (n: number) => void calls.push(["right", n]), scrollLeft: async (n: number) => void calls.push(["left", n]), scrollUp: async () => {}, scrollDown: async () => {} },
    screen: { width: async () => 1280, height: async () => 800 },
  } as unknown as Nut;
}
/**
 *
 * @param over - Window overrides.
 */
async function useFake(over?: Parameters<typeof fakeNut>[0]): Promise<void> {
  const f = await fakeNut(over);
  __setNutLoader(async () => f);
}
afterEach(() => { __setNutLoader(undefined); calls.length = 0; pressed.length = 0; });

describe("non-Linux backend (fake nut.js)", () => {
  it("lists real, titled, non-trivial windows and marks the active one", async () => {
    await useFake();
    await withPlatform("darwin", async () => {
      const all = await win.listWindows();
      expect(all.map((w) => w.title)).toEqual(["One", "Two"]); // untitled and 1x1 helper windows are dropped
      expect(all[1]).toEqual({ handle: 2, title: "Two", x: 50, y: 60, width: 640, height: 480, active: true });
      expect(await win.windowList()).toBe('handle=1 title="One" at (10,20) 800x600\nhandle=2 title="Two" at (50,60) 640x480 [active]');
      expect((await win.activeWindow())?.title).toBe("Two");
      expect(await win.windowActive()).toContain("[active]");
      expect(await win.activeWindowTitle()).toBe("Two");
    });
  });

  it("reports an empty list", async () => {
    await useFake({ handles: [3, 4] });
    await withPlatform("win32", async () => expect(await win.windowList()).toBe("[no windows]"));
  });

  it("focus / move / resize / minimise / restore go through nut.js", async () => {
    await useFake();
    await withPlatform("win32", async () => {
      expect(await win.windowFocus({ title: "One" })).toContain('title="One"');
      await win.windowMove({ handle: 2 }, 5, 6);
      await win.windowResize({ title: "Two" }, 300, 200);
      expect(await win.windowMinimize({ title: "One" })).toBe('minimized handle=1 "One"');
      expect(await win.windowRestore({ title: "One" })).toMatch(/^restored handle=1/);
    });
    expect(calls).toEqual([["focus", 1], ["move", 2, 5, 6], ["resize", 2, 300, 200], ["minimize", 1], ["restore", 1]]);
  });

  it("close presses Alt+F4 on Windows and Command+W on macOS", async () => {
    await useFake();
    await withPlatform("win32", () => win.windowClose({ title: "One" }));
    const alt = [...pressed];
    expect(alt).toHaveLength(2);
    pressed.length = 0;
    await withPlatform("darwin", () => win.windowClose({ title: "One" }));
    expect(pressed).toHaveLength(2);
    expect(pressed).not.toEqual(alt);
    expect(calls.filter((c) => c[0] === "focus")).toHaveLength(2); // the window is focused first
  });

  it("the refreshed description falls back to the handle if the window vanished", async () => {
    let listings = 0;
    await useFake({ handles: () => (listings++ === 0 ? [1] : []) }); // present when resolved, gone afterwards
    await withPlatform("darwin", async () => {
      expect(await win.windowMove({ handle: 1 }, 1, 1)).toBe("moved handle=1");
    });
  });

  it("types with nut.js directly and scrolls the horizontal wheel without Linux compensation", async () => {
    await useFake();
    await withPlatform("darwin", async () => {
      expect(await gui.typeText("héllo!")).toBe("typed 6 chars");
      expect(await gui.scroll(2, true)).toBe("scrolled horizontally 2");
      expect(await gui.scroll(-3, true)).toBe("scrolled horizontally -3");
    });
    expect(calls).toEqual([["type", "héllo!"], ["right", 2], ["left", 3]]);
  });
});

describe.skipIf(!isPosix)("Linux X11 helpers (shim tools)", () => {
  const shim = (scripts: Record<string, string>): string => {
    const dir = tmpDir();
    for (const [name, body] of Object.entries(scripts)) makeBin(dir, name, body);
    return dir;
  };

  it("a missing tool says what to install", async () => {
    await expect(withEnv({ PATH: tmpDir() }, () => win.x11("xprop", ["-root"]))).rejects.toThrow(/xprop is needed for window control on Linux .*install x11-utils/);
  });

  it("a failing tool reports its stderr, or its exit code when silent", async () => {
    const dir = shim({ xprop: 'if [ "$1" = "-id" ]; then exit 3; fi; echo boom >&2; exit 1' });
    await withEnv({ PATH: dir }, async () => {
      await expect(win.x11("xprop", ["-root"])).rejects.toThrow("xprop failed: boom");
      await expect(win.x11("xprop", ["-id", "5"])).rejects.toThrow("xprop failed: exit 3");
    });
  });

  it("parses titles (UTF-8 name first, legacy name second, empty otherwise) and geometry", async () => {
    const mk = (out: string) => shim({ xprop: `printf '%s\\n' '${out}'`, xwininfo: "true" });
    await withEnv({ PATH: mk('_NET_WM_NAME(UTF8_STRING) = "Modern ✓"\nWM_NAME(STRING) = "old"') }, async () => expect(await win.x11Title(1)).toBe("Modern ✓"));
    await withEnv({ PATH: mk('_NET_WM_NAME:  not found.\nWM_NAME(STRING) = "Legacy"') }, async () => expect(await win.x11Title(1)).toBe("Legacy"));
    await withEnv({ PATH: mk("nothing useful") }, async () => expect(await win.x11Title(1)).toBe(""));
    await withEnv({ PATH: mk("x") }, async () => expect(await win.x11Geometry(1)).toEqual({ x: 0, y: 0, width: 0, height: 0 })); // unparseable output
  });

  it("no windows and no active window are described, and a default target needs one", async () => {
    const dir = shim({ xprop: 'case "$*" in *_NET_CLIENT_LIST*) echo "_NET_CLIENT_LIST(WINDOW): no such atom on any window.";; *_NET_ACTIVE_WINDOW*) echo "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0";; esac' });
    await withEnv({ PATH: dir }, async () => {
      expect(await win.windowList()).toBe("[no windows]");
      expect(await win.windowActive()).toBe("[no active window]");
      expect(await win.activeWindow()).toBeUndefined();
      expect(await win.activeWindowTitle()).toBeUndefined();
      await expect(win.windowFocus({})).rejects.toThrow("there is no active window");
    });
  });

  it("falls back to xprop when nut.js has no title, and survives xprop failing too", async () => {
    await useFake();
    const named = shim({
      xprop: 'case "$*" in *_NET_CLIENT_LIST*) echo "_NET_CLIENT_LIST(WINDOW): window id # 0x1234";; *_NET_ACTIVE_WINDOW*) echo "x # 0x1234";; *) echo \'_NET_WM_NAME(UTF8_STRING) = "From xprop"\';; esac',
      xwininfo: 'echo "  Absolute upper-left X:  100"; echo "  Absolute upper-left Y:  200"; echo "  Width: 640"; echo "  Height: 480"',
    });
    await withEnv({ PATH: named }, async () => {
      expect(await win.windowList()).toBe('handle=4660 title="From xprop" at (100,200) 640x480 [active]');
    });
    const broken = shim({
      xprop: 'case "$*" in *_NET_CLIENT_LIST*) echo "# 0x1234";; *_NET_ACTIVE_WINDOW*) echo "# 0x1";; *) exit 1;; esac',
      xwininfo: "true",
    });
    await withEnv({ PATH: broken }, async () => expect(await win.windowList()).toBe('handle=4660 title="" at (0,0) 0x0'));
  });

  it("minimise, restore and close drive xdotool / wmctrl with the window handle", async () => {
    await useFake({ titles: { 4660: "Target" } });
    const dir = tmpDir();
    const log = path.join(dir, "log");
    makeBin(dir, "xprop", 'case "$*" in *_NET_CLIENT_LIST*) echo "# 0x1234";; *_NET_ACTIVE_WINDOW*) echo "# 0x1234";; esac');
    makeBin(dir, "xwininfo", 'echo "  Absolute upper-left X:  1"; echo "  Absolute upper-left Y:  2"; echo "  Width: 3"; echo "  Height: 4"');
    makeBin(dir, "xdotool", `echo "xdotool $@" >> ${log}`);
    makeBin(dir, "wmctrl", `echo "wmctrl $@" >> ${log}`);
    await withEnv({ PATH: dir }, async () => {
      expect(await win.windowMinimize({ title: "Target" })).toBe('minimized handle=4660 "Target"');
      expect(await win.windowRestore({ title: "Target" })).toContain("restored handle=4660");
      expect(await win.windowClose({ title: "Target" })).toBe('asked to close handle=4660 "Target"');
    });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "xdotool windowminimize 4660", "xdotool windowmap 4660", "xdotool windowactivate 4660", "wmctrl -i -c 0x1234",
    ]);
    // without the helper tools installed the error says which to install
    await withEnv({ PATH: (() => { const d = tmpDir(); makeBin(d, "xprop", 'echo "# 0x1234"'); makeBin(d, "xwininfo", "true"); return d; })() }, async () => {
      await expect(win.windowMinimize({ title: "Target" })).rejects.toThrow(/xdotool is needed for window control on Linux/);
      await expect(win.windowClose({ title: "Target" })).rejects.toThrow(/wmctrl is needed/);
    });
    expect(existsSync(log)).toBe(true);
  });
});
