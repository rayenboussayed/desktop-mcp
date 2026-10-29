/**
 * OCR: an open-source stand-in for nut.js' plugin-ocr, built on tesseract.js (WebAssembly, no system install).
 * English data ships with the optional `@tesseract.js-data/eng` package, so it works fully offline. Other
 * languages: install `@tesseract.js-data/<code>` (e.g. `deu`, `fra`, `jpn`), or point OSAGENT_OCR_LANG_PATH at a
 * directory holding `<code>.traineddata` files (needed for combined languages like `eng+deu`).
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

interface OcrWord { text: string; confidence: number; x: number; y: number; width: number; height: number }
interface OcrLine extends OcrWord { words: OcrWord[] }
export interface OcrResult { text: string; confidence: number; lines: OcrLine[]; words: OcrWord[] }

interface TessWorker {
  recognize(image: Buffer, opts: object, output: object): Promise<{ data: { text: string; confidence: number; blocks: TessBlock[] | null } }>;
  terminate(): Promise<unknown>;
}
interface TessBox { x0: number; y0: number; x1: number; y1: number }
interface TessWord { text: string; confidence: number; bbox: TessBox }
interface TessLine extends TessWord { words: TessWord[] }
interface TessBlock { paragraphs: { lines: TessLine[] }[] }
interface TessModule { createWorker(lang: string, oem: number, opts: object): Promise<TessWorker> }

const require_ = createRequire(import.meta.url);
let loadEngine: () => Promise<TessModule> = () => import("tesseract.js") as unknown as Promise<TessModule>;
const workers = new Map<string, Promise<TessWorker>>();

/**
 * Test hook: replace the tesseract.js loader (and forget running workers).
 * @param fn - Engine loader to install, or `undefined` to restore the default.
 */
export function __setOcrEngine(fn: (() => Promise<TessModule>) | undefined): void {
  loadEngine = fn ?? (() => import("tesseract.js") as unknown as Promise<TessModule>);
  workers.clear();
}

/**
 * Where the traineddata for `lang` lives, if we can tell.
 * @param lang - OCR language code.
 * @param env - Environment to inspect.
 * @returns Language data paths when the package is installed.
 */
export function languageData(lang: string, env: NodeJS.ProcessEnv = process.env): { langPath?: string; gzip?: boolean } {
  if (env.OSAGENT_OCR_LANG_PATH) return { langPath: env.OSAGENT_OCR_LANG_PATH, gzip: false };
  try {
    const pkg = require_(`@tesseract.js-data/${(lang.split("+")[0] as string).replace(/[^a-z_]/gi, "")}`) as { langPath: string; gzip: boolean };
    return { langPath: pkg.langPath, gzip: pkg.gzip };
  } catch {
    return {}; // tesseract.js falls back to downloading the data (needs network)
  }
}

/**
 * Language data for `lang` (`eng`, or `eng+deu`), strictly from this machine. tesseract.js would otherwise fetch
 * missing models from a CDN; we never let it: a missing language is an error that says how to install it.
 * @param lang - OCR language code.
 * @param env - Environment to inspect.
 * @param lookup - Language data lookup function.
 * @returns Local language data paths, or an error when missing.
 */
export function localLanguageData(lang: string, env: NodeJS.ProcessEnv = process.env, lookup: typeof languageData = languageData): { langPath: string; gzip: boolean } {
  const parts = lang.split("+");
  const found = parts.map((p) => ({ p, d: lookup(p, env) }));
  const missing = found.filter((f) => f.d.langPath === undefined).map((f) => f.p);
  if (missing.length > 0) {
    throw new Error(
      `OCR language data for ${missing.map((m) => `'${m}'`).join(", ")} is not installed. Install it with: npm install ${missing.map((m) => `@tesseract.js-data/${m}`).join(" ")} ` +
        "(or point OSAGENT_OCR_LANG_PATH at a folder of .traineddata files). Nothing is downloaded automatically.",
    );
  }
  const first = found[0]?.d as { langPath: string; gzip: boolean };
  if (found.some((f) => f.d.langPath !== first.langPath)) {
    throw new Error(`OCR languages ${parts.join("+")} live in different folders: put their .traineddata files in one folder and set OSAGENT_OCR_LANG_PATH to it.`);
  }
  return { langPath: first.langPath, gzip: first.gzip ?? false };
}

