import { useEffect, useState } from "react";
import type { Provider, ProviderDraft, ProviderModel } from "../../types";
import { Button, Dialog, Field, SelectField } from "../ui";

const DEFAULT_URL = "https://api.openai.com/v1";
const now = () => new Date().toISOString();

type ModelRow = { id: string; name: string; contextWindow: string; isDefault: boolean; toolCalling: boolean };

function emptyRow(isDefault: boolean): ModelRow {
  return { id: crypto.randomUUID(), name: "", contextWindow: "", isDefault, toolCalling: false };
}

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
  const [models, setModels] = useState<ModelRow[]>([emptyRow(true)]);
  const [key, setKey] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? "");
    setUrl(provider?.apiBaseUrl ?? DEFAULT_URL);
    setApiUrlMode(provider?.apiUrlMode ?? "base");
    setProtocol(provider?.protocol ?? "chat_completions");
    if (provider && provider.models.length > 0) {
      setModels(provider.models.map((model) => ({
        id: crypto.randomUUID(),
        name: model.name,
        contextWindow: model.contextWindowTokens != null ? String(model.contextWindowTokens) : "",
        isDefault: model.isDefault,
        toolCalling: model.toolCalling,
      })));
    } else {
      setModels([emptyRow(true)]);
    }
    setKey("");
    setSubmitted(false);
    setSaving(false);
  }, [open, provider]);

  function updateRow(id: string, patch: Partial<ModelRow>) {
    setModels((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }
  function setDefaultRow(id: string) {
    setModels((current) => current.map((row) => ({ ...row, isDefault: row.id === id })));
  }
  function addRow() {
    setModels((current) => [...current, emptyRow(false)]);
  }
  function removeRow(id: string) {
    setModels((current) => {
      if (current.length <= 1) return current;
      const removed = current.find((row) => row.id === id);
      const remaining = current.filter((row) => row.id !== id);
      if (removed?.isDefault && remaining.length > 0) {
        remaining[0] = { ...remaining[0], isDefault: true };
      }
      return remaining;
    });
  }

  const trimmedNames = models.map((row) => row.name.trim());
  const duplicateName = trimmedNames.some((itemName, index) => itemName && trimmedNames.indexOf(itemName) !== index);
  const defaultCount = models.filter((row) => row.isDefault).length;
  const modelsError = submitted
    ? duplicateName
      ? "模型名称不能重复"
      : defaultCount !== 1
        ? "需要恰好一个默认模型"
        : models.some((row) => !row.name.trim())
          ? "请填写所有模型名称"
          : models.some((row) => !(Number.isSafeInteger(Number(row.contextWindow)) && Number(row.contextWindow) > 0))
            ? "每个模型需要正整数的上下文窗口"
            : undefined
    : undefined;
  const errors = {
    name: submitted && !name.trim() ? "请输入提供商名称" : undefined,
    url: submitted && !url.trim() ? "请输入 API URL" : undefined,
    key: submitted && !provider && !key.trim() ? "新增提供商需要 API Key" : undefined,
  };

  async function submit() {
    setSubmitted(true);
    if (!name.trim() || !url.trim() || modelsError || (!provider && !key.trim()) || saving) return;
    setSaving(true);
    const builtModels: ProviderModel[] = models.map((row) => ({
      name: row.name.trim(),
      isDefault: row.isDefault,
      toolCalling: row.toolCalling,
      contextWindowTokens: Number(row.contextWindow),
    }));
    const saved = await onSave({
      id: provider?.id ?? crypto.randomUUID(),
      name: name.trim(),
      apiBaseUrl: url.trim(),
      apiUrlMode,
      protocol,
      models: builtModels,
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
        <div className="provider-model-list">
          {models.map((row) => (
            <div key={row.id} className="provider-model-row">
              <div className="provider-model-fields">
                <Field label="模型名称" value={row.name} onChange={(event) => updateRow(row.id, { name: event.target.value })} placeholder="gpt-5" />
                <Field label="上下文窗口（tokens）" value={row.contextWindow} onChange={(event) => updateRow(row.id, { contextWindow: event.target.value })} placeholder="128000" />
                <label className="provider-model-default">
                  <input type="radio" name="default-model" checked={row.isDefault} onChange={() => setDefaultRow(row.id)} />
                  默认
                </label>
              </div>
              <Button variant="ghost" type="button" disabled={models.length <= 1} onClick={() => removeRow(row.id)}>删除</Button>
            </div>
          ))}
        </div>
        {modelsError ? <p className="provider-model-error">{modelsError}</p> : null}
        <Button variant="secondary" type="button" onClick={addRow}>添加模型</Button>
        <Field label="API Key" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} error={errors.key} placeholder={provider ? "留空以保留当前密钥" : "仅保存到 ~/.sion/providers.json"} />
      </form>
    </Dialog>
  );
}
