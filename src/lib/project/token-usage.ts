import type { ChatMessage, ModelCallCategory, ModelCallUsage, ProviderTokenUsage, TurnTokenUsage } from "./types";

/**
 * Validate and normalize provider-reported usage. Returns null when values are
 * missing, non-integer, negative, when the totals do not add up, or when the
 * input is reported as 0 on a call that produced output — callers then fall
 * back to estimation rather than persisting bogus counts.
 */
export function normalizeProviderUsage(value: ProviderTokenUsage): ProviderTokenUsage | null {
  const values = [value.inputTokens, value.outputTokens, value.totalTokens];
  if (values.some((item) => !Number.isFinite(item) || item < 0 || !Number.isInteger(item))) {
    return null;
  }
  if (value.totalTokens !== value.inputTokens + value.outputTokens) {
    return null;
  }
  // A real model call always has a non-empty prompt, so inputTokens must be
  // greater than 0. Some OpenAI-compatible providers (notably certain reasoning
  // models and streaming endpoints) report `prompt_tokens: 0` while filling
  // completion_tokens — the totals still add up, so the checks above pass, but
  // the 0 is bogus. Reject it so the caller falls back to estimating the input
  // from the request text instead of showing "输入 0".
  if (value.inputTokens === 0) {
    return null;
  }
  return value;
}

/**
 * Deterministic token estimate for fallback when a provider reports no usage.
 * CJK characters count as one token each; other characters use the ~4 chars/token
 * heuristic. `Math.ceil` keeps the estimate stable for the same input.
 */
export function estimateTokenCount(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk + other / 4);
}

/**
 * Build a single model-call usage record, preferring the provider's exact
 * usage and falling back to an estimate from the request/response text.
 */
export function buildModelCallUsage(input: {
  id: string;
  category: ModelCallCategory;
  providerId: string;
  model: string;
  inputText: string;
  outputText: string;
  exact?: ProviderTokenUsage | null;
  status?: ModelCallUsage["status"];
}): ModelCallUsage {
  const exact = input.exact ? normalizeProviderUsage(input.exact) : null;
  const estimated = {
    inputTokens: estimateTokenCount(input.inputText),
    outputTokens: estimateTokenCount(input.outputText),
  };
  const counts = exact ?? { ...estimated, totalTokens: estimated.inputTokens + estimated.outputTokens };
  return {
    ...counts,
    id: input.id,
    category: input.category,
    providerId: input.providerId,
    model: input.model,
    source: exact ? "exact" : "estimated",
    status: input.status ?? "completed",
  };
}

/**
 * Aggregate a turn's calls into one persisted usage record. The source is
 * "mixed" when exact and estimated calls are combined, otherwise it mirrors
 * the single call source. Returns null for an empty call list.
 */
export function aggregateTokenUsage(turnId: string, calls: ModelCallUsage[]): TurnTokenUsage | null {
  if (calls.length === 0) return null;
  const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const outputTokens = calls.reduce((sum, call) => sum + call.outputTokens, 0);
  const sources = new Set(calls.map((call) => call.source));
  return {
    turnId,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: sources.size > 1 ? "mixed" : calls[0].source,
    callCount: calls.length,
    calls,
  };
}

/**
 * Sum token usage across a session's persisted assistant messages. Legacy
 * messages without `usage.calls` are ignored, so historical sessions still load.
 */
export function aggregateUsageFromMessages(messages: ChatMessage[]): TurnTokenUsage | null {
  const turns = messages.flatMap((message) => message.usage?.calls ?? []);
  return aggregateTokenUsage("session", turns);
}