/**
 *
 * @param lang - OCR language code.
 * @returns The cached OCR worker.
 */
function workerFor(lang: string): Promise<TessWorker> {
  let w = workers.get(lang);
  if (!w) {
    w = Promise.resolve()
      .then(() => localLanguageData(lang))
      .then(async (data) => (await loadEngine()).createWorker(lang, 1, { ...data, cachePath: path.join(os.tmpdir(), "osagent-ocr-cache") }));
    w.catch(() => workers.delete(lang)); // a failed start must not be cached
    workers.set(lang, w);
  }
  return w;
}

const box = (b: TessBox): { x: number; y: number; width: number; height: number } => ({ x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 });
const word = (w: TessWord): OcrWord => ({ text: w.text, confidence: w.confidence / 100, ...box(w.bbox) });

/**
 * Recognise text in a PNG. Coordinates are pixels of that image.
 * @param png - PNG image data.
 * @param lang - OCR language code.
 * @returns The recognised text and word geometry.
 */
export async function recognize(png: Buffer, lang = "eng"): Promise<OcrResult> {
  const worker = await workerFor(lang);
  const { data } = await worker.recognize(png, {}, { blocks: true });
  const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).map((l): OcrLine => ({ ...word(l), text: l.text.trim(), words: l.words.map(word) }));
  return { text: data.text, confidence: data.confidence / 100, lines, words: lines.flatMap((l) => l.words) };
}

/**
 *
 */
export async function shutdownOcr(): Promise<void> {
  const all = [...workers.values()];
  workers.clear();
  await Promise.allSettled(all.map(async (w) => (await w).terminate()));
}

// ------------------------------------------------------------ text search
const norm = (s: string): string => s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

export type TextMatchMode = "exact" | "contains" | "fuzzy";

export interface TextHit { text: string; x: number; y: number; width: number; height: number; confidence: number }

/**
 * Levenshtein edit distance.
 * @param a - First string.
 * @param b - Second string.
 * @returns The Levenshtein distance.
 */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    // eslint-disable-next-line security/detect-object-injection
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] as number;
}

/**
 * Find a word or phrase (consecutive words on one line) in an OCR result. `fuzzy` tolerates OCR slips such as
 * `Sav3 Fi1e`: up to a quarter of the characters may differ (at least one).
 * @param result - OCR result to search.
 * @param query - Text to search for.
 * @param mode - Text matching mode.
 * @returns Matching text hits.
 */
export function findText(result: OcrResult, query: string, mode: TextMatchMode = "contains"): TextHit[] {
  const tokens = query.split(/\s+/).filter(Boolean).map(norm).filter(Boolean);
  if (tokens.length === 0) return [];
  const wanted = tokens.join(" ");
  const hits: TextHit[] = [];
  for (const line of result.lines) {
    for (let i = 0; i + tokens.length <= line.words.length; i++) {
      const win = line.words.slice(i, i + tokens.length);
      const joined = win.map((w) => norm(w.text)).join(" ");
      const ok = mode === "exact" ? joined === wanted : mode === "fuzzy" ? editDistance(joined, wanted) <= Math.max(1, Math.floor(wanted.length / 4)) : joined.includes(wanted);
      if (ok) {
        const x = Math.min(...win.map((w) => w.x));
        const y = Math.min(...win.map((w) => w.y));
        hits.push({
          text: win.map((w) => w.text).join(" "), x, y,
          width: Math.max(...win.map((w) => w.x + w.width)) - x, height: Math.max(...win.map((w) => w.y + w.height)) - y,
          confidence: Math.min(...win.map((w) => w.confidence)),
        });
      }
    }
  }
  return hits;
}
