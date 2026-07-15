import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
type ChatSession = { id: string; nodeId: NodeId; name: string; messageCount: number; createdAt: string; updatedAt: string };
type ChatMessage = { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string };
type ProjectFile = { id: string; originalName: string; byteSize: number; status: string; extractionStatus?: string; textPath?: string };
type ProjectListResponse = { apiVersion: number; projects: RecentProject[] };
type CreateResponse = { apiVersion: number; created: boolean; project?: ProjectManifest };
type NodeResponse = { apiVersion: number } & WorkflowNode;
type SaveResponse = { apiVersion: number; saved?: WorkflowNode; conflict?: { latest: WorkflowNode } };
type DeliveryPreviewResponse = { apiVersion: number; assistantMessageId: string; nodeId: NodeId; currentRevision: number; markdown: string; additions: number; deletions: number; unchanged: number };
type SessionListResponse = { apiVersion: number; sessions: ChatSession[] };
type MessageListResponse = { apiVersion: number; messages: ChatMessage[] };
type FileListResponse = { apiVersion: number; files: ProjectFile[] };
type FileImportResponse = { apiVersion: number; imported: boolean; file?: ProjectFile };
type ProviderModel = { name: string; isDefault: boolean; toolCalling: boolean };
type Provider = { id: string; name: string; apiBaseUrl: string; apiUrlMode: "base" | "full"; protocol: "chat_completions" | "openai_responses"; models: ProviderModel[]; isDefault: boolean; hasApiKey: boolean };
type ProviderListResponse = { apiVersion: number; providers: Provider[] };
type ProviderSaveResponse = { apiVersion: number } & Provider;
type AgentRun = { id: string; projectId: string; nodeId: NodeId; status: "queued" | "running" | "completed" | "failed" | "cancelled"; summary?: string };
type AgentRunListResponse = { apiVersion: number; runs: AgentRun[] };
type AgentTokenEvent = { runId: string; projectId: string; nodeId: NodeId; sessionId: string; delta: string };
type AgentFinishedEvent = { run: AgentRun };
type MigrationWorkspaceResponse = { apiVersion: number; selected: boolean; legacyRoot?: string; projectIds: string[] };
type MigrationResult = { apiVersion: number; report: { migratedNodes: number; migratedSessions: number; migratedFiles: number; skippedFeatures: string[] }; project: ProjectManifest };
type ProviderMigrationResult = { apiVersion: number; migratedProviders: number };
type ProjectExportResponse = { apiVersion: number; exported: boolean; path?: string };

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
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [importingFile, setImportingFile] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerName, setProviderName] = useState("");
  const [providerUrl, setProviderUrl] = useState("https://api.openai.com/v1");
  const [providerModel, setProviderModel] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [providerProtocol, setProviderProtocol] = useState<Provider["protocol"]>("chat_completions");
  const [savingProvider, setSavingProvider] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [legacyRoot, setLegacyRoot] = useState<string | null>(null);
  const [legacyProjects, setLegacyProjects] = useState<string[]>([]);
  const [legacyProjectId, setLegacyProjectId] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [migratingProviders, setMigratingProviders] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deliveryPreview, setDeliveryPreview] = useState<DeliveryPreviewResponse | null>(null);
  const [previewingMessageId, setPreviewingMessageId] = useState<string | null>(null);

  const nodeTitle = useMemo(() => NODES.find(([id]) => id === nodeId)?.[1] ?? "节点", [nodeId]);
  const dirty = node !== null && draft !== node.markdown;

  useEffect(() => {
    void Promise.all([loadVersion(), loadProjects(), loadProviders()]);
  }, []);

  useEffect(() => {
    if (project) {
      void loadNode(project.id, nodeId);
      void loadSessions(project.id, nodeId);
    }
  }, [project, nodeId]);

  useEffect(() => {
    if (project) {
      void loadFiles(project.id);
    }
  }, [project]);

  useEffect(() => {
    if (project) void loadRuns(project.id);
  }, [project]);

  useEffect(() => {
    if (project && sessionId) void loadMessages(project.id, nodeId, sessionId);
  }, [project, nodeId, sessionId]);

  useEffect(() => {
    let disposed = false;
    const subscriptions = Promise.all([
      listen<AgentTokenEvent>("agent-token", (event) => {
        const token = event.payload;
        if (!project || token.projectId !== project.id || token.nodeId !== nodeId || token.sessionId !== sessionId) return;
        setActiveRunId(token.runId);
        setMessages((current) => {
          const transientId = `stream-${token.runId}`;
          const existing = current.find((message) => message.id === transientId);
          if (existing) return current.map((message) => message.id === transientId ? { ...message, content: message.content + token.delta } : message);
          return [...current, { id: transientId, role: "assistant", content: token.delta, createdAt: now() }];
        });
      }),
      listen<AgentFinishedEvent>("agent-run-finished", (event) => {
        const run = event.payload.run;
        if (!project || run.projectId !== project.id || run.nodeId !== nodeId) return;
        setActiveRunId((current) => current === run.id ? null : current);
        setMessages((current) => current.filter((message) => message.id !== `stream-${run.id}`));
        if (sessionId) void loadMessages(project.id, nodeId, sessionId);
        void loadRuns(project.id);
        setNotice(run.status === "completed" ? "Agent 回复已保存到本地会话" : run.summary ?? "Agent Run 已结束");
      }),
    ]);
    return () => { disposed = true; void subscriptions.then((unlisten) => { if (disposed) unlisten.forEach((stop) => stop()); }); };
  }, [project, nodeId, sessionId]);

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

  async function loadProviders() {
    try {
      const response = await invoke<ProviderListResponse>("provider_list", { request: { apiVersion: API_VERSION } });
      setProviders(response.providers);
    } catch (error) {
      setNotice(`读取模型配置失败：${String(error)}`);
    }
  }

  async function loadRuns(projectId: string) {
    try {
      const response = await invoke<AgentRunListResponse>("agent_run_list", { request: { apiVersion: API_VERSION, projectId } });
      setRuns(response.runs);
    } catch (error) {
      setNotice(`读取任务中心失败：${String(error)}`);
    }
  }

  async function saveProvider() {
    const name = providerName.trim();
    const model = providerModel.trim();
    if (!name || !model || !providerKey.trim()) {
      setNotice("请填写提供商名称、模型名称和 API Key");
      return;
    }
    setSavingProvider(true);
    try {
      const response = await invoke<ProviderSaveResponse>("provider_save", {
        request: {
          apiVersion: API_VERSION,
          id: crypto.randomUUID(), name, apiBaseUrl: providerUrl.trim(), apiUrlMode: "base",
          protocol: providerProtocol, models: [{ name: model, isDefault: true, toolCalling: false }],
          isDefault: providers.length === 0, apiKey: providerKey, now: now(),
        },
      });
      setProviders((current) => [...current.map((item) => ({ ...item, isDefault: false })), response]);
      setProviderName(""); setProviderModel(""); setProviderKey("");
      setNotice(`${response.name} 已保存；密钥仅保存在系统钥匙串`);
    } catch (error) {
      setNotice(`保存模型配置失败：${String(error)}`);
    } finally {
      setSavingProvider(false);
    }
  }

  async function deleteProvider(provider: Provider) {
    try {
      await invoke("provider_delete", { request: { apiVersion: API_VERSION, providerId: provider.id } });
      setProviders((current) => current.filter((item) => item.id !== provider.id));
      setNotice(`${provider.name} 的配置和系统凭据已删除`);
    } catch (error) {
      setNotice(`删除模型配置失败：${String(error)}`);
    }
  }

  async function pickLegacyWorkspace() {
    try {
      const response = await invoke<MigrationWorkspaceResponse>("migration_pick_workspace", { request: { apiVersion: API_VERSION } });
      if (!response.selected || !response.legacyRoot) {
        setNotice("已取消旧工作区选择");
        return;
      }
      setLegacyRoot(response.legacyRoot);
      setLegacyProjects(response.projectIds);
      setLegacyProjectId(response.projectIds[0] ?? "");
      setNotice(response.projectIds.length ? `发现 ${response.projectIds.length} 个可迁移旧项目` : "所选目录中没有可迁移的旧项目");
    } catch (error) {
      setNotice(`检查旧工作区失败：${String(error)}`);
    }
  }

  async function migrateLegacyProject() {
    if (!legacyRoot || !legacyProjectId) return;
    setMigrating(true);
    setNotice("请选择新项目的目标目录；迁移将写入其中的 .sion/");
    try {
      const response = await invoke<MigrationResult>("migration_run_native", {
        request: { apiVersion: API_VERSION, legacyRoot, projectId: legacyProjectId },
      });
      await loadProjects();
      setNotice(`已迁移 ${response.project.name}：${response.report.migratedNodes} 个节点、${response.report.migratedSessions} 个会话、${response.report.migratedFiles} 个文件。浏览器搜索未迁移。`);
      setLegacyRoot(null); setLegacyProjects([]); setLegacyProjectId("");
    } catch (error) {
      setNotice(`迁移失败：${String(error)}`);
    } finally {
      setMigrating(false);
    }
  }

  async function migrateLegacyProviders() {
    if (!legacyRoot) return;
    setMigratingProviders(true);
    try {
      const response = await invoke<ProviderMigrationResult>("provider_migration_run_native", {
        request: { apiVersion: API_VERSION, legacyRoot },
      });
      await loadProviders();
      setNotice(`已将 ${response.migratedProviders} 组旧模型凭据迁移到系统钥匙串`);
    } catch (error) {
      setNotice(`迁移模型凭据失败：${String(error)}`);
    } finally {
      setMigratingProviders(false);
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

  async function previewAssistant(messageId: string) {
    if (!project || !node || !sessionId) return;
    if (dirty) {
      setNotice("请先保存或处理当前编辑器里的未保存修改，再预览 Assistant 修改");
      return;
    }
    setPreviewingMessageId(messageId);
    try {
      const response = await invoke<DeliveryPreviewResponse>("project_preview_assistant_delivery", {
        request: { apiVersion: API_VERSION, projectId: project.id, nodeId, sessionId, assistantMessageId: messageId },
      });
      setDeliveryPreview(response);
      setNotice(`已生成修改预览：+${response.additions} / -${response.deletions} / ${response.unchanged} 行保留`);
    } catch (error) {
      setNotice(`预览 Assistant 修改失败：${String(error)}`);
    } finally {
      setPreviewingMessageId(null);
    }
  }

  async function applyAssistant(messageId: string) {
    if (!project || !node || !sessionId) return;
    if (dirty) {
      setNotice("请先保存或处理当前编辑器里的未保存修改，再应用 Assistant 修改");
      return;
    }
    try {
      const response = await invoke<SaveResponse>("project_apply_assistant", {
        request: { apiVersion: API_VERSION, projectId: project.id, nodeId, sessionId, assistantMessageId: messageId, expectedRevision: node.revision, now: now() },
      });
      if (response.conflict) {
        setNode(response.conflict.latest); setDraft(response.conflict.latest.markdown);
        setDeliveryPreview(null);
        setNotice("节点在确认前已被修改；已显示最新版本，未覆盖它");
      } else if (response.saved) {
        setNode(response.saved); setDraft(response.saved.markdown);
        setDeliveryPreview(null);
        setNotice(`已应用 Assistant 修改到节点 revision ${response.saved.revision}`);
      }
    } catch (error) {
      setNotice(`应用 Assistant 修改失败：${String(error)}`);
    }
  }

  async function loadSessions(projectId: string, nextNodeId: NodeId) {
    setSessionId(null);
    setMessages([]);
    setDeliveryPreview(null);
    try {
      const response = await invoke<SessionListResponse>("session_list", {
        request: { apiVersion: API_VERSION, projectId, nodeId: nextNodeId },
      });
      setSessions(response.sessions);
      setSessionId(response.sessions[0]?.id ?? null);
    } catch (error) {
      setSessions([]);
      setNotice(`读取会话失败：${String(error)}`);
    }
  }

  async function createSession(): Promise<ChatSession | null> {
    if (!project) return null;
    try {
      const session = await invoke<ChatSession>("session_create", {
        request: {
          apiVersion: API_VERSION,
          projectId: project.id,
          nodeId,
          name: `会话 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
          now: now(),
        },
      });
      setSessions((current) => [session, ...current]);
      setSessionId(session.id);
      setMessages([]);
      setNotice("已创建本地会话");
      return session;
    } catch (error) {
      setNotice(`创建会话失败：${String(error)}`);
      return null;
    }
  }

  async function loadMessages(projectId: string, nextNodeId: NodeId, nextSessionId: string) {
    try {
      const response = await invoke<MessageListResponse>("message_list", {
        request: { apiVersion: API_VERSION, projectId, nodeId: nextNodeId, sessionId: nextSessionId },
      });
      setMessages(response.messages);
    } catch (error) {
      setMessages([]);
      setNotice(`读取消息失败：${String(error)}`);
    }
  }

  async function sendMessage() {
    const content = messageDraft.trim();
    if (!project || !content) return;
    setSendingMessage(true);
    try {
      const active = sessionId ? sessions.find((session) => session.id === sessionId) ?? null : await createSession();
      if (!active) return;
      const message: ChatMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: now() };
      await invoke<ChatSession>("message_append", {
        request: { apiVersion: API_VERSION, projectId: project.id, nodeId, sessionId: active.id, message, now: now() },
      });
      setMessages((current) => [...current, message]);
      setSessions((current) => current.map((session) => session.id === active.id ? { ...session, messageCount: session.messageCount + 1, updatedAt: message.createdAt } : session));
      setMessageDraft("");
      try {
        const run = await invoke<AgentRun>("agent_run_start", {
          request: { apiVersion: API_VERSION, projectId: project.id, nodeId, sessionId: active.id, fileIds: selectedFileIds, now: now() },
        });
        setActiveRunId(run.id);
        setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
        setNotice(run.status === "queued" ? "Agent Run 已排队；同一节点不会并发写入" : "Agent 正在本机流式生成回复");
      } catch (error) {
        setNotice(`用户消息已保存；暂未启动 Agent：${String(error)}`);
      }
    } catch (error) {
      setNotice(`保存消息失败：${String(error)}`);
    } finally {
      setSendingMessage(false);
    }
  }

  async function cancelAgent() {
    if (!project || !activeRunId) return;
    try {
      await invoke<AgentRun>("agent_run_cancel", { request: { apiVersion: API_VERSION, projectId: project.id, runId: activeRunId, now: now() } });
      await loadRuns(project.id);
      setNotice("已请求取消 Agent Run；未完成的流式片段不会写入本地会话");
    } catch (error) {
      setNotice(`取消 Agent Run 失败：${String(error)}`);
    }
  }

  async function exportDocx() {
    if (!project) return;
    setExporting(true);
    setNotice("请选择 DOCX 保存位置");
    try {
      const response = await invoke<ProjectExportResponse>("project_export_docx", { request: { apiVersion: API_VERSION, projectId: project.id } });
      setNotice(response.exported ? `DOCX 已导出到 ${response.path}` : "已取消 DOCX 导出");
    } catch (error) {
      setNotice(`DOCX 导出失败：${String(error)}`);
    } finally {
      setExporting(false);
    }
  }

  async function loadFiles(projectId: string) {
    try {
      const response = await invoke<FileListResponse>("file_list", {
        request: { apiVersion: API_VERSION, projectId },
      });
      setFiles(response.files);
    } catch (error) {
      setFiles([]);
      setNotice(`读取文件池失败：${String(error)}`);
    }
  }

  async function importFile() {
    if (!project) return;
    setImportingFile(true);
    try {
      const response = await invoke<FileImportResponse>("file_import", {
        request: { apiVersion: API_VERSION, projectId: project.id, now: now() },
      });
      if (!response.imported || !response.file) {
        setNotice("已取消文件选择，项目未改变");
        return;
      }
      setFiles((current) => [...current, response.file!]);
      setNotice(response.file.extractionStatus === "available" ? `已导入并提取 ${response.file.originalName}` : `已导入 ${response.file.originalName}；该格式尚未提取文本`);
    } catch (error) {
      setNotice(`导入文件失败：${String(error)}`);
    } finally {
      setImportingFile(false);
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
            {projects.length === 0 ? <div className="empty-projects"><strong>还没有登记的项目</strong><span>创建项目或稍后从迁移向导导入旧项目。</span></div> : projects.map((item) => <button key={item.id} className="project-row" onClick={() => { setDeliveryPreview(null); setSelectedFileIds([]); setProject(item); setNodeId("basic-info"); }} type="button"><span className="project-dot" /><span><strong>{item.name}</strong><small>{item.rootPath}</small></span><b>↗</b></button>)}
          </section>
        </section>
        <section className="migration-panel"><div><p className="panel-kicker">旧数据迁移</p><h2>把历史带来，<em>不带浏览器。</em></h2><p>选择旧 Sion 工作区后，逐个迁移到新目录的 <code>.sion/</code>。历史消息、文件和导出会保留；浏览器搜索设置、缓存和网页抓取不会进入新应用。</p></div><div className="migration-actions"><button className="migration-pick" onClick={() => void pickLegacyWorkspace()} type="button">{legacyRoot ? "重新选择旧工作区" : "选择旧工作区"}<b>↗</b></button>{legacyRoot ? <><small>{legacyRoot}</small><button disabled={migratingProviders} onClick={() => void migrateLegacyProviders()} type="button">{migratingProviders ? "凭据迁移中…" : "迁移模型凭据"}<b>↗</b></button><select value={legacyProjectId} onChange={(event) => setLegacyProjectId(event.target.value)}>{legacyProjects.map((id) => <option key={id} value={id}>{id}</option>)}</select><button className="migration-run" disabled={!legacyProjectId || migrating} onClick={() => void migrateLegacyProject()} type="button">{migrating ? "迁移中…" : "选择目标并迁移"}<b>↗</b></button></> : <span>迁移始终先在临时目录验证，再原子写入。</span>}</div></section>
        <section className="provider-settings">
          <div className="provider-copy"><p className="panel-kicker">模型连接</p><h2>把密钥留给<br /><em>操作系统。</em></h2><p>配置元数据保存在应用目录；API Key 只写入 macOS Keychain 或 Windows Credential Manager，界面永不回显。</p></div>
          <form className="provider-form" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
            <label>提供商名称<input value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="OpenAI" /></label>
            <label>API Base URL<input value={providerUrl} onChange={(event) => setProviderUrl(event.target.value)} /></label>
            <div className="provider-row"><label>协议<select value={providerProtocol} onChange={(event) => setProviderProtocol(event.target.value as Provider["protocol"])}><option value="chat_completions">Chat Completions</option><option value="openai_responses">Responses</option></select></label><label>默认模型<input value={providerModel} onChange={(event) => setProviderModel(event.target.value)} placeholder="gpt-5" /></label></div>
            <label>API Key<input type="password" autoComplete="off" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder="仅写入系统凭据库" /></label>
            <button className="provider-save" disabled={savingProvider} type="submit">{savingProvider ? "写入中…" : "保存安全配置"}<b>↗</b></button>
          </form>
          <div className="provider-list">{providers.length === 0 ? <p>尚未配置模型。当前工作台仍可离线编辑和保存。</p> : providers.map((provider) => <div className="provider-item" key={provider.id}><span><strong>{provider.name}</strong><small>{provider.models.map((model) => model.name).join(", ")} · {provider.protocol === "openai_responses" ? "Responses" : "Chat"}</small></span><i className={provider.hasApiKey ? "provider-ready" : "provider-missing"}>{provider.hasApiKey ? "已配置" : "缺少密钥"}</i><button onClick={() => void deleteProvider(provider)} type="button" aria-label={`删除 ${provider.name}`}>×</button></div>)}</div>
        </section>
        <footer><span>{notice}</span><span>RUST / {version?.rustTarget ?? "NEGOTIATING"}</span></footer>
      </main>
    );
  }

  return (
    <main className="desk-shell workbench-shell">
      <header className="workbench-bar"><button className="wordmark" onClick={() => { setDeliveryPreview(null); setProject(null); }} type="button">SION<span>DESKTOP</span></button><div className="project-heading"><span>项目 / {project.name}</span><strong>{nodeTitle}</strong></div><div className="save-state"><span className={dirty ? "dirty-dot" : "clean-dot"} />{dirty ? "有未保存修改" : "已同步本地磁盘"}<button className="export-button" disabled={exporting} onClick={() => void exportDocx()} type="button">{exporting ? "导出中" : "DOCX"}</button><button className="save-button" disabled={!dirty || saving} onClick={() => void saveNode()} type="button">{saving ? "保存中" : "保存"} <b>⌘S</b></button></div></header>
      <div className="workbench-grid">
        <aside className="node-rail"><div className="rail-title"><span>设计路径</span><b>12</b></div>{NODES.map(([id, title], index) => <button className={id === nodeId ? "node-item selected" : "node-item"} key={id} onClick={() => { setDeliveryPreview(null); setNodeId(id); }} type="button"><span>{String(index + 1).padStart(2, "0")}</span><strong>{title}</strong><i>{id === nodeId ? "●" : ""}</i></button>)}<div className="rail-foot"><div className="file-head"><span>文件池 / {files.length}</span><button disabled={importingFile} onClick={() => void importFile()} type="button">{importingFile ? "导入中" : "+ 导入"}</button></div>{files.length === 0 ? <small>尚无项目文件</small> : files.slice(-3).map((file) => <label className="file-row" key={file.id}><input checked={selectedFileIds.includes(file.id)} disabled={file.extractionStatus !== "available"} onChange={() => setSelectedFileIds((current) => current.includes(file.id) ? current.filter((id) => id !== file.id) : [...current, file.id])} type="checkbox" /> {file.extractionStatus === "available" ? "◼" : "◇"} {file.originalName}</label>)}</div></aside>
        <section className="editor-pane"><div className="editor-head"><div><p className="panel-kicker">NODE / {nodeId.toUpperCase()}</p><h1>{nodeTitle}</h1></div><span className={`node-status status-${node?.status ?? "not_started"}`}>{node ? statusLabel[node.status] : "读取中"}</span></div><textarea aria-label={`${nodeTitle} Markdown 编辑器`} disabled={!node} onChange={(event) => setDraft(event.target.value)} spellCheck={false} value={draft} /><div className="editor-foot"><span>Markdown · revision {node?.revision ?? "—"}</span><span>{draft.length.toLocaleString()} 字符</span></div></section>
      <aside className="run-pane"><div className="run-heading"><p className="panel-kicker">节点会话</p><span>{activeRunId ? <button className="cancel-run" onClick={() => void cancelAgent()} type="button">取消运行</button> : <button className="new-session" onClick={() => void createSession()} type="button">+ 新建</button>}</span></div><div className="session-list">{sessions.length === 0 ? <p className="session-empty">这个节点还没有会话。可直接输入消息，Sion 会先建立本地会话。</p> : sessions.map((session) => <button className={session.id === sessionId ? "session-row active" : "session-row"} key={session.id} onClick={() => { setDeliveryPreview(null); setSessionId(session.id); }} type="button"><strong>{session.name}</strong><span>{session.messageCount} 条消息</span></button>)}</div><div className="task-center"><p>任务中心 / {runs.length}</p>{runs.length === 0 ? <span>暂无运行记录</span> : runs.slice(0, 3).map((run) => <div key={run.id}><i className={`run-${run.status}`} /> <strong>{run.nodeId === nodeId ? "当前节点" : run.nodeId}</strong><small>{run.status === "running" ? "运行中" : run.status === "queued" ? "排队中" : run.status === "completed" ? "已完成" : run.status === "cancelled" ? "已取消" : "失败"}</small></div>)}</div><div className="message-thread">{messages.length === 0 ? <div className="thread-empty"><div className="orbit-mark">↗</div><p>消息会保存在项目 `.sion/chat/`。历史来源和 token 元数据也可被保留，但新应用不会发起网页搜索。</p></div> : messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span>{message.role === "user" ? "你" : message.role === "assistant" ? "助手" : "系统"}</span><p>{message.content}</p>{message.role === "assistant" && !message.id.startsWith("stream-") ? <button className="apply-reply" disabled={previewingMessageId === message.id} onClick={() => void previewAssistant(message.id)} type="button">{previewingMessageId === message.id ? "解析中" : "预览修改"}</button> : null}</article>)}</div><form className="message-form" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}><textarea aria-label="发送给此节点的消息" onChange={(event) => setMessageDraft(event.target.value)} placeholder="描述你希望在此节点完成的工作…" value={messageDraft} /><button disabled={!messageDraft.trim() || sendingMessage || Boolean(activeRunId)} type="submit">{sendingMessage ? "发送中" : activeRunId ? "Agent 运行中" : "发送并运行"}<b>↗</b></button></form><div className="run-notice">{notice}</div></aside>
      </div>
      {deliveryPreview ? <section className="delivery-preview" role="dialog" aria-modal="true" aria-label="Assistant 修改预览"><div className="delivery-preview-card"><div className="delivery-preview-head"><div><p className="panel-kicker">修改预览</p><span>以下为应用分节交付后的完整节点</span></div><button onClick={() => setDeliveryPreview(null)} type="button" aria-label="关闭修改预览">×</button></div><div className="delivery-stats"><span><strong>+{deliveryPreview.additions}</strong> 新增</span><span><strong>-{deliveryPreview.deletions}</strong> 删除</span><span><strong>{deliveryPreview.unchanged}</strong> 保留</span><span><strong>r{deliveryPreview.currentRevision}</strong> 基线</span></div><pre>{deliveryPreview.markdown}</pre><div className="delivery-actions"><button onClick={() => setDeliveryPreview(null)} type="button">取消</button><button onClick={() => void applyAssistant(deliveryPreview.assistantMessageId)} type="button">确认应用修改</button></div></div></section> : null}
    </main>
  );
}
