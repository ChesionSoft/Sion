import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelAgentRun,
  clearProjectsDirectory,
  applyAssistant as applyAssistantApi,
  appendMessage,
  createProject,
  createSession as createSessionApi,
  deleteProvider,
  exportDocx as exportDocxApi,
  getAgentOverride,
  getFilePreview,
  getNode,
  getProjects,
  getSettings,
  importFile as importFileApi,
  listFiles,
  listMessages,
  listProviders,
  listRuns,
  listSessions,
  pickProjectsDirectory,
  previewAssistantDelivery,
  revealProject,
  saveAgentOverride,
  saveNode,
  saveProvider,
  saveUiSettings,
  setDefaultProvider,
  startAgentRun,
} from "./api";
import { AppShell } from "./components/app/AppShell";
import { ProjectHome } from "./components/app/ProjectHome";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ProjectWorkspace } from "./components/workspace/ProjectWorkspace";
import { AgentRuleDialog } from "./components/workspace/AgentRuleDialog";
import { DeliveryPreviewTab } from "./components/workspace/DeliveryPreviewTab";
import { DeliveryTab } from "./components/workspace/DeliveryTab";
import { FilePreviewTab } from "./components/workspace/FilePreviewTab";
import { ProjectFilesTab } from "./components/workspace/ProjectFilesTab";
import { WorkspaceTabs } from "./components/workspace/WorkspaceTabs";
import { EmptyState } from "./components/ui";
import { NODES, type AgentFinishedEvent, type AgentRun, type AgentTokenEvent, type AppSettings, type AssistantDeliveryPreview, type ChatMessage, type ChatSession, type FilePreview, type MainDestination, type NodeId, type NoticeMessage, type ProjectFile, type Provider, type ProviderDraft, type RecentProject, type RightTabId, type UiSettings, type WorkflowNode } from "./types";
import { closeNode as closeUiNode, closeRightTab as closeUiRightTab, initialProjectUi, initialUiSettings, openNode as openUiNode, openRightTab as openUiRightTab, sanitizeUiSettings } from "./ui-state.ts";

const now = () => new Date().toISOString();

