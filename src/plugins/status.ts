import { createRequire } from "node:module";
import { languageData } from "./ocr.js";
import { which } from "../platform.js";

const require_ = createRequire(import.meta.url);

export interface PluginRow {
  /** The official nut.js plugin (https://nutjs.dev/plugins). */
  official: string;
  status: "available" | "unavailable";
  /** What provides it here, or why it cannot. */
  detail: string;
  tools: string[];
}

const installed = (pkg: string): boolean => {
  try {
    require_.resolve(pkg);
    return true;
  } catch {
    return false;
  }
};

/**
 * Every plugin on nutjs.dev's plugin list is sold behind a private registry subscription, and none is on public npm.
 * Where an open-source equivalent is feasible it is built in; the rest are reported as unavailable, never faked.
 * @param env - Environment to inspect.
 * @param has - Package availability predicate.
 * @returns Status rows for each known plugin.
 */
export function pluginStatus(env: NodeJS.ProcessEnv = process.env, has: (pkg: string) => boolean = installed): PluginRow[] {
  const matcher = has("jimp");
  const ocrOk = has("tesseract.js") && languageData("eng", env).langPath !== undefined;
  const note = (pkg: string): string => (has(pkg) ? ` The official package ${pkg} is installed but is not wired in here.` : "");
  const no = (official: string, why: string): PluginRow => ({ official, status: "unavailable", detail: `${why}${note(official)}`, tools: [] });
  return [
    {
      official: "@nut-tree/nl-matcher + @nut-tree/template-matcher (image matching)", status: matcher ? "available" : "unavailable",
      detail: matcher ? "built-in pure-JS template matcher (exact, alpha-mask aware, multi-scale)" : "needs the optional dependency 'jimp'",
      tools: ["screen_find_image", "screen_find_images", "screen_wait_for_image", "click_image"],
    },
    {
      official: "@nut-tree/plugin-ocr (text on screen)", status: ocrOk ? "available" : "unavailable",
      detail: ocrOk ? "tesseract.js with offline English data (add @tesseract.js-data/<lang> for more languages)" : "needs the optional dependencies 'tesseract.js' and '@tesseract.js-data/eng'",
      tools: ["screen_read_text", "screen_find_text", "screen_wait_for_text", "click_text"],
    },
    {
      official: "@nut-tree/plugin-screenrecording", status: "available",
      detail: which("ffmpeg") ? "PNG frames, encoded to MP4 with ffmpeg" : "PNG frames (install ffmpeg for MP4)",
      tools: ["screen_record"],
    },
    no("@nut-tree/plugin-ai-sdk", "AI element location needs a cloud LLM and an API key, which this package deliberately does not use; find things locally with screen_find_text (exact or fuzzy), screen_find_image or screen_find_color."),
    no("@nut-tree/plugin-azure", "Azure OCR is a cloud service that needs credentials; the built-in OCR runs locally."),
    no("@nut-tree/element-inspector", "UI-element inspection needs the proprietary accessibility plugin; use OCR/image/AI location instead."),
    no("@nut-tree/playwright-bridge", "proprietary bridge; use a browser automation MCP server for web pages."),
    no("@nut-tree/selenium-bridge", "proprietary bridge; use a browser automation MCP server for web pages."),
    no("@nut-tree/plugin-rdp", "proprietary remote-desktop plugin."),
    no("@nut-tree/bolt", "proprietary test-framework runner, not an automation capability."),
  ];
}

/**
 *
 * @param rows - Plugin status rows.
 * @returns A formatted plugin status table.
 */
export function formatStatus(rows: PluginRow[]): string {
  return rows.map((r) => `${r.status === "available" ? "[x]" : "[ ]"} ${r.official}\n    ${r.detail}${r.tools.length ? `\n    tools: ${r.tools.join(", ")}` : ""}`).join("\n");
}
