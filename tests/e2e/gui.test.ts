/**
 * GUI tests drive the REAL nut.js against a private Xvfb display and observe the effects with a real X client
 * (`xev`): no fakes for the desktop. Skipped automatically when Xvfb / xev are missing.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Jimp from "jimp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as gui from "../../src/tools/gui.js";
import * as sys from "../../src/tools/system.js";
import { callTool } from "../../src/tools/base.js";
import { hasBinary, sleep, startXvfb, tmpDir, withEnv, withPlatform, type Xvfb } from "../helpers.js";

type Nut = typeof import("@nut-tree-fork/nut-js");
type Shot = [{ text: string }, { source: { data: string } }];
const shot = async (w?: number): Promise<Shot> => (await gui.screenshot(w)) as unknown as Shot;
let x: Xvfb | undefined;
const haveX = hasBinary("Xvfb") && hasBinary("xev");

beforeAll(async () => {
  if (!haveX) return;
  x = await startXvfb(); // DISPLAY comes from globalSetup, already in this worker's initial environment
});
afterAll(() => x?.stop());

/** A real X client that logs the events it receives. */
class Xev {
  private out = "";
  private proc: ChildProcess;
  constructor() {
    this.proc = spawn("xev", ["-geometry", "500x400+50+50"], { env: process.env });
    this.proc.stdout?.on("data", (d) => (this.out += d));
  }

  async ready(): Promise<void> { await sleep(700); }
  async settle(): Promise<string> { await sleep(400); return this.out; }
  keys(): string[] { return [...this.out.matchAll(/KeyPress[\s\S]*?keysym 0x[0-9a-f]+, (\S+?)\)/g)].map((m) => m[1] as string); }
  buttons(): string[] { return [...this.out.matchAll(/ButtonPress[\s\S]*?button (\d)/g)].map((m) => m[1] as string); }
  stop(): void { this.proc.kill("SIGKILL"); }
}
/**
 * Ground truth for typing: a real xterm whose child process writes every byte it receives to a file.
 * (xev's keysym view is unreliable for fast input: it looks keysyms up in the *current* keymap.)
 * @param send - Callback that performs the typing.
 * @returns The bytes the terminal received.
 */
async function viaXterm(send: () => Promise<unknown>): Promise<string> {
  const f = path.join(tmpDir(), "typed.txt");
  const term = spawn("xterm", ["-geometry", "80x24+50+50", "-e", "sh", "-c", `stty -echo -icanon; exec cat > ${f}`], { env: process.env });
  try {
    await sleep(1200);
    await gui.moveMouse(250, 250);
    await sleep(300);
    await send();
    await sleep(600);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  } finally {
    term.kill("SIGKILL");
  }
}
const haveTerm = haveX && hasBinary("xterm");

let xev: Xev | undefined;
afterEach(() => xev?.stop());
/**
 *
 * @returns The running xev process.
 */
async function startXev(): Promise<Xev> {
  xev = new Xev();
  await xev.ready();
  await gui.moveMouse(250, 250); // inside the xev window
  await sleep(200);
  return xev;
}

