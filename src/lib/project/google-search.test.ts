import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { googleSearchAdapter } from "./google-search";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, "__fixtures__", "search", name), "utf8");
}

describe("googleSearchAdapter", () => {
  it("builds a search URL with the encoded query", () => {
    expect(googleSearchAdapter.buildUrl("hello world")).toBe(
      "https://www.google.com/search?q=hello%20world",
    );
  });

  it("parses normal results in rank order with restored redirect URLs", async () => {
    const results = googleSearchAdapter.parseHtml(await fixture("google-results.html"));
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

  it("restores the real URL from the /url?q= redirect wrapper", async () => {
    const results = googleSearchAdapter.parseHtml(await fixture("google-results.html"));
    expect(results[0].url).toBe("https://example.com/page1");
    expect(results[0].title).toBe("Example Page 1");
    expect(results[0].snippet).toBe("Snippet one about page one");
  });

  it("drops ads, internal google links, duplicates, and malformed links", async () => {
    const results = googleSearchAdapter.parseHtml(await fixture("google-results.html"));
    const urls = results.map((r) => r.url);
    expect(urls).not.toContain("https://ad.example.com/buy");
    expect(urls).not.toContain("https://www.google.com/help");
    // duplicate page1 appears only once
    expect(urls.filter((u) => u === "https://example.com/page1")).toHaveLength(1);
  });

  it("caps at five results", async () => {
    const results = googleSearchAdapter.parseHtml(await fixture("google-results.html"));
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("returns [] for an empty/unrecognized page", () => {
    expect(googleSearchAdapter.parseHtml("<html><body>nothing here</body></html>")).toEqual([]);
  });

  it("detects a verification/challenge page", async () => {
    expect(googleSearchAdapter.detectVerification(await fixture("google-verification.html"))).toBe(true);
  });

  it("does not flag a normal results page as verification", async () => {
    expect(googleSearchAdapter.detectVerification(await fixture("google-results.html"))).toBe(false);
  });
});