import { useState } from "react";
import type { ProviderDraft, ProviderManagerProps, Provider } from "../types";

const now = () => new Date().toISOString();

// Provider add/delete surface. Task 5 moves the existing add form and list here
// behind a dialog; Task 6 adds in-place edit (key preservation), explicit
// set-default, and delete confirmation.
export function ProviderManager({ providers, onSave, onDelete, onClose }: ProviderManagerProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [protocol, setProtocol] = useState<Provider["protocol"]>("chat_completions");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedModel = model.trim();
    if (!trimmedName || !trimmedModel || !key.trim()) return;
    const draft: ProviderDraft = {
      id: crypto.randomUUID(),
      name: trimmedName,
      apiBaseUrl: url.trim(),
      apiUrlMode: "base",
      protocol,
      model: trimmedModel,
      isDefault: providers.length === 0,
      apiKey: key.trim(),
      now: now(),
    };
    onSave(draft);
    setName("");
    setModel("");
    setKey("");
  }

  return (
    <section className="provider-manager" role="dialog" aria-modal="true" aria-label="模型连接管理">
      <div className="provider-manager-card">
        <div className="provider-manager-head">
          <div><p className="panel-kicker">模型连接</p><h2>把密钥留给<em>操作系统。</em></h2></div>
          <button onClick={onClose} type="button" aria-label="关闭模型连接管理">×</button>
        </div>
        <form className="provider-form" onSubmit={submit}>
          <label>提供商名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="OpenAI" /></label>
          <label>API Base URL<input value={url} onChange={(event) => setUrl(event.target.value)} /></label>
          <div className="provider-row"><label>协议<select value={protocol} onChange={(event) => setProtocol(event.target.value as Provider["protocol"])}><option value="chat_completions">Chat Completions</option><option value="openai_responses">Responses</option></select></label><label>默认模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-5" /></label></div>
          <label>API Key<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="仅写入系统凭据库" /></label>
          <button className="provider-save" type="submit">保存安全配置<b>↗</b></button>
        </form>
        <div className="provider-list">
          {providers.length === 0
            ? <p>尚未配置模型。当前工作台仍可离线编辑和保存。</p>
            : providers.map((provider) => (
              <div className="provider-item" key={provider.id}>
                <span><strong>{provider.name}</strong><small>{provider.models.map((item) => item.name).join(", ")} · {provider.protocol === "openai_responses" ? "Responses" : "Chat"}</small></span>
                <i className={provider.hasApiKey ? "provider-ready" : "provider-missing"}>{provider.hasApiKey ? "已配置" : "缺少密钥"}</i>
                <button onClick={() => onDelete(provider.id)} type="button" aria-label={`删除 ${provider.name}`}>×</button>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
