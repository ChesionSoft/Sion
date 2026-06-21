import { describe, expect, it } from "vitest";
import { createExternalSource, dedupeExternalSources, normalizeExternalUrl } from "./external-source";

describe("external-source", () => {
  describe("normalizeExternalUrl", () => {
    it("strips the hash and preserves everything else", () => {
      expect(normalizeExternalUrl("https://example.com/path?x=1#frag")).toBe("https://example.com/path?x=1");
    });

    it("preserves an already-clean url", () => {
      expect(normalizeExternalUrl("https://example.com/")).toBe("https://example.com/");
    });

    it("rejects non-url strings", () => {
      expect(() => normalizeExternalUrl("not a url")).toThrow();
    });
  });

  describe("createExternalSource", () => {
    it("produces a stable id derived from kind and url", () => {
      const src = createExternalSource({
        kind: "provided_url",
        url: "https://example.com/page",
        title: "Example",
        snippet: "片段",
        retrievedAt: "2026-06-21T00:00:00.000Z",
      });
      const again = createExternalSource({
        kind: "provided_url",
        url: "https://example.com/page",
        title: "Other",
        snippet: "different",
        retrievedAt: "2026-06-22T00:00:00.000Z",
      });
      expect(src.id).toBe(again.id);
      expect(src.id).toHaveLength(20);
      expect(src.url).toBe("https://example.com/page");
      expect(src.domain).toBe("example.com");
    });

    it("produces distinct ids across kinds and urls", () => {
      const a = createExternalSource({ kind: "provided_url", url: "https://a.test/", title: "A", retrievedAt: "t" });
      const b = createExternalSource({ kind: "web_search", url: "https://a.test/", title: "A", retrievedAt: "t" });
      const c = createExternalSource({ kind: "provided_url", url: "https://b.test/", title: "B", retrievedAt: "t" });
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    });
  });

  describe("dedupeExternalSources", () => {
    it("deduplicates by kind+url keeping the first occurrence", () => {
      const a = createExternalSource({ kind: "provided_url", url: "https://a.test/", title: "A1", retrievedAt: "t" });
      const b = createExternalSource({ kind: "provided_url", url: "https://a.test/", title: "A2", retrievedAt: "t" });
      const c = createExternalSource({ kind: "web_search", url: "https://a.test/", title: "C", retrievedAt: "t" });
      const result = dedupeExternalSources([a, b, c]);
      expect(result.map((r) => r.title)).toEqual(["A1", "C"]);
    });
  });
});