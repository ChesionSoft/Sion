import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ConversationContextSnapshot, TokenUsageSource } from "../../types";
import { contextIndicatorKind } from "../../conversation-controls";

const usageSourceLabel: Record<TokenUsageSource, string> = {
  exact: "精确",
  estimated: "估算",
  mixed: "含估算",
};

function formatTokens(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function ContextRow(props: { label: string; value: number }) {
  return (
    <div className="context-usage-row">
      <dt>{props.label}</dt>
      <dd>{formatTokens(props.value)}</dd>
    </div>
  );
}

export function ContextUsageIndicator(props: {
  snapshot: ConversationContextSnapshot | null;
  loading: boolean;
  error: string | null;
}) {
  const { snapshot, loading, error } = props;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  const kind = snapshot ? contextIndicatorKind(snapshot) : "ready";
  const ratio = snapshot?.ratio ?? 0;
  const stateLabel = error
    ? "统计暂不可用"
    : kind === "blocked"
      ? "超出上下文"
      : kind === "warning"
        ? "接近上限"
        : snapshot
          ? "上下文可用"
          : "尚无上下文统计";
  const activeDetail = snapshot
    ? `${formatTokens(snapshot.estimatedInputTokens)} / ${formatTokens(snapshot.contextWindowTokens)} tokens（${Math.round(ratio * 100)}%）`
    : "发送消息后将统计当前会话";

  return (
    <div className="context-usage-indicator" ref={containerRef}>
      <button
        type="button"
        className={`context-usage-button is-${kind} ${loading ? "is-loading" : ""}`}
        style={{ "--context-ratio": `${Math.min(Math.max(ratio, 0), 1) * 360}deg` } as CSSProperties}
        aria-label={`上下文：${stateLabel}，${activeDetail}${loading ? "，正在刷新" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      <div className={`context-usage-detail ${open ? "is-pinned" : ""}`} role="status" aria-live="polite">
        <header>
          <strong>{stateLabel}</strong>
          {loading ? <span>正在刷新</span> : null}
        </header>
        <p>{activeDetail}</p>
        {snapshot ? (
          <>
            <dl className="context-usage-breakdown">
              <ContextRow label="协议提示" value={snapshot.breakdown.protocolTokens} />
              <ContextRow label="Agent 规则" value={snapshot.breakdown.rulesTokens} />
              <ContextRow label="节点文稿" value={snapshot.breakdown.nodeMarkdownTokens} />
              <ContextRow label="会话历史" value={snapshot.breakdown.conversationTokens} />
              <ContextRow label="本轮资料" value={snapshot.breakdown.attachmentTokens} />
            </dl>
            <dl className="context-usage-cumulative">
              <ContextRow label="累计输入" value={snapshot.cumulativeUsage.inputTokens} />
              <ContextRow label="累计输出" value={snapshot.cumulativeUsage.outputTokens} />
              <div className="context-usage-row">
                <dt>模型调用</dt>
                <dd>{snapshot.cumulativeUsage.callCount} 次 · {usageSourceLabel[snapshot.cumulativeUsage.source]}</dd>
              </div>
            </dl>
          </>
        ) : null}
      </div>
    </div>
  );
}
