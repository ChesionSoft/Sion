import { Button, Dialog } from "../ui";

export function AgentRuleDialog({ open, nodeTitle, value, saving, onChange, onClose, onSave }: { open: boolean; nodeTitle: string; value: string; saving: boolean; onChange: (value: string) => void; onClose: () => void; onSave: () => void }) {
  return (
    <Dialog open={open} title="节点自定义规则" description={`${nodeTitle} · 规则会追加在内置节点规则之后，留空保存可恢复默认。`} size="large" closeLabel="关闭节点规则" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={saving} onClick={onSave}>{value.trim() ? "保存规则" : "清除规则"}</Button></>}>
      <textarea className="workspace-rule-editor" aria-label={`${nodeTitle} 自定义规则`} value={value} onChange={(event) => onChange(event.target.value)} placeholder="例如：只使用已经确认的事实；不推断预算或日期。" />
    </Dialog>
  );
}