describe("display guard", () => {
  it("is a no-op outside Linux", async () => { await expect(gui.assertDisplay({}, "windows")).resolves.toBeUndefined(); });
  it("requires DISPLAY on Linux", async () => { await expect(gui.assertDisplay({}, "linux")).rejects.toThrow(/DISPLAY is not set/); });
  it("rejects a display with no socket at all", async () => {
    await expect(gui.assertDisplay({ DISPLAY: ":9876" }, "linux")).rejects.toThrow(/nothing is accepting connections on DISPLAY=:9876/);
  });
  it("rejects a STALE socket left behind by a crashed X server (this used to crash the process)", async () => {
    mkdirSync("/tmp/.X11-unix", { recursive: true });
    writeFileSync("/tmp/.X11-unix/X9877", ""); // a leftover file nobody is listening on
    try {
      await expect(gui.assertDisplay({ DISPLAY: ":9877.0" }, "linux")).rejects.toThrow(/stale socket/);
    } finally {
      rmSync("/tmp/.X11-unix/X9877", { force: true });
    }
  });
  it("lets a remote (TCP) display through untouched", async () => {
    await expect(gui.assertDisplay({ DISPLAY: "host:0" }, "linux")).resolves.toBeUndefined();
  });
  it.skipIf(!haveX)("accepts a live display", async () => {
    expect(x).toBeDefined();
    await expect(gui.assertDisplay({ DISPLAY: x?.display }, "linux")).resolves.toBeUndefined();
    await expect(gui.assertDisplay({ DISPLAY: `${x?.display}.0` }, "linux")).resolves.toBeUndefined();
  });
  it("a dead display yields a tool error, never a crashed process", async () => {
    gui.__setEnv({ DISPLAY: ":9878" }); // injected: the real environment is never touched next to native code
    try {
      gui.__setNutLoader(undefined);
      await expect(gui.click(10, 10)).rejects.toThrow(/nothing is accepting connections/);
    } finally {
      gui.__setEnv(undefined);
    }
  });
  it("tools fail with a message (not a segfault) when there is no display", async () => {
    gui.__setEnv({});
    try {
      gui.__setNutLoader(undefined);
      await expect(gui.screenSize()).rejects.toThrow(/DISPLAY is not set/);
    } finally {
      gui.__setEnv(undefined);
    }
  });
});

describe("linux typing plan", () => {
  it("maps characters to keys", () => {
    expect(gui.keysForChar("a")).toEqual({ key: "a", shift: false });
    expect(gui.keysForChar("A")).toEqual({ key: "a", shift: true });
    expect(gui.keysForChar("!")).toEqual({ key: "1", shift: true });
    expect(gui.keysForChar('"')).toEqual({ key: "'", shift: true });
    expect(gui.keysForChar("|")).toEqual({ key: "\\", shift: true });
    expect(gui.keysForChar("\\")).toEqual({ key: "\\", shift: false });
    expect(gui.keysForChar(" ")).toEqual({ key: "space", shift: false });
    expect(gui.keysForChar("\n")).toEqual({ key: "enter", shift: false });
    expect(gui.keysForChar("\t")).toEqual({ key: "tab", shift: false });
    expect(gui.keysForChar("é")).toBeUndefined();
    expect(gui.keysForChar("\r")).toBeUndefined();
  });
  it("splits text into key runs and paste runs", () => {
    expect(gui.segmentForLinux("ab!c@@é日\r\nx\x01")).toEqual([
      { kind: "keys", text: "ab!c@@" }, { kind: "paste", text: "é日" }, { kind: "keys", text: "\nx" }, { kind: "paste", text: "\x01" },
    ]);
    expect(gui.segmentForLinux("")).toEqual([]);
  });
});

describe("nut loading", () => {
  it.skipIf(!haveX)("explains how to install when the package is missing", async () => {
    gui.__setNutLoader(() => Promise.reject(new Error("Cannot find module")));
    await expect(gui.screenSize()).rejects.toThrow(/npm install @nut-tree-fork\/nut-js/);
    gui.__setNutLoader(undefined);
  });
});