export function App() {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [project, setProject] = useState<RecentProject | null>(null);
  const [node, setNode] = useState<WorkflowNode | null>(null);
  const [draft, setDraft] = useState("");
  const [agentOverride, setAgentOverride] = useState<string | null>(null);
  const [agentOverrideDraft, setAgentOverrideDraft] = useState("");
  const [agentOverrideOpen, setAgentOverrideOpen] = useState(false);
  const [savingAgentOverride, setSavingAgentOverride] = useState(false);
  const [notice, setNoticeState] = useState<NoticeMessage | null>({ id: "startup", kind: "warning", message: "正在连接本机应用服务", dismissAfterMs: null });
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [importingFile, setImportingFile] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ projectsDirectory: null, ui: initialUiSettings() });
  const [ui, setUi] = useState<UiSettings>(initialUiSettings);
  const [destination, setDestination] = useState<MainDestination>("projects");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [exporting, setExporting] = useState(false);
  const [deliveryPreview, setDeliveryPreview] = useState<AssistantDeliveryPreview | null>(null);
  const [previewingMessageId, setPreviewingMessageId] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);

  const projectUi = project ? ui.projects[project.id] : undefined;
  const activeNodeId = projectUi?.activeNodeId ?? null;
  const activeRightTabId = projectUi?.activeRightTabId ?? null;
  const nodeId: NodeId = activeNodeId ?? "basic-info";
  const nodeTitle = useMemo(() => NODES.find(([id]) => id === nodeId)?.[1] ?? "节点", [nodeId]);
  const dirty = node !== null && draft !== node.markdown;
  const dismissNotice = useCallback(() => setNoticeState(null), []);

  function setNotice(message: string) {
    const kind = /失败|错误|不可用/.test(message) ? "error" : /正在|请先|未|取消|检测|暂/.test(message) ? "warning" : "success";
    setNoticeState({ id: crypto.randomUUID(), kind, message, dismissAfterMs: kind === "success" ? 4000 : null });
  }

  function updateUi(next: UiSettings) {
    const sanitized = sanitizeUiSettings(next);
    setUi(sanitized);
    setSettings((current) => ({ ...current, ui: sanitized }));
    void saveUiSettings(sanitized).catch((error) => setNotice(`保存界面状态失败：${String(error)}`));
  }

  useEffect(() => {
    void Promise.all([loadProjects(), loadProviders(), loadSettings()]);
  }, []);

  useEffect(() => {
    if (project && activeNodeId) {
      void loadNode(project.id, activeNodeId);
      void loadAgentOverride(project.id, activeNodeId);
      void loadSessions(project.id, activeNodeId);
    } else if (project) {
      setNode(null);
      setDraft("");
      setSessions([]);
      setSessionId(null);
      setMessages([]);
    }
  }, [project, activeNodeId]);

  useEffect(() => {
    if (project) void loadFiles(project.id);
  }, [project]);

  useEffect(() => {
    if (project && activeRightTabId?.startsWith("file:")) void selectFilePreview(activeRightTabId.slice("file:".length));
  }, [project, activeRightTabId]);

  useEffect(() => {
    if (project) void loadRuns(project.id);
  }, [project]);

  useEffect(() => {
    if (project && activeNodeId && sessionId) void loadMessages(project.id, activeNodeId, sessionId);
  }, [project, activeNodeId, sessionId]);

  useEffect(() => {
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
    return () => { void subscriptions.then((unlisten) => unlisten.forEach((stop) => stop())); };
  }, [project, nodeId, sessionId]);

  useEffect(() => {
    function saveWithShortcut(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "s" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (!event.repeat && project && node && dirty && !saving) void saveNodeDraft();
    }
    window.addEventListener("keydown", saveWithShortcut);
    return () => window.removeEventListener("keydown", saveWithShortcut);
  }, [project, node, draft, dirty, saving]);

  async function loadProjects(): Promise<RecentProject[]> {
    try {
      const result = await getProjects();
      setProjects(result.projects);
      if (result.warnings.length > 0) setNotice(result.warnings[0]);
      return result.projects;
    } catch (error) {
      setNotice(`读取项目目录失败：${String(error)}`);
      return [];
    }
  }

  async function loadProviders() {
    try {
      setProviders(await listProviders());
    } catch (error) {
      setNotice(`读取模型配置失败：${String(error)}`);
    }
  }

  async function loadSettings() {
    try {
      const loaded = await getSettings();
      const loadedUi = sanitizeUiSettings(loaded.ui);
      setSettings({ ...loaded, ui: loadedUi });
      setUi(loadedUi);
      setDestination(loadedUi.lastDestination);
    } catch (error) {
      setNotice(`读取应用设置失败：${String(error)}`);
    }
  }

  async function chooseDefaultDirectory() {
    try {
      const updated = await pickProjectsDirectory();
      setSettings(updated);
      setUi(sanitizeUiSettings(updated.ui));
      if (updated.projectsDirectory) {
        setNotice("项目目录已更新；Sion 会在此目录自动创建并发现多个项目");
        void loadProjects();
      } else {
        setNotice("未更改项目目录");
      }
    } catch (error) {
      setNotice(`设置项目目录失败：${String(error)}`);
    }
  }

  async function resetDefaultDirectory() {
    try {
      const updated = await clearProjectsDirectory();
      setSettings(updated);
      setUi(sanitizeUiSettings(updated.ui));
      setProjects([]);
      setNotice("已清除项目目录；请重新选择一个项目目录");
    } catch (error) {
      setNotice(`清除项目目录失败：${String(error)}`);
    }
  }

  async function handleSaveProvider(draft: ProviderDraft): Promise<boolean> {
    try {
      const saved = await saveProvider(draft);
      setProviders(await listProviders());
      setNotice(`${saved.name} 已保存；API Key 保存在本机 ~/.sion/providers.json，不会回显`);
      return true;
    } catch (error) {
      setNotice(`保存模型配置失败：${String(error)}`);
      return false;
    }
  }

  async function handleSetDefaultProvider(providerId: string): Promise<boolean> {
    try {
      await setDefaultProvider(providerId);
      setProviders(await listProviders());
      setNotice("已设为默认提供商");
      return true;
    } catch (error) {
      setNotice(`设置默认提供商失败：${String(error)}`);
      return false;
    }
  }

  async function handleDeleteProvider(providerId: string): Promise<boolean> {
    try {
      await deleteProvider(providerId);
      setProviders(await listProviders());
      setNotice("已删除本地模型配置；providers.json 中的 API Key 已一并删除");
      return true;
    } catch (error) {
      setNotice(`删除模型配置失败：${String(error)}`);
      return false;
    }
  }

  async function loadRuns(projectId: string) {
    try {
      setRuns(await listRuns(projectId));
    } catch (error) {
      setNotice(`读取任务中心失败：${String(error)}`);
    }
  }

  async function createProjectFromForm(name: string, customer: string, author: string): Promise<boolean> {
    setCreating(true);
    setNotice("正在创建本地项目");
    try {
      const response = await createProject(crypto.randomUUID(), name.trim() || "未命名项目", customer.trim(), author.trim(), now());
      if (!response.created || !response.project) throw new Error("项目创建未完成");
      const registry = await loadProjects();
      const created = registry.find((item) => item.id === response.project!.id);
      setNotice(`已创建 ${response.project.name}`);
      if (created) openProject(created);
      return true;
    } catch (error) {
      setNotice(`创建项目失败：${String(error)}`);
      return false;
    } finally {
      setCreating(false);
    }
  }

  async function revealProjectInFileManager(projectId: string) {
    try {
      const result = await revealProject(projectId);
      setNotice(result.revealed ? "已在文件管理器中显示项目" : "未能在文件管理器中显示项目");
    } catch (error) {
      setNotice(`显示项目位置失败：${String(error)}`);
    }
  }

  function openProject(item: RecentProject) {
    setDeliveryPreview(null);
    setSelectedFileIds([]);
    setFilePreview(null);
    const existing = ui.projects[item.id];
    const nextProjectUi = existing?.initialized ? existing : initialProjectUi();
    updateUi({ ...ui, projects: { ...ui.projects, [item.id]: nextProjectUi } });
    setProject(item);
    setDestination("workspace");
  }

  async function loadNode(projectId: string, nextNodeId: NodeId) {
    setNotice(`正在读取 ${NODES.find(([id]) => id === nextNodeId)?.[1] ?? "节点"}`);
    try {
      const loaded = await getNode(projectId, nextNodeId);
      setNode(loaded);
      setDraft(loaded.markdown);
      setNotice(`节点 revision ${loaded.revision} 已从本地项目读取`);
    } catch (error) {
      setNode(null);
      setNotice(`读取节点失败：${String(error)}`);
    }
  }

  async function loadAgentOverride(projectId: string, nextNodeId: NodeId) {
    setAgentOverride(null);
    try {
      const response = await getAgentOverride(projectId, nextNodeId);
      setAgentOverride(response.markdown ?? null);
    } catch (error) {
      setNotice(`读取节点自定义规则失败：${String(error)}`);
    }
  }

  function openAgentOverride() {
    setAgentOverrideDraft(agentOverride ?? "");
    setAgentOverrideOpen(true);
  }

  async function saveAgentOverrideDraft() {
    if (!project) return;
    setSavingAgentOverride(true);
    try {
      const response = await saveAgentOverride(project.id, nodeId, agentOverrideDraft);
      setAgentOverride(response.markdown ?? null);
      setAgentOverrideOpen(false);
      setNotice(response.markdown ? "节点自定义规则已保存；它会追加到内置规则后" : "已清除节点自定义规则；Agent 将只使用内置规则");
    } catch (error) {
      setNotice(`保存节点自定义规则失败：${String(error)}`);
    } finally {
      setSavingAgentOverride(false);
    }
  }

  async function saveNodeDraft() {
    if (!project || !node) return;
    setSaving(true);
    try {
      const result = await saveNode(project.id, nodeId, node.revision, draft, node.status, now());
      if (result.conflict) {
        setNode(result.conflict.latest);
        setDraft(result.conflict.latest.markdown);
        setNotice("检测到另一次保存；已载入磁盘中的最新版本，没有覆盖它");
      } else if (result.saved) {
        setNode(result.saved);
        setDraft(result.saved.markdown);
        setNotice(`已原子保存 revision ${result.saved.revision}`);
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
      const preview = await previewAssistantDelivery(project.id, nodeId, sessionId, messageId);
      setDeliveryPreview(preview);
      openWorkspaceTab(`delivery-preview:${messageId}`);
      setNotice(`已生成修改预览：+${preview.additions} / -${preview.deletions} / ${preview.unchanged} 行保留`);
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
      const result = await applyAssistantApi(project.id, nodeId, sessionId, messageId, node.revision, now());
      if (result.conflict) {
        setNode(result.conflict.latest); setDraft(result.conflict.latest.markdown);
        setDeliveryPreview(null);
        closeWorkspaceTab(`delivery-preview:${messageId}`);
        setNotice("节点在确认前已被修改；已显示最新版本，未覆盖它");
      } else if (result.saved) {
        setNode(result.saved); setDraft(result.saved.markdown);
        setDeliveryPreview(null);
        closeWorkspaceTab(`delivery-preview:${messageId}`);
        setNotice(`已应用 Assistant 修改到节点 revision ${result.saved.revision}`);
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
      const loaded = await listSessions(projectId, nextNodeId);
      setSessions(loaded);
      setSessionId(loaded[0]?.id ?? null);
    } catch (error) {
      setSessions([]);
      setNotice(`读取会话失败：${String(error)}`);
    }
  }

  async function createSession(): Promise<ChatSession | null> {
    if (!project) return null;
    try {
      const session = await createSessionApi(project.id, nodeId, `会话 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, now());
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
      setMessages(await listMessages(projectId, nextNodeId, nextSessionId));
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
      await appendMessage(project.id, nodeId, active.id, message, now());
      setMessages((current) => [...current, message]);
      setSessions((current) => current.map((session) => session.id === active.id ? { ...session, messageCount: session.messageCount + 1, updatedAt: message.createdAt } : session));
      setMessageDraft("");
      try {
        const run = await startAgentRun(project.id, nodeId, active.id, selectedFileIds, now());
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
      await cancelAgentRun(project.id, activeRunId, now());
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
      const result = await exportDocxApi(project.id);
      setNotice(result.exported ? `DOCX 已导出到 ${result.path}` : "已取消 DOCX 导出");
    } catch (error) {
      setNotice(`DOCX 导出失败：${String(error)}`);
    } finally {
      setExporting(false);
    }
  }

  async function loadFiles(projectId: string) {
    try {
      setFiles(await listFiles(projectId));
    } catch (error) {
      setFiles([]);
      setNotice(`读取文件池失败：${String(error)}`);
    }
  }

  async function importFile() {
    if (!project) return;
    setImportingFile(true);
    try {
      const result = await importFileApi(project.id, now());
      if (!result.imported || !result.file) {
        setNotice("已取消文件选择，项目未改变");
        return;
      }
      setFiles((current) => [...current, result.file!]);
      openWorkspaceTab(`file:${result.file.id}`);
      void selectFilePreview(result.file!.id);
      setNotice(result.file.extractionStatus === "available" ? `已导入并提取 ${result.file.originalName}` : `已导入 ${result.file.originalName}；该格式尚未提取文本`);
    } catch (error) {
      setNotice(`导入文件失败：${String(error)}`);
    } finally {
      setImportingFile(false);
    }
  }

  function toggleFileContext(fileId: string) {
    setSelectedFileIds((current) => current.includes(fileId) ? current.filter((id) => id !== fileId) : [...current, fileId]);
  }

  async function selectFilePreview(fileId: string) {
    if (!project) return;
    try {
      setFilePreview(await getFilePreview(project.id, fileId));
    } catch (error) {
      setFilePreview(null);
      setNotice(`读取文件预览失败：${String(error)}`);
    }
  }

  function exitProject() {
    setDeliveryPreview(null);
    setFilePreview(null);
    selectDestination("projects");
  }

  function selectNode(id: NodeId) {
    if (!project) return;
    setDeliveryPreview(null);
    const current = ui.projects[project.id] ?? initialProjectUi();
    updateUi({ ...ui, projects: { ...ui.projects, [project.id]: openUiNode(current, id) } });
    setDestination("workspace");
  }

  function closeNode(id: NodeId) {
    if (!project) return;
    const current = ui.projects[project.id] ?? initialProjectUi();
    const next = closeUiNode(current, id);
    updateUi({ ...ui, projects: { ...ui.projects, [project.id]: next } });
    if (next.activeNodeId === null) {
      setNode(null);
      setDraft("");
    }
  }

  function updateActiveProjectUi(transform: (current: ReturnType<typeof initialProjectUi>) => ReturnType<typeof initialProjectUi>) {
    if (!project) return;
    const current = ui.projects[project.id] ?? initialProjectUi();
    updateUi({ ...ui, projects: { ...ui.projects, [project.id]: transform(current) } });
  }

  function openWorkspaceTab(tabId: RightTabId) {
    updateActiveProjectUi((current) => openUiRightTab(current, tabId));
  }

  function selectWorkspaceTab(tabId: RightTabId) {
    openWorkspaceTab(tabId);
    if (tabId.startsWith("file:")) void selectFilePreview(tabId.slice("file:".length));
  }

  function closeWorkspaceTab(tabId: RightTabId) {
    updateActiveProjectUi((current) => closeUiRightTab(current, tabId));
    if (tabId.startsWith("delivery-preview:")) setDeliveryPreview(null);
  }

  function closeWorkspacePane() {
    updateActiveProjectUi((current) => ({ ...current, tabsInitialized: true, rightTabIds: [], activeRightTabId: null }));
    setDeliveryPreview(null);
  }

  function setWorkspacePaneWidth(width: number) {
    updateActiveProjectUi((current) => ({ ...current, rightPaneWidth: width }));
  }

  function selectDestination(nextDestination: "projects" | "exports") {
    setDestination(nextDestination);
    updateUi({ ...ui, lastDestination: nextDestination });
  }

  function toggleSidebar() {
    updateUi({ ...ui, sidebarCollapsed: !ui.sidebarCollapsed });
  }

  function selectSession(nextSessionId: string) {
    setDeliveryPreview(null);
    setSessionId(nextSessionId);
  }

  const rightTabLabels = Object.fromEntries((projectUi?.rightTabIds ?? []).map((tabId) => {
    if (tabId === "delivery") return [tabId, "交付稿"];
    if (tabId === "files") return [tabId, "资料"];
    if (tabId.startsWith("file:")) return [tabId, files.find((file) => file.id === tabId.slice("file:".length))?.originalName ?? "文件预览"];
    return [tabId, "修改预览"];
  }));
  const activeWorkTab = activeRightTabId === "delivery" ? (
    <DeliveryTab node={node} nodeTitle={nodeTitle} markdown={draft} dirty={dirty} saving={saving} exporting={exporting} hasCustomRule={Boolean(agentOverride)} onMarkdown={setDraft} onSave={() => void saveNodeDraft()} onExport={() => void exportDocx()} onOpenRule={openAgentOverride} />
  ) : activeRightTabId === "files" ? (
    <ProjectFilesTab files={files} selectedFileIds={selectedFileIds} importing={importingFile} onImport={() => void importFile()} onToggleContext={toggleFileContext} onPreview={(fileId) => { openWorkspaceTab(`file:${fileId}`); void selectFilePreview(fileId); }} />
  ) : activeRightTabId?.startsWith("file:") ? (
    <FilePreviewTab file={files.find((file) => file.id === activeRightTabId.slice("file:".length)) ?? null} preview={filePreview?.file.id === activeRightTabId.slice("file:".length) ? filePreview : null} />
  ) : activeRightTabId?.startsWith("delivery-preview:") ? (
    <DeliveryPreviewTab preview={deliveryPreview} onCancel={() => closeWorkspaceTab(activeRightTabId)} onApply={(messageId) => void applyAssistant(messageId)} />
  ) : null;
  const workPane = projectUi ? (
    <WorkspaceTabs tabIds={projectUi.rightTabIds} activeTabId={activeRightTabId} paneWidth={projectUi.rightPaneWidth} labels={rightTabLabels} dirtyTabIds={dirty ? ["delivery"] : []} onSelect={selectWorkspaceTab} onClose={closeWorkspaceTab} onClosePane={closeWorkspacePane} onPaneWidth={setWorkspacePaneWidth}>{activeWorkTab}</WorkspaceTabs>
  ) : null;

  const pageContent = destination === "projects" || !project ? (
    <ProjectHome
      projects={projects}
      settings={settings}
      hasProvider={providers.length > 0}
      creating={creating}
      onCreate={createProjectFromForm}
      onOpen={openProject}
      onReveal={(projectId) => void revealProjectInFileManager(projectId)}
      onOpenSettings={() => setSettingsOpen(true)}
      notice={null}
    />
  ) : destination === "exports" ? (
    <EmptyState title="导出中心" description="导出任务将在后续迁移到这里；当前项目仍可从交付稿中导出。" />
  ) : (
    <ProjectWorkspace
      project={project}
      node={node}
      nodeTitle={nodeTitle}
      workPane={workPane}
      onBack={exitProject}
      onOpenMaterials={() => openWorkspaceTab("files")}
      onOpenDelivery={() => openWorkspaceTab("delivery")}
      sessions={sessions}
      sessionId={sessionId}
      onSelectSession={selectSession}
      onCreateSession={() => void createSession()}
      runs={runs}
      activeRunId={activeRunId}
      onCancelAgent={() => void cancelAgent()}
      messages={messages}
      previewingMessageId={previewingMessageId}
      onPreviewAssistant={(id) => void previewAssistant(id)}
      messageDraft={messageDraft}
      onMessageDraft={setMessageDraft}
      onSendMessage={() => void sendMessage()}
      sendingMessage={sendingMessage}
    />
  );

  return (
    <>
      <AppShell
        destination={destination}
        projects={projects}
        activeProject={project}
        ui={ui}
        dirty={dirty}
        notice={notice}
        onDismissNotice={dismissNotice}
        onDestination={selectDestination}
        onProject={openProject}
        onNode={selectNode}
        onCloseNode={closeNode}
        onToggleSidebar={toggleSidebar}
        onOpenSettings={() => setSettingsOpen(true)}
      >
        {pageContent}
      </AppShell>
      <AgentRuleDialog open={agentOverrideOpen} nodeTitle={nodeTitle} value={agentOverrideDraft} saving={savingAgentOverride} onChange={setAgentOverrideDraft} onClose={() => setAgentOverrideOpen(false)} onSave={() => void saveAgentOverrideDraft()} />
      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          providers={providers}
          onPickDirectory={chooseDefaultDirectory}
          onClearDirectory={resetDefaultDirectory}
          onSaveProvider={handleSaveProvider}
          onSetDefaultProvider={handleSetDefaultProvider}
          onDeleteProvider={handleDeleteProvider}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
