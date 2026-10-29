/**
 * nut.js provider adapters. Registering these makes nut.js' own `screen.find(...)` / `screen.waitFor(...)` work
 * with image resources, `singleWord()/textLine()` text queries and `windowWithTitle()`, exactly as the official
 * template-matcher and OCR plugins do, but with the open-source engines in this package.
 */
import { findText, recognize } from "./ocr.js";
import { findTemplate, type Bitmap } from "./matcher.js";
import { listWindows } from "../tools/window.js";
import type { Nut } from "../nut/runtime.js";

type NutImage = Parameters<Nut["imageToJimp"]>[0];
interface Req<T> { haystack: NutImage; needle: T; confidence?: number }

const bitmap = async (n: Nut, img: NutImage): Promise<Bitmap & { png: Buffer }> => {
  const j = await n.imageToJimp(img);
  return { ...j.bitmap, png: await j.getBufferAsync("image/png") };
};

export interface ProviderNames { image: true; text: true; window: true }

/**
 *
 * @param n - Nut.js module or runtime instance.
 * @param lang - OCR language code.
 * @returns The registered provider names.
 */
export function registerProviders(n: Nut, lang = "eng"): ProviderNames {
  const reg = n.providerRegistry;
  const region = (m: { x: number; y: number; width: number; height: number }): InstanceType<Nut["Region"]> => new n.Region(m.x, m.y, m.width, m.height);

  reg.registerImageFinder({
    async findMatch(req: Req<NutImage>) {
      const [hay, needle] = [await bitmap(n, req.haystack), await bitmap(n, req.needle)];
      const m = findTemplate(hay, needle, { confidence: req.confidence ?? 0.99, maxResults: 1 })[0];
      if (!m) throw new Error(`no match for the image at confidence ${req.confidence ?? 0.99}`);
      return new n.MatchResult(m.confidence, region(m));
    },
    async findMatches(req: Req<NutImage>) {
      const [hay, needle] = [await bitmap(n, req.haystack), await bitmap(n, req.needle)];
      return findTemplate(hay, needle, { confidence: req.confidence ?? 0.99, maxResults: 50 }).map((m) => new n.MatchResult(m.confidence, region(m)));
    },
  } as never);

  const textHits = async (req: Req<{ by: { word?: string; line?: string } }>) => {
    const ocr = await recognize((await bitmap(n, req.haystack)).png, lang);
    const by = req.needle.by;
    return "word" in by ? findText(ocr, by.word as string, "exact") : findText(ocr, by.line as string, "contains");
  };
  reg.registerTextFinder({
    async findMatch(req: Req<{ by: { word?: string; line?: string } }>) {
      const hit = (await textHits(req))[0];
      if (!hit) throw new Error("no match for the text");
      return new n.MatchResult(hit.confidence, region(hit));
    },
    async findMatches(req: Req<{ by: { word?: string; line?: string } }>) {
      return (await textHits(req)).map((h) => new n.MatchResult(h.confidence, region(h)));
    },
  } as never);

  const windowMatches = async (q: { by: { title: string | RegExp } }): Promise<number[]> => {
    const t = q.by.title;
    return (await listWindows()).filter((w) => (typeof t === "string" ? w.title === t : t.test(w.title))).map((w) => w.handle);
  };
  reg.registerWindowFinder({
    async findMatch(q: { by: { title: string | RegExp } }) {
      const h = (await windowMatches(q))[0];
      if (h === undefined) throw new Error("no window matches the title");
      return h;
    },
    findMatches: windowMatches,
  } as never);
  return { image: true, text: true, window: true };
}
