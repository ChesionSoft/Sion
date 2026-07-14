import { describe, expect, it } from "vitest";
import { MAX_MODEL_WEB_CONTENT_CHARS, WebToolBudget } from "./web-tool-budget";

describe("WebToolBudget/searches", () => {
  it("allows up to two searches and denies the third", () => {
    const budget = new WebToolBudget();
    expect(budget.canSearch()).toBe(true);
    budget.recordSearch();
    expect(budget.canSearch()).toBe(true);
    budget.recordSearch();
    expect(budget.canSearch()).toBe(false);
  });

  it("clips each result list to five", () => {
    const budget = new WebToolBudget();
    const clipped = budget.clipResults(Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}`, rank: i + 1 })));
    expect(clipped).toHaveLength(5);
    expect(clipped.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("WebToolBudget/fetch pages", () => {
  it("counts only successful fetches toward the three-page budget", () => {
    const budget = new WebToolBudget();
    expect(budget.canFetch("https://a.com/1")).toBe(true);
    budget.recordFetch("https://a.com/1", true);
    budget.recordFetch("https://b.com/2", false); // failed, does not consume page budget
    expect(budget.canFetch("https://c.com/3")).toBe(true);
    budget.recordFetch("https://c.com/3", true);
    expect(budget.canFetch("https://d.com/4")).toBe(true);
    budget.recordFetch("https://d.com/4", true);
    expect(budget.canFetch("https://e.com/5")).toBe(false); // 3 successful reached
  });

  it("does not refetch a repeated canonical URL", () => {
    const budget = new WebToolBudget();
    budget.recordFetch("https://example.com/page", true);
    expect(budget.canFetch("https://example.com/page")).toBe(false);
    expect(budget.canFetch("https://example.com/page/")).toBe(false); // trailing slash canonicalized
  });
});

describe("WebToolBudget/tool rounds", () => {
  it("allows up to two tool rounds and denies the third", () => {
    const budget = new WebToolBudget();
    expect(budget.canStartToolRound()).toBe(true);
    budget.recordToolRound();
    expect(budget.canStartToolRound()).toBe(true);
    budget.recordToolRound();
    expect(budget.canStartToolRound()).toBe(false);
  });

  it("invalid tool calls cannot bypass the round cap", () => {
    const budget = new WebToolBudget();
    budget.recordToolRound();
    budget.recordToolRound();
    // Even an invalid/unknown call must not start a new round past the cap.
    expect(budget.canStartToolRound()).toBe(false);
  });
});

describe("WebToolBudget/result shape", () => {
  it("builds a structured search result envelope", () => {
    const budget = new WebToolBudget();
    const envelope = budget.searchResultEnvelope([
      { title: "t", url: "https://e.com/1", rank: 1 },
    ]);
    expect(envelope).toMatchObject({ ok: true, tool: "web_search" });
    if (envelope.ok) expect(envelope.results).toHaveLength(1);
  });

  it("builds a structured error envelope without a thrown stack", () => {
    const budget = new WebToolBudget();
    const envelope = budget.errorEnvelope("web_search", "invalid_arguments", "bad query");
    expect(envelope).toEqual({ ok: false, tool: "web_search", code: "invalid_arguments", error: "bad query" });
  });
});

describe("WebToolBudget/model web content", () => {
  it("bounds the total clipped content across three large fetches", () => {
    const budget = new WebToolBudget();
    const big = "x".repeat(MAX_MODEL_WEB_CONTENT_CHARS);
    const a = budget.clipFetchedContent(big);
    const b = budget.clipFetchedContent(big);
    const c = budget.clipFetchedContent(big);
    expect(a.length + b.length + c.length).toBeLessThanOrEqual(MAX_MODEL_WEB_CONTENT_CHARS);
    // Once the budget is exhausted, further clips are empty.
    expect(c).toBe("");
  });

  it("never exceeds the budget when the remaining budget is shorter than the marker", () => {
    const budget = new WebToolBudget();
    const markerLen = "\n\n…（网页内容已截断）".length;
    // Consume almost the whole budget, leaving less than the marker length.
    const first = budget.clipFetchedContent("y".repeat(MAX_MODEL_WEB_CONTENT_CHARS - (markerLen - 1)));
    expect(first.length).toBeLessThanOrEqual(MAX_MODEL_WEB_CONTENT_CHARS);
    // A large second page is clipped to the tiny remaining budget.
    const second = budget.clipFetchedContent("z".repeat(1000));
    expect(second.length).toBeLessThanOrEqual(markerLen - 1);
    expect(first.length + second.length).toBeLessThanOrEqual(MAX_MODEL_WEB_CONTENT_CHARS);
  });
});