"use client";

import { Badge } from "@/components/ui/badge";
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
 * Per-message and session token usage, shown as an inline row of Badges. The
 * total uses the secondary variant; input/output and the source label use
 * outline. A muted span appends the call count when more than one call fed the
 * turn. Null usage renders nothing unless `showEmpty` is set.
 */
export function TokenUsageDetails({ usage, showEmpty = false }: TokenUsageDetailsProps) {
  if (!usage) {
    return showEmpty ? <span className="token-usage-empty">暂无统计</span> : null;
  }

  return (
    <span className="token-usage-inline flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Badge variant="secondary">共 {usage.totalTokens}</Badge>
      <Badge variant="outline">输入 {usage.inputTokens}</Badge>
      <Badge variant="outline">输出 {usage.outputTokens}</Badge>
      <Badge variant="outline">{SOURCE_LABELS[usage.source]}</Badge>
      {usage.callCount > 1 ? <span>· {usage.callCount} 次调用</span> : null}
    </span>
  );
}