describe.skipIf(!haveX)("key names (resolved against the real nut.js Key enum)", () => {
  let nut: Nut;
  beforeAll(async () => { nut = await import("@nut-tree-fork/nut-js"); });

  it("maps aliases, letters, digits, F-keys and punctuation", () => {
    const k = (n: string): number => gui.keyFromName(nut, n);
    expect(k("enter")).toBe(nut.Key.Return); // NOT Key.Enter: that is the keypad Enter
    expect(k("RETURN")).toBe(nut.Key.Return);
    expect(k(" Esc ")).toBe(nut.Key.Escape);
    expect(k("ctrl")).toBe(nut.Key.LeftControl);
    expect(k("cmd")).toBe(nut.Key.LeftSuper);
    expect(k("c")).toBe(nut.Key.C);
    expect(k("7")).toBe(nut.Key.Num7);
    expect(k("f12")).toBe(nut.Key.F12);
    expect(k("pgdn")).toBe(nut.Key.PageDown);
  });

  it("every documented alias exists in this nut.js version", () => {
    const names = [
      "enter", "return", "esc", "escape", "tab", "space", "backspace", "delete", "del", "insert", "home", "end",
      "pageup", "pgup", "pagedown", "pgdn", "up", "down", "left", "right", "ctrl", "control", "shift", "alt", "option",
      "opt", "win", "windows", "super", "meta", "command", "cmd", "capslock", "printscreen", "prtsc",
      "-", "=", ",", ".", "/", ";", "'", "[", "]", "\\", "`",
      ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""), ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
    ];
    for (const n of names) expect(() => gui.keyFromName(nut, n), n).not.toThrow();
  });

  it("every key the Linux typing plan can emit exists in nut.js", () => {
    for (let c = 32; c < 127; c++) {
      const plan = gui.keysForChar(String.fromCharCode(c));
      expect(plan, String.fromCharCode(c)).toBeDefined();
      expect(() => gui.keyFromName(nut, (plan as { key: string }).key), String.fromCharCode(c)).not.toThrow();
    }
    expect(() => gui.keyFromName(nut, "enter")).not.toThrow();
    expect(() => gui.keyFromName(nut, "tab")).not.toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => gui.keyFromName(nut, "nonsense")).toThrow("unknown key 'nonsense'");
    expect(() => gui.keyFromName(nut, "f25")).toThrow(/unknown key/);
    expect(() => gui.keyFromName(nut, "")).toThrow(/unknown key/);
  });
});

