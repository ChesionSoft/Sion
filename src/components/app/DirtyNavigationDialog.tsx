import { Button, Dialog } from "../ui";

export function DirtyNavigationDialog({ open, saving, description, onSave, onDiscard, onCancel }: {
  open: boolean;
  saving: boolean;
  description: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      title="要保存未完成的修改吗？"
      description={description}
      size="confirm"
      closeLabel="取消离开"
      onClose={onCancel}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={onCancel}>取消</Button>
          <Button variant="secondary" disabled={saving} onClick={onDiscard}>放弃修改</Button>
          <Button variant="primary" loading={saving} loadingLabel="正在保存…" onClick={onSave}>保存并继续</Button>
        </>
      )}
    >
      <p className="confirm-copy">离开后无法恢复未保存的内容。你也可以取消，继续编辑当前草稿。</p>
    </Dialog>
  );
}
