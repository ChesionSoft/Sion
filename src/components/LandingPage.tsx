import { useState } from "react";
import type { AppVersion, LandingPageProps } from "../types";

export function LandingPage({
  projects,
  providers,
  settings,
  creating,
  onCreate,
  onOpenProject,
  onOpenSettings,
  onOpenProviders,
  notice,
  appVersion,
}: LandingPageProps & { appVersion: AppVersion | null }) {
  const [newName, setNewName] = useState("新项目设计文档");
  const [newCustomer, setNewCustomer] = useState("");
  const [newAuthor, setNewAuthor] = useState("");
  const defaultProvider = providers.find((provider) => provider.isDefault) ?? providers[0] ?? null;

  return (
    <main className="desk-shell landing-shell">
      <header className="masthead">
        <div><p className="kicker">SION / LOCAL DESKTOP</p><h1>设计文档<br /><em>落在你的手里。</em></h1></div>
        <div className="run-mark">01<span>WORKBENCH</span></div>
      </header>
      <section className="landing-intro"><span>本地优先 / Rust 核心 / 无浏览器自动化</span><p>每个项目都以可携带的 <code>.sion/</code> 目录保存。选择目录后，Sion 会创建 12 个可编辑的设计节点。</p></section>
      <section className="landing-grid">
        <form className="new-project-card" onSubmit={(event) => { event.preventDefault(); onCreate(newName, newCustomer, newAuthor); }}>
          <p className="panel-kicker">新建项目</p><h2>开始一份<br />可迁移的设计稿</h2>
          <label>项目名称<input value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
          <div className="field-row"><label>客户<input value={newCustomer} onChange={(event) => setNewCustomer(event.target.value)} /></label><label>作者<input value={newAuthor} onChange={(event) => setNewAuthor(event.target.value)} /></label></div>
          <button className="primary-action" disabled={creating} type="submit">{creating ? "正在打开目录选择…" : "选择目录并创建"}<b>↗</b></button>
        </form>
        <section className="recent-projects" aria-label="最近项目"><div className="section-head"><p className="panel-kicker">最近打开</p><span>{projects.length.toString().padStart(2, "0")}</span></div>
          {projects.length === 0 ? <div className="empty-projects"><strong>还没有登记的项目</strong><span>选择目录创建你的第一份本地项目。</span></div> : projects.map((item) => <button key={item.id} className="project-row" onClick={() => onOpenProject(item)} type="button"><span className="project-dot" /><span><strong>{item.name}</strong><small>{item.rootPath}</small></span><b>↗</b></button>)}
        </section>
      </section>
      <section className="provider-settings">
        <div className="provider-copy"><p className="panel-kicker">模型连接</p><h2>把密钥留给<br /><em>操作系统。</em></h2><p>配置元数据保存在应用目录；API Key 只写入 macOS Keychain 或 Windows Credential Manager，界面永不回显。</p></div>
        <div className="provider-summary">
          <p className="provider-summary-state">
            {providers.length === 0
              ? "尚未配置模型连接。"
              : `已配置 ${providers.length} 个连接${defaultProvider ? `，默认 ${defaultProvider.name}` : ""}。`}
          </p>
          <div className="provider-summary-actions">
            <button className="provider-manage" onClick={onOpenProviders} type="button">管理模型连接<b>↗</b></button>
            <button className="settings-open" onClick={onOpenSettings} type="button">默认目录设置<b>↗</b></button>
          </div>
          <small className="provider-summary-directory">
            {settings.defaultProjectDirectory ? `默认项目目录：${settings.defaultProjectDirectory}` : "未设置默认项目目录；创建项目时将使用系统默认位置。"}
          </small>
        </div>
      </section>
      <footer><span>{notice}</span><span>RUST / {appVersion?.rustTarget ?? "NEGOTIATING"}</span></footer>
    </main>
  );
}
