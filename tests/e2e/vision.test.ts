/** OCR, image matching, AI location, recording and plugin status, against the real screen. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Jimp from "jimp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { editDistance, findText, languageData, localLanguageData, recognize as ocrRecognize, shutdownOcr, type OcrResult } from "../../src/plugins/ocr.js";
import { MAX_FPS, MAX_SECONDS, record } from "../../src/plugins/recorder.js";
import { formatStatus, pluginStatus } from "../../src/plugins/status.js";
import { callTool } from "../../src/tools/base.js";
import * as gui from "../../src/tools/gui.js";
import * as vision from "../../src/tools/vision.js";
import { listWindows, windowFocus, type WinInfo } from "../../src/tools/window.js";
import { nut } from "../../src/nut/runtime.js";
import { makeBin, sleep, tmpDir, withEnv } from "../helpers.js";
import { haveWm, haveXterm, openWindow, stopAll } from "../x.js";

const q = { lang: "eng", scale: 1 } as const;
const inside = (w: WinInfo, cx: number, cy: number): boolean => cx >= w.x && cx <= w.x + w.width && cy >= w.y && cy <= w.y + w.height;
const rectOfWin = (w: WinInfo): { x: number; y: number; width: number; height: number } => ({ x: w.x, y: w.y, width: w.width, height: w.height });
const centerOf = (s: string): [number, number] => {
  const m = /center=\((\d+),(\d+)\)/.exec(s);
  return [Number(m?.[1]), Number(m?.[2])];
};

let big: WinInfo;
beforeAll(async () => {
  if (!haveWm) return;
  await openWindow("ocr-win", { geometry: "34x4+60+80", font: 30, text: "HELLO WORLD Save File" });
  big = (await listWindows()).find((w) => w.title === "ocr-win") as WinInfo;
  await windowFocus({ title: "ocr-win" });
  await sleep(300);
  big = (await listWindows()).find((w) => w.title === "ocr-win") as WinInfo;
});
afterAll(async () => { stopAll(); await shutdownOcr(); });

describe.skipIf(!haveWm || !haveXterm)("OCR on real screen text", () => {
  it("reads the text on screen", async () => {
    const text = await vision.readText({ ...q, region: rectOfWin(big) }, "text");
    expect(text.toUpperCase()).toContain("HELLO WORLD");
    expect(text).toContain("Save");
  }, 30_000);

  it("lists words with SCREEN coordinates inside the window", async () => {
    const out = await vision.readText({ ...q, region: rectOfWin(big) }, "words");
    const rows = out.split("\n").slice(1).map((l) => l.split("\t"));
    expect(out.split("\n")[0]).toBe("text\tx\ty\twidth\theight\tconfidence");
    const hello = rows.find((r) => r[0]?.toUpperCase() === "HELLO");
    expect(hello).toBeDefined();
    expect(Number(hello?.[1])).toBeGreaterThanOrEqual(big.x);
    expect(Number(hello?.[2])).toBeGreaterThanOrEqual(big.y);
    expect(Number(hello?.[1]) + Number(hello?.[3])).toBeLessThanOrEqual(big.x + big.width);
  });

  it("finds words and phrases, with exact and contains matching", async () => {
    const r = rectOfWin(big);
    const one = await vision.findOnScreenText("world", "contains", { ...q, region: r }, 5);
    expect(one).toMatch(/^match 1: x=\d+/);
    expect(inside(big, ...centerOf(one))).toBe(true);
    const phrase = await vision.findOnScreenText("Save File", "exact", { ...q, region: r }, 5);
    expect(phrase).toContain('text="Save File"');
    expect(await vision.findOnScreenText("sav", "exact", { ...q, region: r }, 5)).toBe("[no match]");
    expect(await vision.findOnScreenText("sav", "contains", { ...q, region: r }, 5)).toContain("match 1");
    expect(await vision.findOnScreenText("zebra", "contains", { ...q, region: r }, 5)).toBe("[no match]");
    expect(await vision.findOnScreenText("   ", "contains", { ...q, region: r }, 5)).toBe("[no match]");
  });

  it("works on an upscaled image and reports a blank region", async () => {
    const r = rectOfWin(big);
    expect(await vision.findOnScreenText("HELLO", "contains", { lang: "eng", scale: 2, region: r }, 1)).toContain("match 1");
    expect(await vision.readText({ ...q, region: { x: 900, y: 600, width: 200, height: 100 } }, "text")).toBe("[no text found]");
    expect(await vision.readText({ ...q, region: { x: 900, y: 600, width: 200, height: 100 } }, "words")).toBe("[no text found]");
  }, 30_000);

  it("click_text clicks the centre of the match", async () => {
    const r = rectOfWin(big);
    const out = await vision.clickText("WORLD", "contains", { ...q, region: r }, 1, "left", 1);
    const [cx, cy] = centerOf(out);
    expect(out).toContain(`clicked (${cx},${cy}) left x1`);
    expect(await gui.mousePosition()).toBe(`(${cx},${cy})`);
    expect(await vision.clickText("WORLD", "contains", { ...q, region: r }, 2, "left", 1)).toBe("[no match: nothing clicked]");
  });

  it("waits for text that appears later, and times out otherwise", async () => {
    const t = setTimeout(() => void openWindow("later-win", { geometry: "30x3+60+400", font: 30, text: "ARRIVED NOW" }), 600);
    const hit = await vision.waitForText("ARRIVED", "contains", { ...q, region: { x: 0, y: 330, width: 900, height: 300 } }, 20_000, 500);
    clearTimeout(t);
    expect(hit).toContain("match 1");
    await expect(vision.waitForText("never-there-xyz", "contains", { ...q, region: rectOfWin(big) }, 300, 100)).rejects.toThrow(/did not appear within 300 ms/);
  }, 60_000);

  it("the nut.js-native text search works once our OCR provider is registered", async () => {
    const n = await nut();
    vision.__resetProviders();
    vision.ensureProviders(n);
    const word = await n.screen.find(n.singleWord("HELLO"), { searchRegion: new n.Region(big.x, big.y, big.width, big.height) });
    expect(word.left).toBeGreaterThanOrEqual(big.x - 2);
    expect(word.top).toBeGreaterThanOrEqual(big.y - 2);
    await expect(n.screen.find(n.singleWord("zebra"), { searchRegion: new n.Region(big.x, big.y, big.width, big.height) })).rejects.toThrow();
  }, 60_000);

  it("tools validate their arguments", async () => {
    const t = Object.fromEntries(vision.visionTools.map((x) => [x.name, x]));
    const r = rectOfWin(big);
    expect(await callTool(t.screen_read_text!, { ...r, format: "text" })).toContain("HELLO");
    expect(await callTool(t.screen_find_text!, { ...r, text: "HELLO" })).toContain("match 1");
    expect(await callTool(t.screen_wait_for_text!, { ...r, text: "HELLO", timeout_ms: 5000 })).toContain("match 1");
    expect(await callTool(t.click_text!, { ...r, text: "HELLO" })).toContain("clicked");
    await expect(callTool(t.screen_find_text!, { text: "x", scale: 9 })).rejects.toThrow();
    await expect(callTool(t.screen_find_text!, { text: "x", x: 1 })).rejects.toThrow(/needs all of/);
  }, 60_000);
});

describe("OCR text matching (pure)", () => {
  const w = (text: string, x: number, y = 0, width = 40, conf = 0.9) => ({ text, confidence: conf, x, y, width, height: 20 });
  const line = (...ws: ReturnType<typeof w>[]) => ({ ...ws[0]!, text: ws.map((x) => x.text).join(" "), words: ws });
  const result: OcrResult = { text: "", confidence: 1, lines: [line(w("Save,", 10), w("File.", 60), w("now", 110, 0, 40, 0.5)), line(w("Cancel", 10, 40))], words: [] };
  it("matches normalised words and consecutive-word phrases, returning the union box", () => {
    expect(findText(result, "save file", "exact")[0]).toMatchObject({ x: 10, y: 0, width: 90, height: 20, text: "Save, File.", confidence: 0.9 });
    expect(findText(result, "file now", "exact")[0]?.confidence).toBe(0.5);
    expect(findText(result, "ile", "contains")).toHaveLength(1);
    expect(findText(result, "ile", "exact")).toEqual([]);
    expect(findText(result, "cancel")).toHaveLength(1);
    expect(findText(result, "…", "contains")).toEqual([]); // nothing left after normalising
    expect(findText(result, "a b c d e f")).toEqual([]);
  });
  it("language data resolution", () => {
    expect(languageData("eng", {}).langPath).toContain("@tesseract.js-data/eng");
    expect(languageData("eng+deu", {}).gzip).toBe(true);
    expect(languageData("eng", { OSAGENT_OCR_LANG_PATH: "/data" })).toEqual({ langPath: "/data", gzip: false });
    expect(languageData("xx-not-installed", {})).toEqual({});
  });
  it("never downloads models: a missing language is an error that says how to install it", () => {
    expect(localLanguageData("eng", {})).toMatchObject({ gzip: true });
    expect(localLanguageData("eng", { OSAGENT_OCR_LANG_PATH: "/models" })).toEqual({ langPath: "/models", gzip: false });
    expect(() => localLanguageData("xx", {})).toThrow(/language data for 'xx' is not installed.*npm install @tesseract\.js-data\/xx.*Nothing is downloaded automatically/);
    expect(() => localLanguageData("eng+yy+zz", {})).toThrow(/'yy', 'zz'/);
    expect(() => localLanguageData("eng+eng", {})).not.toThrow();
  });
  it("combined languages must live in one folder", () => {
    expect(() => localLanguageData("eng+deu", { OSAGENT_OCR_LANG_PATH: "/one" })).not.toThrow(); // env points both at one folder
    const split = (l: string) => ({ langPath: l === "eng" ? "/models/a" : "/models/b", gzip: true });
    expect(() => localLanguageData("eng+deu", {}, split)).toThrow(/live in different folders.*OSAGENT_OCR_LANG_PATH/);
    expect(localLanguageData("eng", {}, () => ({ langPath: "/only" }))).toEqual({ langPath: "/only", gzip: false }); // data package without a gzip flag
  });
  it("recognising with a missing language fails before any worker or network is involved", async () => {
    await expect(ocrRecognize(Buffer.from(""), "zz")).rejects.toThrow(/not installed/);
  });
  it("fuzzy matching tolerates OCR slips; edit distance", () => {
    const w = (text: string, x: number) => ({ text, confidence: 0.9, x, y: 0, width: 40, height: 20 });
    const line = (...ws: ReturnType<typeof w>[]) => ({ ...ws[0]!, text: ws.map((x) => x.text).join(" "), words: ws });
    const r: OcrResult = { text: "", confidence: 1, lines: [line(w("Sav3", 0), w("Fi1e", 50)), line(w("Totally", 0), w("Different", 50))], words: [] };
    expect(findText(r, "save file", "fuzzy")).toHaveLength(1);
    expect(findText(r, "save file", "exact")).toEqual([]);
    expect(findText(r, "cancel", "fuzzy")).toEqual([]);
    expect(findText(r, "sav", "fuzzy")).toHaveLength(1); // "sav3" is one edit from "sav"
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });
});

describe.skipIf(!haveWm || !haveXterm)("image matching on real screen pixels", () => {
  let tpl: string;
  const tplDir = mkdtempSync(path.join(os.tmpdir(), "osagent-tpl-")); // not tmpDir(): that is wiped after every test
  afterAll(() => rmSync(tplDir, { recursive: true, force: true }));
  beforeAll(async () => {
    tpl = path.join(tplDir, "tpl.png");
    // the window's top-left 160x70 pixels: its border and the first characters
    await gui.screenshotSave(tpl, { x: big.x, y: big.y, width: 160, height: 70 });
  });

  const base = (extra: object = {}) => ({ template: tpl, confidence: 0.98, scales: [1], max: 1, ...extra });

  it("finds the exact pixels where they are (and nowhere else)", async () => {
    const out = await vision.findImage(base());
    expect(out).toMatch(/^match 1: x=\d+/);
    const m = /x=(\d+) y=(\d+) width=160 height=70 center=\((\d+),(\d+)\) confidence=(\d\.\d+)/.exec(out)!;
    expect([Number(m[1]), Number(m[2])]).toEqual([big.x, big.y]);
    expect(Number(m[5])).toBeGreaterThan(0.98);
  });

  it("restricts the search to a region and reports screen (not region) coordinates", async () => {
    const hit = await vision.findImage(base({ region: { x: big.x - 20, y: big.y - 20, width: 300, height: 200 } }));
    expect(hit).toContain(`x=${big.x} y=${big.y}`);
    expect(await vision.findImage(base({ region: { x: 700, y: 500, width: 300, height: 200 } }))).toBe("[no match]");
  });

  it("find_images and wait_for_image and click_image", async () => {
    expect(await vision.findImage(base({ max: 5 }))).toContain("match 1");
    expect(await vision.waitForImage(base(), 3000, 100)).toContain(`x=${big.x} y=${big.y}`);
    const out = await vision.clickImage(base(), "left", 1, 5, 7);
    const [cx, cy] = centerOf(out);
    expect(await gui.mousePosition()).toBe(`(${cx + 5},${cy + 7})`);
    const blank = await vision.clickImage(base({ region: { x: 700, y: 500, width: 300, height: 200 } }), "left", 1, 0, 0);
    expect(blank).toBe("[no match: nothing clicked]");
    await expect(vision.waitForImage(base({ region: { x: 700, y: 500, width: 300, height: 200 } }), 300, 100)).rejects.toThrow(/did not appear within 300 ms/);
  });

  it("accepts a base64 template and several scales", async () => {
    const b64 = readFileSync(tpl).toString("base64");
    expect(await vision.findImage(base({ template: undefined, template_base64: `data:image/png;base64,${b64}` }))).toContain("match 1");
    const half = (await Jimp.read(tpl)).resize(80, 35);
    const halfB64 = (await half.getBufferAsync("image/png")).toString("base64");
    // Restrict the search to the window's top-left: a half-size template has lost the fine text strokes, so on the
    // full screen other upscaled glyph blocks can score higher. Here the only plausible hit is the original region.
    const near = { x: big.x - 20, y: big.y - 20, width: 360, height: 200 };
    const scaled = await vision.findImage(base({ template: undefined, template_base64: halfB64, scales: [0.5, 2], confidence: 0.8, region: near, max: 5 }));
    expect(scaled).toContain(`x=${big.x} y=${big.y}`); // the 2x version of the half-size template is the original size
  });

  it("explains missing or unreadable templates", async () => {
    await expect(vision.findImage(base({ template: undefined }))).rejects.toThrow(/give a template file path or template_base64/);
    await expect(vision.findImage(base({ template: "/definitely/missing.png" }))).rejects.toThrow();
  });

  it("the nut.js-native image search works once our matcher is registered", async () => {
    const n = await nut();
    vision.__resetProviders();
    vision.ensureProviders(n);
    n.screen.config.resourceDirectory = path.dirname(tpl);
    const region = await n.screen.find(n.imageResource("tpl.png"), { confidence: 0.98 });
    expect([region.left, region.top]).toEqual([big.x, big.y]);
    const all = await n.screen.findAll(n.imageResource("tpl.png"), { confidence: 0.98 });
    expect(all.length).toBeGreaterThanOrEqual(1);
    await expect(n.screen.find(n.imageResource("tpl.png"), { confidence: 0.98, searchRegion: new n.Region(700, 500, 300, 200) })).rejects.toThrow();
  });

  it("tools validate their arguments", async () => {
    const t = Object.fromEntries(vision.visionTools.map((x) => [x.name, x]));
    const near = { x: big.x - 10, y: big.y - 10, width: 320, height: 160 }; // keeps each full tool call fast
    expect(await callTool(t.screen_find_image!, { template: tpl, ...near })).toContain("match 1");
    expect(await callTool(t.screen_find_images!, { template: tpl, ...near })).toContain("match 1");
    expect(await callTool(t.screen_wait_for_image!, { template: tpl, timeout_ms: 2000, ...near })).toContain("match 1");
    expect(await callTool(t.click_image!, { template: tpl, ...near })).toContain("clicked");
    await expect(callTool(t.screen_find_image!, { template: tpl, confidence: 2 })).rejects.toThrow();
    await expect(callTool(t.screen_find_image!, { template: tpl, scales: [] })).rejects.toThrow();
  }, 120_000);
});

describe.skipIf(!haveWm)("screen recording", () => {
  it("writes numbered PNG frames at the requested size", async () => {
    const dir = path.join(tmpDir(), "rec");
    const r = await record(dir, 1, 3, { x: 0, y: 0, width: 200, height: 100 }, false);
    expect(r).toEqual({ dir, frames: 3 });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["frame-0001.png", "frame-0002.png", "frame-0003.png"]);
    const png = readFileSync(path.join(dir, files[0]!));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([200, 100]);
  });

  it("limits duration and frame rate", async () => {
    await expect(record(tmpDir(), 0, 2)).rejects.toThrow(/duration must be between 0 and 60/);
    await expect(record(tmpDir(), MAX_SECONDS + 1, 2)).rejects.toThrow(/duration/);
    await expect(record(tmpDir(), 1, 0)).rejects.toThrow(/fps must be between 0 and 10/);
    await expect(record(tmpDir(), 1, MAX_FPS + 1)).rejects.toThrow(/fps/);
  });

  it("encodes a video when ffmpeg exists, and says so when it does not or it fails", async () => {
    const bin = tmpDir();
    makeBin(bin, "ffmpeg", 'for a; do last=$a; done; echo "$@" > "$last"');
    const dir = path.join(tmpDir(), "v");
    await withEnv({ PATH: bin }, async () => {
      const r = await record(dir, 1, 2, { x: 0, y: 0, width: 50, height: 50 }, true);
      expect(r.video).toBe(path.join(dir, "recording.mp4"));
      expect(readFileSync(r.video as string, "utf8")).toContain("-framerate 2");
    });
    const bad = tmpDir();
    makeBin(bad, "ffmpeg", "echo boom >&2; exit 1");
    await withEnv({ PATH: bad }, async () => {
      const r = await record(path.join(tmpDir(), "b"), 1, 1, { x: 0, y: 0, width: 50, height: 50 }, true);
      expect(r.video).toBeUndefined();
      expect(r.note).toBe("ffmpeg failed: boom");
    });
    await withEnv({ PATH: tmpDir() }, async () => {
      expect((await record(path.join(tmpDir(), "n"), 1, 1, { x: 0, y: 0, width: 50, height: 50 }, true)).note).toContain("ffmpeg not found");
    });
  });

  it("the tool reports frames, video and notes", async () => {
    const dir = path.join(tmpDir(), "tool");
    const out = await callTool(vision.recordTool, { out_dir: dir, duration_seconds: 1, fps: 2, video: false, x: 0, y: 0, width: 40, height: 40 });
    expect(out).toBe(`recorded 2 frames to ${dir}`);
    expect(existsSync(path.join(dir, "frame-0002.png"))).toBe(true);
    await withEnv({ PATH: tmpDir() }, async () => {
      expect(await callTool(vision.recordTool, { out_dir: path.join(tmpDir(), "t2"), duration_seconds: 1, fps: 1, x: 0, y: 0, width: 40, height: 40 })).toContain("ffmpeg not found");
    });
  });
});

describe("plugin status", () => {
  it("maps every official nut.js plugin to a tool or an honest 'unavailable'", () => {
    const rows = pluginStatus({});
    expect(rows).toHaveLength(10);
    const by = (s: string) => rows.find((r) => r.official.includes(s))!;
    expect(by("template-matcher").status).toBe("available");
    expect(by("plugin-ocr").status).toBe("available");
    expect(by("plugin-ocr").tools).toContain("click_text");
    expect(by("plugin-screenrecording").tools).toEqual(["screen_record"]);
    for (const s of ["plugin-ai-sdk", "plugin-azure", "element-inspector", "playwright-bridge", "selenium-bridge", "plugin-rdp", "bolt"]) {
      expect(by(s).status).toBe("unavailable");
      expect(by(s).tools).toEqual([]);
    }
    expect(by("plugin-ai-sdk").detail).toContain("cloud LLM and an API key, which this package deliberately does not use");
    const text = formatStatus(rows);
    expect(text).toContain("[x] @nut-tree/plugin-ocr");
    expect(text).toContain("[ ] @nut-tree/plugin-azure");
    expect(text).toContain("tools: screen_find_image, screen_find_images");
    expect(vision.pluginStatusTool.run({})).toBe(formatStatus(pluginStatus()));
  });
});
