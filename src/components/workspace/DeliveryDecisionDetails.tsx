import type { DeliveryDecisionInspection, DeliveryOutcome } from "../../types";

export type DeliveryDecisionDetailsProps = {
  inspection?: DeliveryDecisionInspection;
  liveRaw?: string;
  outcome?: DeliveryOutcome;
};

type DiffLine = { kind: "same" | "add" | "remove"; text: string };

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

function diffLines(base: string, proposed: string): DiffLine[] {
  const a = base.split("\n");
  const b = proposed.split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ kind: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ kind: "remove", text: a[i] });
      i += 1;
    } else {
      result.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < m) {
    result.push({ kind: "remove", text: a[i] });
    i += 1;
  }
  while (j < n) {
    result.push({ kind: "add", text: b[j] });
    j += 1;
  }
  return result;
}

function diffPrefix(kind: DiffLine["kind"]): string {
  if (kind === "add") return "+ ";
  if (kind === "remove") return "- ";
  return "  ";
}

export function DeliveryDecisionDetails({ inspection, liveRaw, outcome }: DeliveryDecisionDetailsProps) {
  const raw = liveRaw ?? inspection?.rawResponse ?? "";
  const base = inspection?.baseMarkdown ?? "";
  const proposed = inspection?.proposedMarkdown;
  const streaming = Boolean(liveRaw) && !inspection;
  const diff = proposed ? diffLines(base, proposed) : [];
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
          <pre className="delivery-decision-diff">
            {diff.map((line, index) => (
              <span key={index} className={`delivery-decision-diff-line is-${line.kind}`}>
                {diffPrefix(line.kind)}
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </section>
      ) : null}
      <section className="delivery-decision-section">
        <h4>保存结果</h4>
        <p className={`delivery-decision-outcome ${outcomeTone(outcome)}`}>{outcomeLabel(outcome)}</p>
      </section>
    </details>
  );
}
