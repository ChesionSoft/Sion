import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ContextEstimate } from "../../types";
import { contextIndicatorKind } from "../../conversation-controls";

export function ContextUsageIndicator(props: {
  estimate: ContextEstimate | null;
  loading: boolean;
  error: string | null;
}) {
  const { estimate, loading, error } = props;
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

  const kind = estimate ? contextIndicatorKind(estimate) : "ready";
  const ratio = estimate?.ratio ?? 0;
  const headline = loading ? "估算中" : error ? "估算失败" : kind === "blocked" ? "超出上下文" : kind === "warning" ? "接近上限" : "可用";
  const detail = estimate
    ? `${estimate.estimatedInputTokens} / ${estimate.contextWindowTokens} tokens（${Math.round(ratio * 100)}%）`
    : error ?? "暂无估算";

  return (
    <div className="context-usage-indicator" ref={containerRef}>
      <button
        type="button"
        className={`context-usage-button is-${kind}`}
        style={{ "--context-ratio": `${Math.min(Math.max(ratio, 0), 1) * 360}deg` } as CSSProperties}
        aria-label={`上下文：${headline}${estimate ? `，${detail}` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      {open ? (
        <div className="context-usage-detail" role="status" aria-live="polite">
          {detail}
        </div>
      ) : null}
    </div>
  );
}
