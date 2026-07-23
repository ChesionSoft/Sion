import type { DeliveryGeneration, DeliveryView, WorkflowNode } from "../../types";
import { statusLabel } from "../../types";
import { Button, StatusDot } from "../ui";
import { MarkdownPreview } from "./MarkdownPreview";
import { DeliveryGenerationStatus } from "./DeliveryGenerationStatus";

type DeliveryWorkspaceProps = {
  node: WorkflowNode | null;
  nodeTitle: string;
  markdown: string;
  view: DeliveryView;
  dirty: boolean;
  saving: boolean;
  generation: DeliveryGeneration | null;
  candidateLength: number;
  canRegenerate: boolean;
  regenerating: boolean;
  locked: boolean;
  onView: (view: DeliveryView) => void;
  onMarkdown: (value: string) => void;
  onSave: () => void;
  onRegenerate: () => void;
  onCancelRegeneration: () => void;
};

export function DeliveryWorkspace({
  node,
  nodeTitle,
  markdown,
  view,
  dirty,
  saving,
  generation,
  candidateLength,
  canRegenerate,
  regenerating,
  locked,
  onView,
  onMarkdown,
  onSave,
  onRegenerate,
  onCancelRegeneration,
}: DeliveryWorkspaceProps) {
  const statusKind = node?.status === "confirmed" ? "success" : node?.status === "needs_confirmation" ? "warning" : "neutral";
  const canSave = node !== null && (dirty || node.status !== "confirmed");
  const saveLabel = node?.status === "confirmed" ? "保存" : dirty ? "保存并确认" : "确认交付稿";
  return (
    <section className="delivery-workspace">
      <header className="delivery-workspace-header">
        <div className="delivery-workspace-meta">
          <h2>{nodeTitle}</h2>
          <p><StatusDot kind={statusKind} /> {node ? statusLabel[node.status] : "正在读取"} · revision {node?.revision ?? "-"}</p>
        </div>
        <div className="delivery-view-switch" role="tablist" aria-label="交付稿视图">
          <button role="tab" aria-selected={view === "preview"} className={view === "preview" ? "is-active" : ""} onClick={() => onView("preview")} type="button">预览</button>
          <button role="tab" aria-selected={view === "source"} className={view === "source" ? "is-active" : ""} onClick={() => onView("source")} type="button">源文件</button>
        </div>
      </header>
      <div className="delivery-workspace-body">
        {view === "preview" ? (
          <MarkdownPreview markdown={markdown} />
        ) : (
          <textarea
            aria-label={nodeTitle + " Markdown 源文件编辑器"}
            disabled={!node || locked}
            spellCheck={false}
            value={markdown}
            onChange={(event) => onMarkdown(event.target.value)}
          />
        )}
      </div>
      <DeliveryGenerationStatus generation={generation} candidateLength={candidateLength} onCancel={onCancelRegeneration} />
      <footer className="delivery-workspace-footer">
        <span>Markdown · {markdown.length.toLocaleString()} 字符{dirty ? " · 有未保存修改" : " · 已保存"}</span>
        <div>
          <Button variant={dirty || node?.status !== "confirmed" ? "primary" : "secondary"} disabled={!canSave || !node || locked} loading={saving} onClick={onSave}>{saveLabel}</Button>
          <Button variant="secondary" disabled={!canRegenerate || regenerating} loading={regenerating} onClick={onRegenerate}>重新生成交付稿</Button>
        </div>
      </footer>
    </section>
  );
}
