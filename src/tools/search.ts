import { z } from "zod";
import { defineTool, truncate } from "./base.js";

const UA = "Mozilla/5.0 (compatible; osagent/0.1)";
export const DEFAULT_SEARCH_URL = "https://html.duckduckgo.com/html/";
export const searchUrl = (env: NodeJS.ProcessEnv = process.env): string => env.OSAGENT_SEARCH_URL || DEFAULT_SEARCH_URL;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·",
  laquo: "«", raquo: "»", euro: "€", bull: "•", times: "×",
};

/**
 * Decode numeric and the common named HTML entities.
 * @param s - HTML source.
 * @returns The decoded text.
 */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

const clean = (s: string): string => unescapeHtml(s.replace(/<[^>]+>/g, "")).trim();

/**
 *
 * @param href - Raw link target.
 * @returns The resulting text.
 */
function realUrl(href: string): string {
  // DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<encoded>
  if (href.includes("uddg=")) {
    try {
      return new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href;
    } catch {
      return href;
    }
  }
  return href;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 *
 * @param page - HTML page source.
 * @param maxResults - Maximum results to return.
 * @returns The parsed search results.
 */
export function parseResults(page: string, maxResults: number): SearchResult[] {
  const out: SearchResult[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="(?<href>[^"]+)"[^>]*>(?<title>.*?)<\/a>.*?class="result__snippet"[^>]*>(?<snip>.*?)<\/a>/gs;
  for (const m of page.matchAll(re)) {
    const g = m.groups as { href: string; title: string; snip: string };
    out.push({ title: clean(g.title), url: realUrl(unescapeHtml(g.href)), snippet: clean(g.snip) });
    if (out.length >= maxResults) break;
  }
  return out;
}

/**
 *
 * @param query - Text to search for.
 * @param maxResults - Maximum results to return.
 * @returns A human-readable result.
 */
export async function webSearch(query: string, maxResults = 8): Promise<string> {
  let text: string;
  try {
    const r = await fetch(searchUrl(), {
      method: "POST",
      body: new URLSearchParams({ q: query }),
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    text = await r.text();
  } catch (e) {
    return `[error] search failed: ${(e as Error).message}`;
  }
  const results = parseResults(text, maxResults);
  if (results.length === 0) return "[no results]";
  return results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n");
}

/**
 *
 * @param page - HTML page source.
 * @returns The resulting text.
 */
export function htmlToText(page: string): string {
  page = page.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  page = page.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  let text = unescapeHtml(page.replace(/<[^>]+>/g, " "));
  text = text.replace(/[ \t\r\f\v]+/g, " ").replace(/ ?\n ?/g, "\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 *
 * @param url - URL to fetch.
 * @param maxChars - Maximum characters to return.
 * @returns A human-readable result.
 */
export async function fetchUrl(url: string, maxChars = 15_000): Promise<string> {
  let ctype: string;
  let body: string;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ctype = r.headers.get("content-type") ?? "";
    body = await r.text();
  } catch (e) {
    return `[error] fetch failed: ${(e as Error).message}`;
  }
  return truncate(ctype.includes("html") ? htmlToText(body) : body, maxChars);
}

export const webSearchTool = defineTool({
  name: "web_search",
  description: "Search the web and return titles, URLs and snippets. Follow up with fetch_url to read a page.",
  shape: { query: z.string(), max_results: z.number().int().default(8) },
  run: ({ query, max_results }) => webSearch(query, max_results),
  readOnly: true,
});

export const fetchUrlTool = defineTool({
  name: "fetch_url",
  description: "Download a web page and return its readable text.",
  shape: { url: z.string(), max_chars: z.number().int().default(15_000) },
  run: ({ url, max_chars }) => fetchUrl(url, max_chars),
  readOnly: true,
});
