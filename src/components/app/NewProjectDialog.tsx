import { useEffect, useState } from "react";
import { Button, Dialog, Field } from "../ui";

export function NewProjectDialog({
  open,
  projectsDirectory,
  creating,
  onClose,
  onCreate,
  onOpenSettings,
}: {
  open: boolean;
  projectsDirectory: string | null;
  creating: boolean;
  onClose: () => void;
  onCreate: (name: string, customer: string, author: string) => Promise<boolean>;
  onOpenSettings: () => void;
}) {
  const [name, setName] = useState("");
  const [customer, setCustomer] = useState("");
  const [author, setAuthor] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const nameError = submitted && !name.trim() ? "请输入项目名称" : undefined;

  useEffect(() => {
    if (!open) return;
    setName("");
    setCustomer("");
    setAuthor("");
    setSubmitted(false);
  }, [open]);

  function submit() {
    setSubmitted(true);
    if (!name.trim() || !projectsDirectory || creating) return;
    void onCreate(name.trim(), customer.trim(), author.trim()).then((created) => {
      if (created) onClose();
    });
  }

  function changeDirectory() {
    onClose();
    onOpenSettings();
  }

  return (
    <Dialog
      open={open}
      title="新建项目"
      description="建立一个包含 12 个设计节点的本地项目。"
      size="short"
      closeLabel="关闭新建项目"
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={creating} disabled={!projectsDirectory} onClick={submit}>创建项目</Button>
        </>
      )}
    >
      <form className="new-project-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Field label="项目名称" value={name} onChange={(event) => setName(event.target.value)} error={nameError} placeholder="例如：客户服务平台改版" autoFocus />
        <Field label="客户（可选）" value={customer} onChange={(event) => setCustomer(event.target.value)} placeholder="客户或业务方" />
        <Field label="作者（可选）" value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="文档负责人" />
        <div className="project-directory-summary">
          <div><span>项目目录</span><strong>{projectsDirectory ?? "尚未设置"}</strong></div>
          <Button variant="ghost" onClick={changeDirectory} type="button">更改</Button>
        </div>
        {!projectsDirectory ? <p className="project-directory-error">创建前需要先设置项目目录。</p> : null}
      </form>
    </Dialog>
  );
}
