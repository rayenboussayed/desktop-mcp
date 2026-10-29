import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchUrl, fetchUrlTool, htmlToText, parseResults, unescapeHtml, webSearch, webSearchTool } from "../src/tools/search.js";
import { withEnv } from "./helpers.js";

const PAGE =
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">Ex &amp; Co</a>' +
  '<a class="result__snippet" href="#">A <b>snippet</b></a>' +
  '<a class="result__a" href="https://plain.example/y">Plain</a>' +
  '<a class="result__snippet" href="#">second</a>';

let srv: Server;
let base: string;
let lastBody = "";
let lastUA = "";

beforeAll(async () => {
  srv = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/search") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        lastBody = body;
        lastUA = String(req.headers["user-agent"]);
        res.setHeader("content-type", "text/html");
        res.end(PAGE);
      });
    } else if (url === "/empty") res.end("<html></html>");
    else if (url === "/page") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end("<p>Hello</p><script>x()</script><p>there&amp;</p>"); }
    else if (url === "/json") { res.setHeader("content-type", "application/json"); res.end('{"a": 1}'); }
    else if (url === "/big") { res.setHeader("content-type", "text/plain"); res.end("x".repeat(100)); }
    else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => void srv.close());

describe("parsing", () => {
  it("parses real DDG-shaped HTML", () => {
    const r = parseResults(PAGE, 5);
    expect(r[0]).toEqual({ title: "Ex & Co", url: "https://example.com/x", snippet: "A snippet" });
    expect(r[1]?.url).toBe("https://plain.example/y"); // no uddg wrapper: returned as is
    expect(parseResults(PAGE, 1)).toHaveLength(1);
    expect(parseResults("<p>nothing</p>", 5)).toEqual([]);
  });
  it("converts html to text", () => {
    expect(htmlToText("<p>Hi</p><script>x()</script><p>there&amp;</p>")).toBe("Hi\nthere&");
    expect(htmlToText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("a<br/>b<style>p{}</style>")).toBe("a\nb");
  });
  it("unescapes entities", () => {
    expect(unescapeHtml("&amp;&lt;&gt;&quot;&#39;&#x41;&nbsp;&hellip;&unknown;&#xZZ;&#99999999999;")).toBe(
      "&<>\"'A\u00a0…&unknown;&#xZZ;&#99999999999;",
    );
  });
});

describe("web_search over real HTTP", () => {
  it("returns formatted results and sends the query as a form", async () => {
    await withEnv({ OSAGENT_SEARCH_URL: `${base}/search` }, async () => {
      const out = await webSearch("hello world");
      expect(out).toContain("1. Ex & Co");
      expect(out).toContain("https://example.com/x");
      expect(out).toContain("2. Plain");
    });
    expect(lastBody).toBe("q=hello+world");
    expect(lastUA).toContain("osagent");
  });
  it("handles no results and errors", async () => {
    await withEnv({ OSAGENT_SEARCH_URL: `${base}/empty` }, async () => expect(await webSearch("q")).toBe("[no results]"));
    await withEnv({ OSAGENT_SEARCH_URL: `${base}/missing` }, async () => expect(await webSearch("q")).toContain("[error] search failed: HTTP 404"));
    await withEnv({ OSAGENT_SEARCH_URL: "http://127.0.0.1:1/x" }, async () => expect(await webSearch("q")).toContain("[error] search failed"));
  });
  it("works through the tool wrapper with defaults", async () => {
    await withEnv({ OSAGENT_SEARCH_URL: `${base}/search` }, async () => {
      expect(await webSearchTool.run({ query: "q", max_results: 1 })).not.toContain("2. Plain");
    });
  });
});

describe("fetch_url over real HTTP", () => {
  it("converts html, passes json, truncates, reports errors", async () => {
    expect(await fetchUrl(`${base}/page`)).toBe("Hello\nthere&");
    expect(await fetchUrl(`${base}/json`)).toBe('{"a": 1}');
    expect(await fetchUrl(`${base}/big`, 20)).toContain("truncated 80 chars");
    expect(await fetchUrl(`${base}/nope`)).toContain("[error] fetch failed: HTTP 404");
    expect(await fetchUrl("http://127.0.0.1:1/")).toContain("[error] fetch failed");
    expect(await fetchUrlTool.run({ url: `${base}/json`, max_chars: 100 })).toBe('{"a": 1}');
  });
});
