import { useState } from "react";
import type { AppSettings, Provider, ProviderDraft } from "../../types";
import { Button, Dialog, EmptyState, StatusDot } from "../ui";
import { ProviderEditorDialog } from "./ProviderEditorDialog";

type SettingsSection = "general" | "models";

export function SettingsDialog({
  settings,
  providers,
  onPickDirectory,
  onClearDirectory,
  onSaveProvider,
  onSetDefaultProvider,
  onDeleteProvider,
  onClose,
}: {
  settings: AppSettings;
  providers: Provider[];
  onPickDirectory: () => Promise<void>;
  onClearDirectory: () => Promise<void>;
  onSaveProvider: (draft: ProviderDraft) => Promise<boolean>;
  onSetDefaultProvider: (providerId: string) => Promise<boolean>;
  onDeleteProvider: (providerId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [editingProvider, setEditingProvider] = useState<Provider | null | undefined>(undefined);
  const [deletingProvider, setDeletingProvider] = useState<Provider | null>(null);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [providerBusyId, setProviderBusyId] = useState<string | null>(null);

  async function changeDirectory(action: () => Promise<void>) {
    setDirectoryBusy(true);
    await action();
    setDirectoryBusy(false);
  }

  async function setDefault(providerId: string) {
    setProviderBusyId(providerId);
    await onSetDefaultProvider(providerId);
    setProviderBusyId(null);
  }

  async function confirmDelete() {
    if (!deletingProvider) return;
    setProviderBusyId(deletingProvider.id);
    const deleted = await onDeleteProvider(deletingProvider.id);
    setProviderBusyId(null);
    if (deleted) setDeletingProvider(null);
  }

  return (
    <>
      <Dialog open title="设置" description="管理 Sion 的本地目录和模型连接。" size="large" closeLabel="关闭设置" onClose={onClose}>
        <div className="settings-layout">
          <nav className="settings-section-nav" aria-label="设置分类">
            <button className={section === "general" ? "is-active" : ""} onClick={() => setSection("general")} type="button">通用</button>
            <button className={section === "models" ? "is-active" : ""} onClick={() => setSection("models")} type="button">模型</button>
          </nav>
          <div className="settings-section-content">
            {section === "general" ? (
              <section className="settings-general">
                <header><h3>项目目录</h3><p>所有项目都在此目录下按项目 ID 独立保存。</p></header>
                <div className="settings-directory-card">
                  <div><span>当前目录</span><strong>{settings.projectsDirectory ?? "尚未设置"}</strong></div>
                  <div>
                    <Button variant="secondary" loading={directoryBusy} onClick={() => void changeDirectory(onPickDirectory)}>更改</Button>
                    <Button variant="ghost" disabled={!settings.projectsDirectory || directoryBusy} onClick={() => void changeDirectory(onClearDirectory)}>清除</Button>
                  </div>
                </div>
                <p className="settings-boundary-note">更改目录不会把现有项目移动到新位置；Sion 会从新目录重新发现项目。</p>
              </section>
            ) : (
              <section className="settings-models">
                <header><div><h3>模型连接</h3><p>API Key 保存于本机 ~/.sion/providers.json，界面不会回显。</p></div><Button variant="primary" onClick={() => setEditingProvider(null)}>＋ 添加</Button></header>
                {providers.length === 0 ? (
                  <EmptyState title="尚未配置模型" description="本地编辑不受影响；需要运行 Agent 时再添加模型连接。" action={{ label: "添加模型连接", onClick: () => setEditingProvider(null) }} />
                ) : (
                  <div className="settings-provider-list">
                    {providers.map((provider) => (
                      <article key={provider.id}>
                        <div className="settings-provider-main">
                          <StatusDot kind={provider.hasApiKey ? "success" : "warning"} />
                          <div><strong>{provider.name}{provider.isDefault ? <span>默认</span> : null}</strong><small>{provider.models.map((model) => model.name).join(", ") || "未设置模型"} · {provider.protocol === "openai_responses" ? "Responses" : "Chat Completions"}</small></div>
                        </div>
                        <div className="settings-provider-status"><strong>{provider.hasApiKey ? "密钥已保存" : "缺少密钥"}</strong><small>{provider.apiUrlMode === "full" ? "完整 Endpoint" : "Base URL"}</small></div>
                        <div className="settings-provider-actions">
                          {!provider.isDefault ? <Button variant="ghost" loading={providerBusyId === provider.id} onClick={() => void setDefault(provider.id)}>设为默认</Button> : null}
                          <Button variant="secondary" onClick={() => setEditingProvider(provider)}>编辑</Button>
                          <Button variant="ghost" onClick={() => setDeletingProvider(provider)}>删除</Button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </Dialog>
      <ProviderEditorDialog open={editingProvider !== undefined} provider={editingProvider ?? null} providerCount={providers.length} onClose={() => setEditingProvider(undefined)} onSave={onSaveProvider} />
      <Dialog
        open={Boolean(deletingProvider)}
        title="删除模型连接？"
        description={deletingProvider ? `将删除 ${deletingProvider.name} 及本机保存的 API Key。` : undefined}
        size="confirm"
        closeLabel="关闭删除确认"
        onClose={() => setDeletingProvider(null)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setDeletingProvider(null)}>取消</Button>
            <Button variant="danger" loading={providerBusyId === deletingProvider?.id} onClick={() => void confirmDelete()}>删除</Button>
          </>
        )}
      >
        <p className="confirm-copy">此操作不会删除项目数据，但删除后使用该连接的 Agent 将无法运行。</p>
      </Dialog>
    </>
  );
}
