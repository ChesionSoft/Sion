import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baiduSearchAdapter } from "./baidu-search";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, "__fixtures__", "search", name), "utf8");
}

describe("baiduSearchAdapter", () => {
  it("builds a search URL with the encoded query", () => {
    expect(baiduSearchAdapter.buildUrl("你好 世界")).toBe(
      "https://www.baidu.com/s?wd=%E4%BD%A0%E5%A5%BD%20%E4%B8%96%E7%95%8C",
    );
  });

  it("parses normal results in rank order using the cite URL", async () => {
    const results = baiduSearchAdapter.parseHtml(await fixture("baidu-results.html"));
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.url)).toEqual([
      "https://example.com/page1",
      "https://example.com/page2",
      "https://example.com/page3",
      "https://example.com/page4",
      "https://example.com/page5",
    ]);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("includes snippet when present and omits it when absent", async () => {
    const results = baiduSearchAdapter.parseHtml(await fixture("baidu-results.html"));
    expect(results[0].snippet).toBe("Snippet one about page one");
    expect(results[2].snippet).toBeUndefined();
  });

  it("drops ads, internal baidu links, duplicates, and malformed cites", async () => {
    const results = baiduSearchAdapter.parseHtml(await fixture("baidu-results.html"));
    const urls = results.map((r) => r.url);
    expect(urls).not.toContain("https://ad.example.com/buy");
    expect(urls).not.toContain("https://www.baidu.com/help");
    expect(urls.filter((u) => u === "https://example.com/page1")).toHaveLength(1);
  });

  it("caps at five results", async () => {
    const results = baiduSearchAdapter.parseHtml(await fixture("baidu-results.html"));
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("returns [] for an empty/unrecognized page", () => {
    expect(baiduSearchAdapter.parseHtml("<html><body>nothing</body></html>")).toEqual([]);
  });

  it("detects a verification/challenge page", async () => {
    expect(baiduSearchAdapter.detectVerification(await fixture("baidu-verification.html"))).toBe(true);
  });

  it("does not flag a normal results page as verification", async () => {
    expect(baiduSearchAdapter.detectVerification(await fixture("baidu-results.html"))).toBe(false);
  });
});