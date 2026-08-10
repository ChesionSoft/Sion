import { FileDiff } from "../ui";
import { lineDiffWithNumbers } from "../../export-diff";
import type { DeliveryDecisionInspection, DeliveryOutcome } from "../../types";

export type DeliveryDecisionDetailsProps = {
  inspection?: DeliveryDecisionInspection;
  liveRaw?: string;
  outcome?: DeliveryOutcome;
};

function outcomeLabel(outcome?: DeliveryOutcome): string {
  if (!outcome) return "等待交付判断";
  switch (outcome.kind) {
    case "pending": return "等待交付判断";
    case "unchanged": return "未修改交付稿";
    case "patch_applied": return `已保存（revision ${outcome.revision}）`;
    case "awaiting_manual_draft_resolution": return `等待处理未保存草稿（revision ${outcome.expectedRevision}）`;
    case "conflict": return `版本冲突：预期 ${outcome.expectedRevision}，实际 ${outcome.actualRevision}`;
    case "failed": return `${outcome.stage} 阶段失败：${outcome.publicError}`;
    case "cancelled": return "已取消";
  }
}

function outcomeTone(outcome?: DeliveryOutcome): string {
  if (!outcome) return "is-pending";
  switch (outcome.kind) {
    case "patch_applied": return "is-success";
    case "unchanged": return "is-neutral";
    case "conflict":
    case "failed": return "is-error";
    case "awaiting_manual_draft_resolution": return "is-warning";
    default: return "is-neutral";
  }
}

export function DeliveryDecisionDetails({ inspection, liveRaw, outcome }: DeliveryDecisionDetailsProps) {
  const raw = liveRaw ?? inspection?.rawResponse ?? "";
  const base = inspection?.baseMarkdown ?? "";
  const proposed = inspection?.proposedMarkdown;
  const streaming = Boolean(liveRaw) && !inspection;
  return (
    <details className="delivery-decision-details">
      <summary>交付判断详情</summary>
      <section className="delivery-decision-section">
        <h4>模型返回的交付 JSON</h4>
        <pre className="delivery-decision-raw" aria-live={streaming ? "polite" : undefined}>{raw || "暂无"}</pre>
      </section>
      {proposed ? (
        <section className="delivery-decision-section">
          <h4>交付稿差异</h4>
          <FileDiff
            className="delivery-decision-diff"
            label={<span className="delivery-decision-diff-label">当前文稿 → 建议交付稿</span>}
            rows={lineDiffWithNumbers(base, proposed)}
          />
        </section>
      ) : null}
      <section className="delivery-decision-section">
        <h4>保存结果</h4>
        <p className={`delivery-decision-outcome ${outcomeTone(outcome)}`}>{outcomeLabel(outcome)}</p>
      </section>
    </details>
  );
}
