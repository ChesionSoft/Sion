import type { AssistantDeliveryPreview } from "../../types";
import { Button, EmptyState } from "../ui";

export function DeliveryPreviewTab({ preview, onCancel, onApply }: { preview: AssistantDeliveryPreview | null; onCancel: () => void; onApply: (messageId: string) => void }) {
  if (!preview) return <EmptyState title="修改预览不可用" description="重新从 Assistant 回复中生成预览，或关闭此分页。" />;
  return (
    <section className="delivery-preview-tab">
      <header><div><h2>Assistant 修改预览</h2><p>基于 revision {preview.currentRevision}</p></div><div><span className="is-add">+{preview.additions} 新增</span><span className="is-delete">-{preview.deletions} 删除</span><span>{preview.unchanged} 保留</span></div></header>
      <pre>{preview.markdown}</pre>
      <footer><Button variant="ghost" onClick={onCancel}>取消</Button><Button variant="primary" onClick={() => onApply(preview.assistantMessageId)}>确认应用修改</Button></footer>
    </section>
  );
}