describe.skipIf(!haveX)("desktop control against a real X server", () => {
  it("reports the real screen size and pointer", async () => {
    await gui.moveMouse(300, 200);
    expect(await gui.screenSize()).toBe("screen 1280x800, mouse at (300,200)");
  });

  it("takes a real screenshot at the right scale", async () => {
    const [text, img] = await shot(640);
    expect(text.text).toContain("screen 1280x800");
    expect(text.text).toContain("scaled by 0.500");
    const png = Buffer.from(img.source.data, "base64");
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([640, 400]);

    const full = await shot();
    expect(full[0].text).toContain("scaled by 1.000"); // default max_width 1280 >= screen: untouched
    expect(Buffer.from(full[1].source.data, "base64").readUInt32BE(16)).toBe(1280);
  });

  it.skipIf(!hasBinary("xsetroot"))("captures the real pixels with the right channel order", async () => {
    for (const [color, [r, g, b]] of [["#ff0000", [255, 0, 0]], ["#0000ff", [0, 0, 255]], ["#00ff00", [0, 255, 0]]] as const) {
      expect(spawnSync("xsetroot", ["-solid", color], { env: process.env }).status).toBe(0);
      await sleep(150);
      const png = Buffer.from((await shot(1280))[1].source.data, "base64");
      const px = Jimp.intToRGBA((await Jimp.read(png)).getPixelColor(10, 10));
      expect([px.r, px.g, px.b], color).toEqual([r, g, b]);
    }
  });

  it("clicks: left, right, double, triple — seen by a real X client", async () => {
    const ev = await startXev();
    expect(await gui.click(250, 250)).toBe("clicked (250,250) left x1");
    expect(await gui.click(250, 250, "right")).toBe("clicked (250,250) right x1");
    expect(await gui.click(250, 250, "middle")).toBe("clicked (250,250) middle x1");
    expect(await gui.click(250, 250, "left", 2)).toBe("clicked (250,250) left x2");
    expect(await gui.click(250, 250, "left", 3)).toBe("clicked (250,250) left x3");
    await ev.settle();
    expect(ev.buttons()).toEqual(["1", "3", "2", "1", "1", "1", "1", "1"]);
  });

  it("presses keys: Enter is Return, combos release cleanly", async () => {
    const ev = await startXev();
    expect(await gui.pressKey(["enter"])).toBe("pressed enter");
    expect(await gui.pressKey(["ctrl", "shift", "a"])).toBe("pressed ctrl+shift+a");
    expect(await gui.pressKey(["f5"])).toBe("pressed f5");
    await ev.settle();
    expect(ev.keys()).toEqual(["Return", "Control_L", "Shift_L", "A", "F5"]);
  });

  it.skipIf(!haveTerm)("types EVERY printable ASCII character exactly (checked in a real terminal)", async () => {
    const all = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
    for (const interval of [0.005, 0.02]) {
      let result = "";
      expect(await viaXterm(async () => (result = await gui.typeText(all, interval)))).toBe(all);
      expect(result).toBe("typed 95 chars");
    }
  });

  it.skipIf(!haveTerm)("types realistic text: URLs, code, passwords, newlines, tabs, CRLF", async () => {
    const text = 'curl -sS "https://example.com/a?b=1&c=2#x" | jq \'.[0]\'\r\nP@ss{w0rd}!~|\\\tend\nlast';
    expect(await viaXterm(() => gui.typeText(text, 0.005))).toBe(text.replace(/\r\n/g, "\n"));
  });

  it.skipIf(!haveTerm)("a typing run leaves no key stuck for the next one", async () => {
    // regression: libnut left `grave` auto-repeating after typing '~'
    await viaXterm(() => gui.typeText("~~~`~", 0.005));
    expect(await viaXterm(() => gui.typeText("clean", 0.005))).toBe("clean");
  });

  it.skipIf(!hasBinary("xclip"))("pastes non-ASCII text via the clipboard, then restores it", async () => {
    const ev = await startXev();
    await sys.clipboardSet("original clipboard");
    const seen = new Set<string>();
    let polling = true;
    const poll = (async () => { while (polling) { seen.add(await sys.clipboardGet()); await sleep(25); } })();
    expect(await gui.typeText("ab é€日😀 cd", 0.005)).toBe("typed 10 chars");
    polling = false;
    await poll;
    await ev.settle();
    expect(seen.has("é€日😀")).toBe(true); // the non-ASCII run was on the clipboard while Ctrl+V was sent
    expect(ev.keys()).toEqual(["a", "b", "space", "Control_L", "v", "space", "c", "d"]);
    // X11 selection ownership is asynchronous: xclip exits before its daemon serves the restored value, so poll.
    const restored = async (): Promise<string> => {
      for (let i = 0; i < 80; i++) {
        const got = await sys.clipboardGet();
        if (got === "original clipboard") return got;
        await sleep(50);
      }
      return sys.clipboardGet();
    };
    expect(await restored()).toBe("original clipboard");
  });

  it("explains non-ASCII typing needs a clipboard tool", async () => {
    await startXev();
    await withEnv({ PATH: "/nonexistent" }, async () => {
      await expect(gui.typeText("é")).rejects.toThrow(/without a clipboard tool/);
    });
  });

  it("does not leave modifiers stuck when a key name is invalid", async () => {
    const ev = await startXev();
    await expect(gui.pressKey(["ctrl", "nonsense"])).rejects.toThrow(/unknown key/);
    await gui.typeText("z");
    await ev.settle();
    expect(ev.keys()).toEqual(["z"]); // a stuck Control would have produced Control_L first
  });

  it("scrolls: positive is up (button 4), negative down (button 5), zero is a no-op", async () => {
    const ev = await startXev();
    expect(await gui.scroll(2)).toBe("scrolled 2");
    expect(await gui.scroll(-3)).toBe("scrolled -3");
    expect(await gui.scroll(0)).toBe("scrolled 0");
    await ev.settle();
    expect(ev.buttons()).toEqual(["4", "4", "5", "5", "5"]);
  });

  it("moves the pointer", async () => {
    expect(await gui.moveMouse(640, 123)).toBe("moved to (640,123)");
    expect(await gui.screenSize()).toContain("mouse at (640,123)");
  });

  it("fail-safe: refuses to act while the pointer is in a screen corner", async () => {
    const nut = await import("@nut-tree-fork/nut-js");
    for (const [cx, cy] of [[0, 0], [1279, 0], [0, 799], [1279, 799]] as const) {
      await nut.mouse.setPosition(new nut.Point(cx, cy));
      await expect(gui.click(100, 100), `${cx},${cy}`).rejects.toThrow(/fail-safe/);
    }
    await expect(gui.typeText("x")).rejects.toThrow(/fail-safe/);
    await expect(gui.pressKey(["a"])).rejects.toThrow(/fail-safe/);
    await expect(gui.scroll(1)).rejects.toThrow(/fail-safe/);
    await expect(gui.moveMouse(5, 5)).rejects.toThrow(/fail-safe/);
    await nut.mouse.setPosition(new nut.Point(0, 400)); // an edge (not a corner) is fine
    await expect(gui.moveMouse(300, 300)).resolves.toContain("moved");
  });

  it("works through the tool layer with schema validation and defaults", async () => {
    const byName = Object.fromEntries(gui.guiTools.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual([
      "screenshot", "screenshot_save", "screen_size", "screen_color_at", "screen_highlight", "mouse_position", "click", "move_mouse",
      "mouse_move_relative", "mouse_press", "mouse_release", "mouse_drag", "scroll", "type_text", "press_key", "key_down", "key_up", "list_keys",
    ]);
    expect(gui.guiTools.filter((t) => t.risky).map((t) => t.name)).toEqual(["click", "mouse_press", "mouse_drag", "type_text", "press_key", "key_down"]);
    expect(await callTool(byName.move_mouse!, { x: 200, y: 200 })).toBe("moved to (200,200)");
    expect(await callTool(byName.click!, { x: 200, y: 200 })).toBe("clicked (200,200) left x1");
    expect(await callTool(byName.screen_size!, {})).toContain("screen 1280x800");
    await expect(callTool(byName.click!, { x: "a", y: 1 })).rejects.toThrow();
    await expect(callTool(byName.click!, { x: 1, y: 1, button: "side" })).rejects.toThrow();
    await expect(callTool(byName.press_key!, { keys: [] })).rejects.toThrow();
    const shot = (await callTool(byName.screenshot!, {})) as unknown[];
    expect(shot).toHaveLength(2);
  });
});

describe("HiDPI scale is relative to logical pixels (fake nut with a 2x display)", () => {
  it("reports image scale against the logical screen, not the captured pixels", async () => {
    const real = await import("@nut-tree-fork/nut-js");
    const png = new Jimp(2560, 1600, 0xffffffff); // captured at 2x
    const fake = {
      ...real,
      mouse: { ...real.mouse, config: { autoDelayMs: 0, mouseSpeed: 0 }, getPosition: async () => ({ x: 500, y: 500 }) },
      screen: { grab: async () => ({}), width: async () => 1280, height: async () => 800 },
      imageToJimp: async () => png,
    } as unknown as Nut;
    await withPlatform("darwin", async () => {
      gui.__setNutLoader(async () => fake);
      const [text] = await shot(1280);
      // 2560 captured px -> 1280 sent px, over 1280 logical px => scale 1.000 (NOT 0.500)
      expect(text.text).toContain("screen 1280x800");
      expect(text.text).toContain("scaled by 1.000");
      const [t2] = await shot(640);
      expect(t2.text).toContain("scaled by 0.500");
    });
    gui.__setNutLoader(undefined);
  });
});
