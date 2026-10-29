/** The last uncovered branches: tool wrappers, finders called directly, default engines, default window probe. */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import Jimp from "jimp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execText } from "../../src/exec.js";
import { buildServer } from "../../src/mcpServer.js";
import { nut } from "../../src/nut/runtime.js";
import { __setOcrEngine, recognize, shutdownOcr } from "../../src/plugins/ocr.js";
import { callTool } from "../../src/tools/base.js";
import * as gui from "../../src/tools/gui.js";
import * as sys from "../../src/tools/system.js";
import * as vision from "../../src/tools/vision.js";
import { listWindows, windowFocus, type WinInfo } from "../../src/tools/window.js";
import { isPosix, makeBin, sleep, tmpDir, withEnv } from "../helpers.js";
import { haveWm, haveXterm, openWindow, stopAll } from "../x.js";
import { writeFileSync as write } from "node:fs";

afterEach(() => vi.restoreAllMocks());
afterAll(async () => { stopAll(); await shutdownOcr(); });

describe("small leftovers", () => {
  it("a timed-out command's drain timer fires harmlessly afterwards", async () => {
    const res = await execText("sleep", ["30"], { timeoutMs: 100 });
    expect(res.timedOut).toBe(true);
    await sleep(400); // the 200 ms drain timer runs after the result was already delivered
  });

  it.skipIf(!isPosix)("clipboard / open / mkdir / copy tools call through", async () => {
    const bin = tmpDir();
    const log = path.join(tmpDir(), "log");
    makeBin(bin, "xclip", `case "$*" in *-o*) printf shim-clip;; *) read -r line; echo "$line" >> ${log};; esac`);
    makeBin(bin, "xdg-open", `echo "$@" >> ${log}.open`);
    const d = tmpDir();
    write(path.join(d, "a.txt"), "x");
    await withEnv({ PATH: bin }, async () => {
      expect(await callTool(sys.clipboardGetTool, {})).toBe("shim-clip");
      expect(await callTool(sys.clipboardSetTool, { text: "t" })).toBe("copied 1 chars");
      expect(await callTool(sys.openPathTool, { target: "https://example.com" })).toBe("opened https://example.com");
    });
    expect(await callTool(sys.makeDirTool, { path: path.join(d, "m/n") })).toContain("created");
    expect(await callTool(sys.copyPathTool, { src: path.join(d, "a.txt"), dst: path.join(d, "b.txt") })).toContain("copied");
    expect(existsSync(path.join(d, "b.txt"))).toBe(true);
    await sleep(200);
  });

  it("list_dir/find_files order entries by bytes (uppercase first)", async () => {
    const d = tmpDir();
    for (const n of ["b", "B", "a", "A"]) write(path.join(d, n), "");
    expect((await sys.findFiles("*", d)).split("\n").map((p) => path.basename(p))).toEqual(["A", "B", "a", "b"]);
  });
});

describe("default engines", () => {
  it("OCR uses the real tesseract.js engine after the test hook is reset", async () => {
    __setOcrEngine(undefined); // drops the injected engine: the default loader runs
    const img = new Jimp(500, 120, 0xffffffff);
    img.print(await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK), 20, 30, "Default Engine");
    const r = await recognize(await img.getBufferAsync("image/png"), "eng");
    expect(r.text).toContain("Default Engine");
  }, 30_000);
});

