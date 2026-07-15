import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

const API_VERSION = 1;

const NODES = [
  ["basic-info", "项目基本信息"],
  ["goals", "需求背景与目标"],
  ["roles-permissions", "角色与权限"],
  ["business-flow", "业务流程"],
  ["feature-design", "功能模块"],
  ["page-interaction", "页面与交互"],
  ["data-structure", "数据结构"],
  ["api-design", "接口设计"],
  ["architecture-deployment", "架构与部署"],
  ["development-tasks", "开发任务"],
  ["risks-open-questions", "风险与待确认"],
  ["final-export", "最终文档"],
] as const;

type NodeId = (typeof NODES)[number][0];
type NodeStatus = "not_started" | "draft" | "generated" | "confirmed" | "needs_confirmation";

type VersionResponse = { apiVersion: number; appVersion: string; rustTarget: string };
type RecentProject = { id: string; name: string; rootPath: string; openedAt: string };
type ProjectManifest = { id: string; name: string; customerName: string; authorName: string; version: string };
type WorkflowNode = { id: NodeId; status: NodeStatus; markdown: string; revision: number; updatedAt: string };
type ProjectListResponse = { apiVersion: number; projects: RecentProject[] };
type CreateResponse = { apiVersion: number; created: boolean; project?: ProjectManifest };
type NodeResponse = { apiVersion: number } & WorkflowNode;
type SaveResponse = { apiVersion: number; saved?: WorkflowNode; conflict?: { latest: WorkflowNode } };

const statusLabel: Record<NodeStatus, string> = {
  not_started: "未开始",
  draft: "草稿",
  generated: "已生成",
  confirmed: "已确认",
  needs_confirmation: "待确认",
};

function now() { return new Date().toISOString(); }

