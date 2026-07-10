import { describe, expect, it } from "vitest";
import {
  aggregateTokenUsage,
  aggregateUsageFromMessages,
  buildModelCallUsage,
  estimateTokenCount,
  normalizeProviderUsage,
} from "./token-usage";

describe("token usage", () => {
  it("normalizes valid provider usage and rejects negative values", () => {
    expect(normalizeProviderUsage({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }))
      .toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(normalizeProviderUsage({ inputTokens: -1, outputTokens: 8, totalTokens: 7 }))
      .toBeNull();
  });

  it("rejects provider usage reporting 0 input on a call that produced output", () => {
    // Some OpenAI-compatible providers report prompt_tokens: 0 while filling
    // completion_tokens — totals add up, but the 0 is bogus (a real call always
    // has a prompt). Reject it so the caller estimates the input from the
    // request text instead of persisting "输入 0".
    expect(normalizeProviderUsage({ inputTokens: 0, outputTokens: 8, totalTokens: 8 }))
      .toBeNull();
    // buildModelCallUsage then falls back to estimation from the input text.
    const usage = buildModelCallUsage({
      id: "c1",
      category: "answer",
      model: "m",
      providerId: "p",
      exact: { inputTokens: 0, outputTokens: 8, totalTokens: 8 },
      inputText: "你好abcd你好abcd",
      outputText: "结果",
    });
    expect(usage.source).toBe("estimated");
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  it("estimates mixed text deterministically", () => {
    expect(estimateTokenCount("你好abcd")).toBe(3);
  });

  it("marks a turn mixed when exact and estimated calls are combined", () => {
    const calls = [
      buildModelCallUsage({ id: "c1", category: "answer", model: "m", providerId: "p", exact: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, inputText: "", outputText: "" }),
      buildModelCallUsage({ id: "c2", category: "document_update", model: "m", providerId: "p", inputText: "你好", outputText: "结果" }),
    ];
    expect(aggregateTokenUsage("turn-1", calls)).toMatchObject({ source: "mixed", callCount: 2 });
  });

  it("ignores legacy messages without usage", () => {
    expect(aggregateUsageFromMessages([{ id: "old", role: "assistant", content: "old", createdAt: "2026-06-22T00:00:00Z" }])).toBeNull();
  });
});