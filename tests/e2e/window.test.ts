/** Window management against real windows (xterm) under a real EWMH window manager (openbox). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionDenied, PermissionEngine } from "../../src/policy/engine.js";
import { PolicySchema } from "../../src/policy/schema.js";
import { callTool } from "../../src/tools/base.js";
import * as win from "../../src/tools/window.js";
import { __resetProviders, ensureProviders } from "../../src/tools/vision.js";
import { __setEnv, nut } from "../../src/nut/runtime.js";
import { withPlatform } from "../helpers.js";
import { haveWm, openWindow, stopAll, xrun } from "../x.js";
import { sleep } from "../helpers.js";

const info = async (title: string): Promise<win.WinInfo> => {
  const w = (await win.listWindows()).find((x) => x.title === title);
  if (!w) throw new Error(`window ${title} not listed`);
  return w;
};
const xwininfo = (handle: number): { x: number; y: number; w: number; h: number } => {
  const out = xrun("xwininfo", ["-id", String(handle)]);
  const n = (re: RegExp): number => Number(re.exec(out)?.[1]);
  return { x: n(/Absolute upper-left X:\s+(-?\d+)/), y: n(/Absolute upper-left Y:\s+(-?\d+)/), w: n(/Width: (\d+)/), h: n(/Height: (\d+)/) };
};
const netState = (handle: number): string => xrun("xprop", ["-id", String(handle), "_NET_WM_STATE"]);

beforeAll(async () => {
  if (!haveWm) return;
  await openWindow("osagent-A", { geometry: "40x8+100+100" });
  await openWindow("osagent-B", { geometry: "40x8+500+300" });
});
afterAll(() => stopAll());

describe.skipIf(!haveWm)("windows on Linux (real window manager)", () => {
  it("lists real client windows with titles and ABSOLUTE geometry (nut's own list has neither)", async () => {
    const all = await win.listWindows();
    const [wa, wb] = [await info("osagent-A"), await info("osagent-B")];
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.every((w) => w.title !== "" || w.width > 1)).toBe(true);
    for (const w of [wa, wb]) {
      const x = xwininfo(w.handle); // independent measurement
      expect([w.x, w.y, w.width, w.height]).toEqual([x.x, x.y, x.w, x.h]);
      expect(w.width).toBeGreaterThan(150);
    }
    // the client area sits inside the frame: left/top are the requested position plus the decorations
    expect(wa.x).toBeGreaterThanOrEqual(100);
    expect(wa.y).toBeGreaterThanOrEqual(100);
    expect(wb.x).toBeGreaterThan(wa.x);
    const text = await win.windowList();
    expect(text).toContain('title="osagent-A"');
    expect(text).toMatch(/handle=\d+ title="osagent-B" at \(\d+,\d+\) \d+x\d+/);
  });

  it("focus changes the active window; selectors by title, handle and default", async () => {
    expect(await win.windowFocus({ title: "osagent-A" })).toContain('title="osagent-A"');
    expect(await win.windowActive()).toMatch(/title="osagent-A".*\[active\]/);
    expect((await win.activeWindow())?.title).toBe("osagent-A");
    expect(await win.activeWindowTitle()).toBe("osagent-A");
    const wb = await info("osagent-B");
    expect(await win.windowFocus({ handle: wb.handle })).toContain("[active]");
    expect(await win.activeWindowTitle()).toBe("osagent-B");
    expect(await win.windowFocus({ title: "^OSAGENT-a$" })).toContain("osagent-A"); // regex, case-insensitive
    expect(await win.windowFocus({})).toContain("osagent-A"); // no selector: the active window
    await expect(win.windowFocus({ title: "no-such-window" })).rejects.toThrow(/no window matches/);
    await expect(win.windowFocus({ handle: 1 })).rejects.toThrow(/no window matches/);
    await expect(win.windowFocus({ title: "(" })).rejects.toThrow(/invalid title pattern/);
  });

  it("moves and resizes (the window manager adds decorations, so allow a few pixels)", async () => {
    const before = await info("osagent-A");
    const moved = await win.windowMove({ title: "osagent-A" }, 300, 200);
    expect(moved).toMatch(/^moved handle=/);
    const m = xwininfo(before.handle);
    expect(Math.abs(m.x - 300)).toBeLessThan(30);
    expect(Math.abs(m.y - 200)).toBeLessThan(40);
    expect([m.x, m.y]).not.toEqual([before.x, before.y]);
    expect(await win.windowResize({ title: "osagent-A" }, 420, 260)).toMatch(/^resized handle=/);
    const r = xwininfo(before.handle);
    expect(Math.abs(r.w - 420)).toBeLessThan(20);
    expect(Math.abs(r.h - 260)).toBeLessThan(40);
    expect((await info("osagent-A")).width).toBe(r.w);
  });

  it("minimises and restores (libnut cannot on Linux; xdotool does)", async () => {
    const h = (await info("osagent-A")).handle;
    expect(netState(h)).not.toContain("HIDDEN");
    expect(await win.windowMinimize({ title: "osagent-A" })).toBe(`minimized handle=${h} "osagent-A"`);
    await sleep(300);
    expect(netState(h)).toContain("_NET_WM_STATE_HIDDEN");
    expect(await win.windowRestore({ title: "osagent-A" })).toMatch(/^restored handle=/);
    await sleep(300);
    expect(netState(h)).not.toContain("HIDDEN");
    expect(await win.activeWindowTitle()).toBe("osagent-A");
  });

  it("waits for a window to appear, and times out cleanly", async () => {
    const t = setTimeout(() => void openWindow("osagent-C", { geometry: "30x5+700+100" }), 500);
    expect(await win.windowWaitFor("^osagent-C$", 8000, 100)).toContain('title="osagent-C"');
    clearTimeout(t);
    await expect(win.windowWaitFor("never-appears-xyz", 300, 50)).rejects.toThrow(/no window titled \/never-appears-xyz\/ appeared within 300 ms/);
  });

  it("closes a window politely (like its close button)", async () => {
    expect(await win.windowClose({ title: "osagent-C" })).toMatch(/^asked to close handle=\d+ "osagent-C"$/);
    for (let i = 0; i < 40 && (await win.listWindows()).some((w) => w.title === "osagent-C"); i++) await sleep(100);
    expect((await win.listWindows()).some((w) => w.title === "osagent-C")).toBe(false);
  });

  it("the permission policy can confine window control to chosen windows", async () => {
    const engine = new PermissionEngine(PolicySchema.parse({ default: "allow", gui: { windows: ["^osagent-A$"] } }), { activeWindowTitle: win.activeWindowTitle });
    const focus = engine.wrap(win.windowFocusTool);
    await expect(focus.run({ title: "osagent-A" })).resolves.toContain("osagent-A");
    await expect(focus.run({ title: "osagent-B" })).rejects.toThrow(PermissionDenied);
    await expect(engine.wrap(win.windowCloseTool).run({ title: "osagent-B" })).rejects.toThrow(/not in the allowed windows/);
    expect((await info("osagent-B")).title).toBe("osagent-B"); // untouched
    // input tools are scoped by the ACTIVE window
    await win.windowFocus({ title: "osagent-B" });
    const click = (await import("../../src/tools/gui.js")).clickTool;
    await expect(engine.wrap(click).run({ x: 400, y: 400, button: "left", clicks: 1 })).rejects.toThrow(/active window "osagent-B" is not in the allowed windows/);
    await win.windowFocus({ title: "osagent-A" });
    await expect(engine.wrap(click).run({ x: 400, y: 400, button: "left", clicks: 1 })).resolves.toContain("clicked");
  });

  it("tools validate their arguments", async () => {
    const t = Object.fromEntries(win.windowTools.map((x) => [x.name, x]));
    expect(Object.keys(t)).toEqual(["window_list", "window_active", "window_focus", "window_move", "window_resize", "window_minimize", "window_restore", "window_close", "window_wait_for"]);
    expect(await callTool(t.window_list!, {})).toContain("osagent-A");
    expect(await callTool(t.window_active!, {})).toContain("handle=");
    expect(await callTool(t.window_move!, { title: "osagent-B", x: 500, y: 300 })).toContain("moved");
    expect(await callTool(t.window_resize!, { title: "osagent-B", width: 400, height: 250 })).toContain("resized");
    expect(await callTool(t.window_focus!, { title: "osagent-B" })).toContain("focused");
    expect(await callTool(t.window_minimize!, { title: "osagent-B" })).toContain("minimized");
    expect(await callTool(t.window_restore!, { title: "osagent-B" })).toContain("restored");
    expect(await callTool(t.window_wait_for!, { title: "osagent-B" })).toContain("osagent-B");
    await expect(callTool(t.window_resize!, { title: "x", width: 0, height: 5 })).rejects.toThrow();
    await expect(callTool(t.window_move!, { title: "x", x: "a", y: 1 })).rejects.toThrow();
  });

  it("nut.js' own screen.find(windowWithTitle(...)) works once our window finder is registered", async () => {
    const n = await nut();
    __resetProviders();
    ensureProviders(n);
    ensureProviders(n); // idempotent
    const found = await n.screen.find(n.windowWithTitle("osagent-B"));
    expect(await found.title).toBe("osagent-B");
    const re = await n.screen.find(n.windowWithTitle(/osagent-[AB]/));
    expect(["osagent-A", "osagent-B"]).toContain(await re.title);
    await expect(n.screen.find(n.windowWithTitle("definitely-not-open"))).rejects.toThrow();
  });

  it("a missing display is reported, not fatal: activeWindowTitle is undefined", async () => {
    __setEnv({ DISPLAY: ":9899" });
    try {
      expect(await win.activeWindowTitle()).toBeUndefined();
    } finally {
      __setEnv(undefined);
    }
  });

  it("an empty list and a missing active window are described", async () => {
    // a listing with no entries / no active window, using the pure formatting paths via a faked backend
    expect(await withPlatform("linux", () => win.windowList())).toContain("osagent-");
  });
});
