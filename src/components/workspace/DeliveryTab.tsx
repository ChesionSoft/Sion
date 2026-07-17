import type { WorkflowNode } from "../../types";
import { statusLabel } from "../../types";
import { Button, StatusDot } from "../ui";

export function DeliveryTab({
  node,
  nodeTitle,
  markdown,
  dirty,
  saving,
  exporting,
  hasCustomRule,
  onMarkdown,
  onSave,
  onExport,
  onOpenRule,
}: {
  node: WorkflowNode | null;
  nodeTitle: string;
  markdown: string;
  dirty: boolean;
  saving: boolean;
  exporting: boolean;
  hasCustomRule: boolean;
  onMarkdown: (value: string) => void;
  onSave: () => void;
  onExport: () => void;
  onOpenRule: () => void;
}) {
  return (
    <section className="delivery-tab">
      <header className="delivery-tab-header">
        <div><span>交付稿</span><h2>{nodeTitle}</h2><p><StatusDot kind={node?.status === "confirmed" ? "success" : node?.status === "needs_confirmation" ? "warning" : "neutral"} /> {node ? statusLabel[node.status] : "正在读取"} · revision {node?.revision ?? "-"}</p></div>
        <Button variant="ghost" onClick={onOpenRule}>{hasCustomRule ? "节点规则 · 已启用" : "节点规则"}</Button>
      </header>
      <textarea aria-label={`${nodeTitle} Markdown 编辑器`} disabled={!node} spellCheck={false} value={markdown} onChange={(event) => onMarkdown(event.target.value)} />
      <footer className="delivery-tab-footer">
        <span>Markdown · {markdown.length.toLocaleString()} 字符{dirty ? " · 有未保存修改" : " · 已保存"}</span>
        <div>
          <Button variant={dirty ? "primary" : "secondary"} disabled={!dirty || !node} loading={saving} onClick={onSave}>保存</Button>
          <Button variant="secondary" disabled={!node} loading={exporting} onClick={onExport}>导出 DOCX</Button>
        </div>
      </footer>
    </section>
  );
}
