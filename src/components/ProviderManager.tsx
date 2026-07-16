import { useState } from "react";
import type { Provider, ProviderDraft, ProviderManagerProps } from "../types";

const now = () => new Date().toISOString();
const DEFAULT_URL = "https://api.openai.com/v1";

// Provider add/edit/default/delete surface. Editing an existing connection
// preserves its id and `isDefault`; the API Key field is only sent when a
// replacement is entered, so a blank key leaves the stored secret untouched.
export function ProviderManager({ providers, onSave, onSetDefault, onDelete, onClose }: ProviderManagerProps) {
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState(DEFAULT_URL);
  const [apiUrlMode, setApiUrlMode] = useState<Provider["apiUrlMode"]>("base");
  const [protocol, setProtocol] = useState<Provider["protocol"]>("chat_completions");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");

  const editing = editId ? providers.find((provider) => provider.id === editId) ?? null : null;

  function resetForm() {
    setEditId(null);
    setName("");
    setUrl(DEFAULT_URL);
    setApiUrlMode("base");
    setProtocol("chat_completions");
    setModel("");
    setKey("");
  }

  function startEdit(provider: Provider) {
    setEditId(provider.id);
    setName(provider.name);
    setUrl(provider.apiBaseUrl);
    setApiUrlMode(provider.apiUrlMode);
    setProtocol(provider.protocol);
    setModel(provider.models.find((item) => item.isDefault)?.name ?? provider.models[0]?.name ?? "");
    setKey("");
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedModel = model.trim();
    if (!trimmedName || !trimmedModel) return;
    if (editing) {
      const draft: ProviderDraft = {
        id: editing.id,
        name: trimmedName,
        apiBaseUrl: url.trim(),
        apiUrlMode,
        protocol,
        model: trimmedModel,
        isDefault: editing.isDefault,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        now: now(),
      };
      onSave(draft);
    } else {
      if (!key.trim()) return;
      const draft: ProviderDraft = {
        id: crypto.randomUUID(),
        name: trimmedName,
        apiBaseUrl: url.trim(),
        apiUrlMode,
        protocol,
        model: trimmedModel,
        isDefault: providers.length === 0,
        apiKey: key.trim(),
        now: now(),
      };
      onSave(draft);
    }
    resetForm();
  }

  function remove(provider: Provider) {
    if (!window.confirm(`删除"${provider.name}"吗？这会同时删除它保存在系统凭据库中的 API Key。`)) return;
    onDelete(provider.id);
    if (editId === provider.id) resetForm();
  }

  return (
    <section className="provider-manager" role="dialog" aria-modal="true" aria-label="模型连接管理">
      <div className="provider-manager-card">
        <div className="provider-manager-head">
          <div><p className="panel-kicker">模型连接</p><h2>{editing ? `编辑 ${editing.name}` : "新增模型连接"}</h2></div>
          <button onClick={onClose} type="button" aria-label="关闭模型连接管理">×</button>
        </div>
        <form className="provider-form" onSubmit={submit}>
          <label>提供商名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="OpenAI" /></label>
          <label>API Base URL<input value={url} onChange={(event) => setUrl(event.target.value)} /></label>
          <div className="provider-row">
            <label>URL 模式<select value={apiUrlMode} onChange={(event) => setApiUrlMode(event.target.value as Provider["apiUrlMode"])}><option value="base">base（自动拼接路径）</option><option value="full">full（完整 endpoint）</option></select></label>
            <label>协议<select value={protocol} onChange={(event) => setProtocol(event.target.value as Provider["protocol"])}><option value="chat_completions">Chat Completions</option><option value="openai_responses">Responses</option></select></label>
          </div>
          <small className="provider-help">{apiUrlMode === "base" ? "base 模式：填写到版本号的根地址（如 https://api.openai.com/v1），Sion 按协议拼接 /chat/completions 或 /responses。" : "full 模式：填写完整 endpoint 地址，Sion 原样使用，不再拼接路径。"}</small>
          <label>默认模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-5" /></label>
          <label>API Key<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={editing ? "保留已保存密钥（留空即不更换）" : "仅写入系统凭据库"} /></label>
          <div className="provider-form-actions">
            <button className="provider-save" type="submit">{editing ? "保存修改" : "保存安全配置"}<b>↗</b></button>
            {editing ? <button type="button" onClick={resetForm}>取消编辑</button> : null}
          </div>
        </form>
        <div className="provider-list">
          {providers.length === 0
            ? <p>尚未配置模型。当前工作台仍可离线编辑和保存。</p>
            : providers.map((provider) => (
              <div className="provider-item" key={provider.id}>
                <span>
                  <strong>{provider.name}</strong>{provider.isDefault ? <i className="provider-default">默认</i> : null}
                  <small>{provider.models.map((item) => item.name).join(", ")} · {provider.protocol === "openai_responses" ? "Responses" : "Chat"} · {provider.apiUrlMode === "full" ? "full URL" : "base URL"}</small>
                </span>
                <i className={provider.hasApiKey ? "provider-ready" : "provider-missing"}>{provider.hasApiKey ? "已配置" : "缺少密钥"}</i>
                <div className="provider-item-actions">
                  {!provider.isDefault ? <button onClick={() => onSetDefault(provider.id)} type="button">设为默认</button> : null}
                  <button onClick={() => startEdit(provider)} type="button">编辑</button>
                  <button onClick={() => remove(provider)} type="button" aria-label={`删除 ${provider.name}`}>×</button>
                </div>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