export function App() {
  const [version, setVersion] = useState<VersionResponse | null>(null);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [project, setProject] = useState<RecentProject | null>(null);
  const [nodeId, setNodeId] = useState<NodeId>("basic-info");
  const [node, setNode] = useState<WorkflowNode | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("正在连接本机应用服务");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("新项目设计文档");
  const [newCustomer, setNewCustomer] = useState("");
  const [newAuthor, setNewAuthor] = useState("");

  const nodeTitle = useMemo(() => NODES.find(([id]) => id === nodeId)?.[1] ?? "节点", [nodeId]);
  const dirty = node !== null && draft !== node.markdown;

  useEffect(() => {
    void Promise.all([loadVersion(), loadProjects()]);
  }, []);

  useEffect(() => {
    if (project) void loadNode(project.id, nodeId);
  }, [project?.id, nodeId]);

  async function loadVersion() {
    try {
      const response = await invoke<VersionResponse>("app_get_version", { request: { apiVersion: API_VERSION } });
      setVersion(response);
    } catch (error) {
      setNotice(`IPC 不可用：${String(error)}`);
    }
  }

  async function loadProjects() {
    try {
      const response = await invoke<ProjectListResponse>("project_list", { request: { apiVersion: API_VERSION } });
      setProjects(response.projects);
    } catch (error) {
      setNotice(`读取项目注册表失败：${String(error)}`);
    }
  }

  async function createProject() {
    setCreating(true);
    setNotice("请选择用于保存此项目的目录");
    try {
      const response = await invoke<CreateResponse>("project_create", {
        request: {
          apiVersion: API_VERSION,
          id: crypto.randomUUID(),
          name: newName.trim() || "未命名项目",
          customerName: newCustomer.trim(),
          authorName: newAuthor.trim(),
          now: now(),
        },
      });
      if (!response.created || !response.project) {
        setNotice("已取消目录选择，未写入任何项目数据");
        return;
      }
      await loadProjects();
      setNotice(`已创建 ${response.project.name}；节点初稿已写入 .sion/`);
    } catch (error) {
      setNotice(`创建项目失败：${String(error)}`);
    } finally {
      setCreating(false);
    }
  }

  async function loadNode(projectId: string, nextNodeId: NodeId) {
    setNotice(`正在读取 ${NODES.find(([id]) => id === nextNodeId)?.[1] ?? "节点"}`);
    try {
      const response = await invoke<NodeResponse>("project_get_node", {
        request: { apiVersion: API_VERSION, projectId, nodeId: nextNodeId },
      });
      setNode(response);
      setDraft(response.markdown);
      setNotice(`节点 revision ${response.revision} 已从本地项目读取`);
    } catch (error) {
      setNode(null);
      setNotice(`读取节点失败：${String(error)}`);
    }
  }

  async function saveNode() {
    if (!project || !node) return;
    setSaving(true);
    try {
      const response = await invoke<SaveResponse>("project_save_node", {
        request: {
          apiVersion: API_VERSION,
          projectId: project.id,
          nodeId,
          expectedRevision: node.revision,
          markdown: draft,
          status: node.status,
          now: now(),
        },
      });
      if (response.conflict) {
        setNode(response.conflict.latest);
        setDraft(response.conflict.latest.markdown);
        setNotice("检测到另一次保存；已载入磁盘中的最新版本，没有覆盖它");
      } else if (response.saved) {
        setNode(response.saved);
        setDraft(response.saved.markdown);
        setNotice(`已原子保存 revision ${response.saved.revision}`);
      }
    } catch (error) {
      setNotice(`保存失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!project) {
    return (
      <main className="desk-shell landing-shell">
        <header className="masthead">
          <div><p className="kicker">SION / LOCAL DESKTOP</p><h1>设计文档<br /><em>落在你的手里。</em></h1></div>
          <div className="run-mark">01<span>WORKBENCH</span></div>
        </header>
        <section className="landing-intro"><span>本地优先 / Rust 核心 / 无浏览器自动化</span><p>每个项目都以可携带的 <code>.sion/</code> 目录保存。选择目录后，Sion 会创建 12 个可编辑的设计节点。</p></section>
        <section className="landing-grid">
          <form className="new-project-card" onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
            <p className="panel-kicker">新建项目</p><h2>开始一份<br />可迁移的设计稿</h2>
            <label>项目名称<input value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
            <div className="field-row"><label>客户<input value={newCustomer} onChange={(event) => setNewCustomer(event.target.value)} /></label><label>作者<input value={newAuthor} onChange={(event) => setNewAuthor(event.target.value)} /></label></div>
            <button className="primary-action" disabled={creating} type="submit">{creating ? "正在打开目录选择…" : "选择目录并创建"}<b>↗</b></button>
          </form>
          <section className="recent-projects" aria-label="最近项目"><div className="section-head"><p className="panel-kicker">最近打开</p><span>{projects.length.toString().padStart(2, "0")}</span></div>
            {projects.length === 0 ? <div className="empty-projects"><strong>还没有登记的项目</strong><span>创建项目或稍后从迁移向导导入旧项目。</span></div> : projects.map((item) => <button key={item.id} className="project-row" onClick={() => { setProject(item); setNodeId("basic-info"); }} type="button"><span className="project-dot" /><span><strong>{item.name}</strong><small>{item.rootPath}</small></span><b>↗</b></button>)}
          </section>
        </section>
        <footer><span>{notice}</span><span>RUST / {version?.rustTarget ?? "NEGOTIATING"}</span></footer>
      </main>
    );
  }

  return (
    <main className="desk-shell workbench-shell">
      <header className="workbench-bar"><button className="wordmark" onClick={() => setProject(null)} type="button">SION<span>DESKTOP</span></button><div className="project-heading"><span>项目 / {project.name}</span><strong>{nodeTitle}</strong></div><div className="save-state"><span className={dirty ? "dirty-dot" : "clean-dot"} />{dirty ? "有未保存修改" : "已同步本地磁盘"}<button className="save-button" disabled={!dirty || saving} onClick={() => void saveNode()} type="button">{saving ? "保存中" : "保存"} <b>⌘S</b></button></div></header>
      <div className="workbench-grid">
        <aside className="node-rail"><div className="rail-title"><span>设计路径</span><b>12</b></div>{NODES.map(([id, title], index) => <button className={id === nodeId ? "node-item selected" : "node-item"} key={id} onClick={() => setNodeId(id)} type="button"><span>{String(index + 1).padStart(2, "0")}</span><strong>{title}</strong><i>{id === nodeId ? "●" : ""}</i></button>)}<div className="rail-foot">项目状态<br /><strong>本地工作中</strong></div></aside>
        <section className="editor-pane"><div className="editor-head"><div><p className="panel-kicker">NODE / {nodeId.toUpperCase()}</p><h1>{nodeTitle}</h1></div><span className={`node-status status-${node?.status ?? "not_started"}`}>{node ? statusLabel[node.status] : "读取中"}</span></div><textarea aria-label={`${nodeTitle} Markdown 编辑器`} disabled={!node} onChange={(event) => setDraft(event.target.value)} spellCheck={false} value={draft} /><div className="editor-foot"><span>Markdown · revision {node?.revision ?? "—"}</span><span>{draft.length.toLocaleString()} 字符</span></div></section>
        <aside className="run-pane"><div className="run-heading"><p className="panel-kicker">任务中心</p><span>0 RUNS</span></div><div className="run-empty"><div className="orbit-mark">↗</div><h2>编辑已就绪</h2><p>本阶段只持久化人工编辑。Agent Run、文件上下文和交付预览会在下一里程碑接入，不会在这里模拟为已完成。</p></div><div className="boundary-list"><p>本机边界</p><span>✓ 节点 CAS 保存</span><span>✓ `.sion/` 原子写入</span><span>✓ 不含网页搜索</span><span>✓ 不含 Node 服务</span></div><div className="run-notice">{notice}</div></aside>
      </div>
    </main>
  );
}
