import { describe, expect, it, vi } from "vitest";
import { planSearchQueries, selectPages } from "./search-planner";
import type { SearchResult } from "./types";

describe("planSearchQueries", () => {
  it("parses exact JSON with up to two queries", async () => {
    const callText = vi.fn(async () => '{"queries":["hello","world"]}');
    const result = await planSearchQueries({ userMessage: "search it", callText });
    expect(result.queries).toEqual(["hello", "world"]);
  });

  it("rejects fenced JSON and returns empty queries", async () => {
    const callText = vi.fn(async () => "```json\n{\"queries\":[\"a\"]}\n```");
    const result = await planSearchQueries({ userMessage: "x", callText });
    expect(result.queries).toEqual([]);
  });

  it("rejects invalid JSON", async () => {
    const callText = vi.fn(async () => "not json at all");
    const result = await planSearchQueries({ userMessage: "x", callText });
    expect(result.queries).toEqual([]);
  });

  it("rejects extra fields (strict)", async () => {
    const callText = vi.fn(async () => '{"queries":["a"],"extra":1}');
    const result = await planSearchQueries({ userMessage: "x", callText });
    expect(result.queries).toEqual([]);
  });

  it("accepts an empty queries array", async () => {
    const callText = vi.fn(async () => '{"queries":[]}');
    const result = await planSearchQueries({ userMessage: "x", callText });
    expect(result.queries).toEqual([]);
  });

  it("drops blank and overlong queries and dedupes", async () => {
    const callText = vi.fn(async () => JSON.stringify({ queries: ["valid", "  ", "valid", "x".repeat(300)] }));
    const result = await planSearchQueries({ userMessage: "x", callText });
    expect(result.queries).toEqual(["valid"]);
  });

  it("caps at two queries preserving order", async () => {
    const callText = vi.fn(async () => '{"queries":["a","b","c"]}');
    const result = await planSearchQueries({ userMessage: "x", callText });
    expect(result.queries).toEqual(["a", "b"]);
  });

  it("returns empty queries and a diagnostic when the model call fails", async () => {
    const callText = vi.fn(async () => {
      throw new Error("model down");
    });
    const result = await planSearchQueries({ userMessage: "x", callText });
    expect(result.queries).toEqual([]);
    expect(result.diagnostic).toBeTruthy();
    expect(result.diagnostic).not.toContain("model down"); // sanitized
  });

  it("returns empty queries when aborted", async () => {
    const callText = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const controller = new AbortController();
    controller.abort();
    const result = await planSearchQueries({ userMessage: "x", callText, signal: controller.signal });
    expect(result.queries).toEqual([]);
  });

  it("always returns zero to two unique strings", async () => {
    const callText = vi.fn(async () => '{"queries":["a","a","b"]}');
    const result = await planSearchQueries({ userMessage: "x", callText });
    expect(result.queries).toEqual(["a", "b"]);
    expect(result.queries.length).toBeLessThanOrEqual(2);
  });
});

describe("selectPages", () => {
  it("merges results in query order, dedupes canonical URLs, and selects the first three", () => {
    const q1: SearchResult[] = [
      { title: "a", url: "https://a.com/1", rank: 1 },
      { title: "b", url: "https://b.com/2", rank: 2 },
    ];
    const q2: SearchResult[] = [
      { title: "dup", url: "https://a.com/1", rank: 1 }, // duplicate of a.com/1
      { title: "c", url: "https://c.com/3", rank: 2 },
      { title: "d", url: "https://d.com/4", rank: 3 },
    ];
    const selected = selectPages([q1, q2], 3);
    expect(selected.map((r) => r.url)).toEqual([
      "https://a.com/1",
      "https://b.com/2",
      "https://c.com/3",
    ]);
    expect(selected.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("returns fewer than three when results are sparse", () => {
    const selected = selectPages([[{ title: "a", url: "https://a.com/1", rank: 1 }]], 3);
    expect(selected).toHaveLength(1);
  });
});