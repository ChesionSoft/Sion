"use client";

import type { TurnTokenUsage } from "@/lib/project/types";

export type TokenUsageDetailsProps = {
  usage: TurnTokenUsage | null | undefined;
  /** When true, null usage renders "暂无统计" (for historical assistant messages). */
  showEmpty?: boolean;
};

const SOURCE_LABELS: Record<TurnTokenUsage["source"], string> = {
  exact: "精确",
  estimated: "估算",
  mixed: "含估算",
};

/**
 * Per-message and session token usage disclosure. A closed <details> keeps
 * the chat dense; opening it reveals input/output totals, the call count, and
 * whether the counts are exact, estimated, or mixed.
 */
export function TokenUsageDetails({ usage, showEmpty = false }: TokenUsageDetailsProps) {
  if (!usage) {
    return showEmpty ? <span className="token-usage-empty">暂无统计</span> : null;
  }

  const sourceLabel = SOURCE_LABELS[usage.source];

  return (
    <details className="token-usage-details">
      <summary className="token-usage-trigger">共 {usage.totalTokens} token</summary>
      <div className="token-usage-body">
        <div>输入 {usage.inputTokens} token · 输出 {usage.outputTokens} token</div>
        <div>
          <span>{sourceLabel}</span>
          {usage.callCount > 1 ? <span> · {usage.callCount} 次调用</span> : null}
        </div>
      </div>
    </details>
  );
}