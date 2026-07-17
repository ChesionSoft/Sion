import { Button, Dialog } from "../ui";
import type { WorkflowNode } from "../../types";

export function RevisionConflictDialog({ latest, onKeepDraft, onLoadLatest }: {
  latest: WorkflowNode | null;
  onKeepDraft: () => void;
  onLoadLatest: () => void;
}) {
  return (
    <Dialog
      open={latest !== null}
      title="磁盘版本已发生变化"
      description={latest ? `磁盘中现为 revision ${latest.revision} · ${new Date(latest.updatedAt).toLocaleString("zh-CN")}` : undefined}
      size="confirm"
      closeLabel="继续编辑我的草稿"
      onClose={onKeepDraft}
      footer={(
        <>
          <Button variant="ghost" onClick={onKeepDraft}>继续编辑我的草稿</Button>
          <Button variant="primary" onClick={onLoadLatest}>载入磁盘版本</Button>
        </>
      )}
    >
      <p className="confirm-copy">为避免覆盖其他保存，Sion 保留了你的草稿。载入磁盘版本会替换当前编辑内容。</p>
    </Dialog>
  );
}
