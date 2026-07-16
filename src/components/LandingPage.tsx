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
      <section className="landing-intro"><span>本地优先 / Rust 核心 / 无浏览器自动化</span><p>所有项目都保存在你选择的项目目录下，以独立的项目文件夹存放。Sion 会为每个项目创建 12 个可编辑的设计节点。</p></section>
      <section className="landing-grid">
        <form className="new-project-card" onSubmit={(event) => { event.preventDefault(); onCreate(newName, newCustomer, newAuthor); }}>
          <p className="panel-kicker">新建项目</p><h2>开始一份<br />可迁移的设计稿</h2>
          <label>项目名称<input value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
          <div className="field-row"><label>客户<input value={newCustomer} onChange={(event) => setNewCustomer(event.target.value)} /></label><label>作者<input value={newAuthor} onChange={(event) => setNewAuthor(event.target.value)} /></label></div>
          <button className="primary-action" disabled={creating || !settings.projectsDirectory} type="submit">{creating ? "正在创建…" : "创建项目"}<b>↗</b></button>
        </form>
        <section className="recent-projects" aria-label="最近项目"><div className="section-head"><p className="panel-kicker">最近打开</p><span>{projects.length.toString().padStart(2, "0")}</span></div>
          {projects.length === 0 ? <div className="empty-projects"><strong>{settings.projectsDirectory ? "还没有项目" : "请先设置项目目录"}</strong><span>{settings.projectsDirectory ? "创建你的第一份本地项目。" : "选择一个项目目录后，Sion 会在此自动创建并发现项目。"}</span></div> : projects.map((item) => <button key={item.id} className="project-row" onClick={() => onOpenProject(item)} type="button"><span className="project-dot" /><span><strong>{item.name}</strong><small>{item.rootPath}</small></span><b>↗</b></button>)}
        </section>
      </section>
      <section className="provider-settings">
        <div className="provider-copy"><p className="panel-kicker">模型连接</p><h2>密钥留在本机<br /><em>不再回显。</em></h2><p>API Key 保存在本机 ~/.sion/providers.json，保存后不会回显。</p></div>
        <div className="provider-summary">
          <p className="provider-summary-state">
            {providers.length === 0
              ? "尚未配置模型连接。"
              : `已配置 ${providers.length} 个连接${defaultProvider ? `，默认 ${defaultProvider.name}` : ""}。`}
          </p>
          <div className="provider-summary-actions">
            <button className="provider-manage" onClick={onOpenProviders} type="button">管理模型连接<b>↗</b></button>
            <button className="settings-open" onClick={onOpenSettings} type="button">项目目录设置<b>↗</b></button>
          </div>
          <small className="provider-summary-directory">
            {settings.projectsDirectory ? `项目目录：${settings.projectsDirectory}` : "未设置项目目录；请先选择一个项目目录。"}
          </small>
        </div>
      </section>
      <footer><span>{notice}</span><span>RUST / {appVersion?.rustTarget ?? "NEGOTIATING"}</span></footer>
    </main>
  );
}
