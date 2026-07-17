import type { DeliveryView, WorkflowNode } from "../../types";
import { statusLabel } from "../../types";
import { Button, StatusDot } from "../ui";
import { MarkdownPreview } from "./MarkdownPreview";

type DeliveryWorkspaceProps = {
  node: WorkflowNode | null;
  nodeTitle: string;
  markdown: string;
  view: DeliveryView;
  dirty: boolean;
  saving: boolean;
  exporting: boolean;
  onView: (view: DeliveryView) => void;
  onMarkdown: (value: string) => void;
  onSave: () => void;
  onExport: () => void;
};

export function DeliveryWorkspace({
  node,
  nodeTitle,
  markdown,
  view,
  dirty,
  saving,
  exporting,
  onView,
  onMarkdown,
  onSave,
  onExport,
}: DeliveryWorkspaceProps) {
  const statusKind = node?.status === "confirmed" ? "success" : node?.status === "needs_confirmation" ? "warning" : "neutral";
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
            disabled={!node}
            spellCheck={false}
            value={markdown}
            onChange={(event) => onMarkdown(event.target.value)}
          />
        )}
      </div>
      <footer className="delivery-workspace-footer">
        <span>Markdown · {markdown.length.toLocaleString()} 字符{dirty ? " · 有未保存修改" : " · 已保存"}</span>
        <div>
          <Button variant={dirty ? "primary" : "secondary"} disabled={!dirty || !node} loading={saving} onClick={onSave}>保存</Button>
          <Button variant="secondary" disabled={!node} loading={exporting} onClick={onExport}>导出 DOCX</Button>
        </div>
      </footer>
    </section>
  );
}
