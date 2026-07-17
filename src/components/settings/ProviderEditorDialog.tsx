import { useEffect, useState } from "react";
import type { Provider, ProviderDraft } from "../../types";
import { Button, Dialog, Field, SelectField } from "../ui";

const DEFAULT_URL = "https://api.openai.com/v1";
const now = () => new Date().toISOString();

export function ProviderEditorDialog({
  open,
  provider,
  providerCount,
  onClose,
  onSave,
}: {
  open: boolean;
  provider: Provider | null;
  providerCount: number;
  onClose: () => void;
  onSave: (draft: ProviderDraft) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState(DEFAULT_URL);
  const [apiUrlMode, setApiUrlMode] = useState<Provider["apiUrlMode"]>("base");
  const [protocol, setProtocol] = useState<Provider["protocol"]>("chat_completions");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? "");
    setUrl(provider?.apiBaseUrl ?? DEFAULT_URL);
    setApiUrlMode(provider?.apiUrlMode ?? "base");
    setProtocol(provider?.protocol ?? "chat_completions");
    setModel(provider?.models.find((item) => item.isDefault)?.name ?? provider?.models[0]?.name ?? "");
    setKey("");
    setSubmitted(false);
    setSaving(false);
  }, [open, provider]);

  const errors = {
    name: submitted && !name.trim() ? "请输入提供商名称" : undefined,
    url: submitted && !url.trim() ? "请输入 API URL" : undefined,
    model: submitted && !model.trim() ? "请输入模型名称" : undefined,
    key: submitted && !provider && !key.trim() ? "新增提供商需要 API Key" : undefined,
  };

  async function submit() {
    setSubmitted(true);
    if (!name.trim() || !url.trim() || !model.trim() || (!provider && !key.trim()) || saving) return;
    setSaving(true);
    const saved = await onSave({
      id: provider?.id ?? crypto.randomUUID(),
      name: name.trim(),
      apiBaseUrl: url.trim(),
      apiUrlMode,
      protocol,
      model: model.trim(),
      isDefault: provider?.isDefault ?? providerCount === 0,
      ...(key.trim() ? { apiKey: key.trim() } : {}),
      now: now(),
    });
    setSaving(false);
    if (saved) onClose();
  }

  return (
    <Dialog
      open={open}
      title={provider ? `编辑 ${provider.name}` : "添加模型连接"}
      description={provider ? "API Key 留空会保留当前密钥。" : "密钥只保存在本机，不会回显。"}
      size="medium"
      closeLabel="关闭模型编辑"
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>{provider ? "保存修改" : "添加连接"}</Button>
        </>
      )}
    >
      <form className="provider-editor-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="提供商名称" value={name} onChange={(event) => setName(event.target.value)} error={errors.name} placeholder="OpenAI" autoFocus />
        <Field label={apiUrlMode === "base" ? "API Base URL" : "完整 Endpoint URL"} value={url} onChange={(event) => setUrl(event.target.value)} error={errors.url} />
        <div className="provider-editor-grid">
          <SelectField label="URL 模式" value={apiUrlMode} onChange={(event) => setApiUrlMode(event.target.value as Provider["apiUrlMode"])}>
            <option value="base">Base URL</option>
            <option value="full">完整 Endpoint</option>
          </SelectField>
          <SelectField label="协议" value={protocol} onChange={(event) => setProtocol(event.target.value as Provider["protocol"])}>
            <option value="chat_completions">Chat Completions</option>
            <option value="openai_responses">OpenAI Responses</option>
          </SelectField>
        </div>
        <p className="provider-editor-hint">{apiUrlMode === "base" ? "Sion 会按所选协议拼接请求路径。" : "Sion 会原样使用完整 Endpoint，不再拼接路径。"}</p>
        <Field label="默认模型" value={model} onChange={(event) => setModel(event.target.value)} error={errors.model} placeholder="gpt-5" />
        <Field label="API Key" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} error={errors.key} placeholder={provider ? "留空以保留当前密钥" : "仅保存到 ~/.sion/providers.json"} />
      </form>
    </Dialog>
  );
}