describe.skipIf(!haveWm || !haveXterm)("providers called directly, and the vision tools without a region", () => {
  let win: WinInfo;
  beforeAll(async () => {
    await openWindow("prov-win", { geometry: "34x4+60+80", font: 30, text: "HELLO WORLD Save File" });
    await windowFocus({ title: "prov-win" });
    await sleep(300);
    win = (await listWindows()).find((w) => w.title === "prov-win") as WinInfo;
  });

  it("image finder: default confidence, a hit, no hit, and all hits", async () => {
    const n = await nut();
    vision.__resetProviders();
    vision.ensureProviders(n);
    const finder = n.providerRegistry.getImageFinder() as unknown as {
      findMatch(r: { haystack: unknown; needle: unknown; confidence?: number }): Promise<{ confidence: number; location: { left: number; top: number } }>;
      findMatches(r: { haystack: unknown; needle: unknown; confidence?: number }): Promise<unknown[]>;
    };
    const dir = tmpDir();
    const tpl = path.join(dir, "tpl.png");
    await gui.screenshotSave(tpl, { x: win.x, y: win.y, width: 120, height: 60 });
    const needle = await n.loadImage(tpl);
    const hay = await n.screen.grab();
    const hit = await finder.findMatch({ haystack: hay, needle }); // no confidence given: 0.99
    expect([hit.location.left, hit.location.top]).toEqual([win.x, win.y]);
    expect((await finder.findMatches({ haystack: hay, needle })).length).toBeGreaterThanOrEqual(1);
    const noise = new Jimp(40, 40, 0);
    noise.scan(0, 0, 40, 40, (x: number, y: number, idx: number) => {
      noise.bitmap.data[idx] = (x * 91 + y * 17) % 256;
      noise.bitmap.data[idx + 1] = (x * 31) % 256;
      noise.bitmap.data[idx + 2] = (y * 57) % 256;
      noise.bitmap.data[idx + 3] = 255;
    });
    const nf = path.join(dir, "noise.png");
    write(nf, await noise.getBufferAsync("image/png"));
    await expect(finder.findMatch({ haystack: hay, needle: await n.loadImage(nf) })).rejects.toThrow(/no match for the image at confidence 0.99/);
    await expect(finder.findMatch({ haystack: hay, needle: await n.loadImage(nf), confidence: 0.97 })).rejects.toThrow(/confidence 0.97/);
    expect(await finder.findMatches({ haystack: hay, needle: await n.loadImage(nf) })).toEqual([]);
  });

  it("text finder: line and word queries, all matches, and no match", async () => {
    const n = await nut();
    const finder = n.providerRegistry.getTextFinder() as unknown as {
      findMatch(r: { haystack: unknown; needle: unknown }): Promise<{ location: { left: number; top: number } }>;
      findMatches(r: { haystack: unknown; needle: unknown }): Promise<{ location: { left: number } }[]>;
    };
    const hay = await n.screen.grab();
    const line = await finder.findMatch({ haystack: hay, needle: { by: { line: "HELLO WORLD" } } });
    expect(line.location.left).toBeGreaterThanOrEqual(win.x - 2);
    const words = await finder.findMatches({ haystack: hay, needle: { by: { word: "HELLO" } } });
    expect(words.length).toBeGreaterThanOrEqual(1);
    await expect(finder.findMatch({ haystack: hay, needle: { by: { word: "zebra" } } })).rejects.toThrow("no match for the text");
  }, 60_000);

  it("reads the whole screen when no region is given", async () => {
    const out = await vision.readText({ lang: "eng", scale: 1 }, "text");
    expect(out.toUpperCase()).toContain("HELLO");
    expect(await vision.findOnScreenText("HELLO", "contains", { lang: "eng", scale: 1 }, 3)).toContain("match 1");
  }, 60_000);

  it("the record tool reports a video when ffmpeg succeeds", async () => {
    const bin = tmpDir();
    makeBin(bin, "ffmpeg", 'for a; do last=$a; done; : > "$last"');
    const dir = path.join(tmpDir(), "vid");
    await withEnv({ PATH: bin }, async () => {
      const out = await callTool(vision.recordTool, { out_dir: dir, duration_seconds: 1, fps: 1, x: 0, y: 0, width: 20, height: 20 });
      expect(out).toBe(`recorded 1 frames to ${dir}; video: ${path.join(dir, "recording.mp4")}`);
    });
  });
});

describe.skipIf(!haveWm || !haveXterm)("the server's default active-window probe (policy loaded from a file)", () => {
  it("scopes input to the windows named in a policy FILE", async () => {
    await openWindow("file-scope", { geometry: "30x4+100+400" });
    await openWindow("file-other", { geometry: "30x4+500+400" });
    const f = path.join(tmpDir(), "policy.json");
    writeFileSync(f, JSON.stringify({ name: "from-file", default: "allow", gui: { windows: ["^file-scope$"] } }));
    const server = await buildServer({ policy: { file: f }, gui: true });
    const [a, bb] = InMemoryTransport.createLinkedPair();
    await server.connect(bb);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(a);
    await windowFocus({ title: "^file-scope$" });
    await sleep(200);
    expect(JSON.stringify(await c.callTool({ name: "mouse_position", arguments: {} }))).toContain("(");
    expect(JSON.stringify(await c.callTool({ name: "move_mouse", arguments: { x: 400, y: 400 } }))).toContain("moved");
    await windowFocus({ title: "^file-other$" });
    await sleep(200);
    const denied = await c.callTool({ name: "move_mouse", arguments: { x: 400, y: 400 } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("file-other");
    await c.close();
    stopAll();
  });
});
