import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
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
  getAppVersion,
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
  saveAgentOverride,
  saveNode,
  saveProvider,
  setDefaultProvider,
  startAgentRun,
} from "./api";
import { LandingPage } from "./components/LandingPage";
import { ProviderManager } from "./components/ProviderManager";
import { SettingsDialog } from "./components/SettingsDialog";
import { Workbench } from "./components/Workbench";
import { NODES, type AgentFinishedEvent, type AgentRun, type AgentTokenEvent, type AppSettings, type AppVersion, type AssistantDeliveryPreview, type ChatMessage, type ChatSession, type FilePreview, type NodeId, type ProjectFile, type Provider, type ProviderDraft, type RecentProject, type WorkflowNode, type WorkbenchTab } from "./types";

const now = () => new Date().toISOString();

export function App() {
  const [version, setVersion] = useState<AppVersion | null>(null);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [project, setProject] = useState<RecentProject | null>(null);
  const [nodeId, setNodeId] = useState<NodeId>("basic-info");
  const [node, setNode] = useState<WorkflowNode | null>(null);
  const [draft, setDraft] = useState("");
  const [agentOverride, setAgentOverride] = useState<string | null>(null);
  const [agentOverrideDraft, setAgentOverrideDraft] = useState("");
  const [agentOverrideOpen, setAgentOverrideOpen] = useState(false);
  const [savingAgentOverride, setSavingAgentOverride] = useState(false);
  const [notice, setNotice] = useState("正在连接本机应用服务");
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
  const [settings, setSettings] = useState<AppSettings>({ projectsDirectory: null });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [exporting, setExporting] = useState(false);
  const [deliveryPreview, setDeliveryPreview] = useState<AssistantDeliveryPreview | null>(null);
  const [previewingMessageId, setPreviewingMessageId] = useState<string | null>(null);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("chat");
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [isFileDrawerOpen, setIsFileDrawerOpen] = useState(false);

  const nodeTitle = useMemo(() => NODES.find(([id]) => id === nodeId)?.[1] ?? "节点", [nodeId]);
  const dirty = node !== null && draft !== node.markdown;

  useEffect(() => {
    void Promise.all([loadVersion(), loadProjects(), loadProviders(), loadSettings()]);
  }, []);

  useEffect(() => {
    if (project) {
      void loadNode(project.id, nodeId);
      void loadAgentOverride(project.id, nodeId);
      void loadSessions(project.id, nodeId);
    }
  }, [project, nodeId]);

  useEffect(() => {
    if (project) void loadFiles(project.id);
  }, [project]);

  useEffect(() => {
    if (project) void loadRuns(project.id);
  }, [project]);

  useEffect(() => {
    if (project && sessionId) void loadMessages(project.id, nodeId, sessionId);
  }, [project, nodeId, sessionId]);

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

  async function loadVersion() {
    try {
      setVersion(await getAppVersion());
      setNotice("本机应用服务已就绪");
    } catch (error) {
      setNotice(`IPC 不可用：${String(error)}`);
    }
  }

  async function loadProjects() {
    try {
      const result = await getProjects();
      setProjects(result.projects);
      if (result.warnings.length > 0) setNotice(result.warnings[0]);
    } catch (error) {
      setNotice(`读取项目目录失败：${String(error)}`);
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
      setSettings(await getSettings());
    } catch (error) {
      setNotice(`读取应用设置失败：${String(error)}`);
    }
  }

  async function chooseDefaultDirectory() {
    try {
      const updated = await pickProjectsDirectory();
      setSettings(updated);
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
      setSettings(await clearProjectsDirectory());
      setProjects([]);
      setNotice("已清除项目目录；请重新选择一个项目目录");
    } catch (error) {
      setNotice(`清除项目目录失败：${String(error)}`);
    }
  }

  async function handleSaveProvider(draft: ProviderDraft) {
    try {
      const saved = await saveProvider(draft);
      setProviders(await listProviders());
      setNotice(`${saved.name} 已保存；API Key 保存在本机 ~/.sion/providers.json，不会回显`);
    } catch (error) {
      setNotice(`保存模型配置失败：${String(error)}`);
    }
  }

  async function handleSetDefaultProvider(providerId: string) {
    try {
      await setDefaultProvider(providerId);
      setProviders(await listProviders());
      setNotice("已设为默认提供商");
    } catch (error) {
      setNotice(`设置默认提供商失败：${String(error)}`);
    }
  }

  async function handleDeleteProvider(providerId: string) {
    try {
      await deleteProvider(providerId);
      setProviders(await listProviders());
      setNotice("已删除本地模型配置；providers.json 中的 API Key 已一并删除");
    } catch (error) {
      setNotice(`删除模型配置失败：${String(error)}`);
    }
  }

  async function loadRuns(projectId: string) {
    try {
      setRuns(await listRuns(projectId));
    } catch (error) {
      setNotice(`读取任务中心失败：${String(error)}`);
    }
  }

  async function createProjectFromForm(name: string, customer: string, author: string) {
    setCreating(true);
    setNotice("正在创建本地项目");
    try {
      const response = await createProject(crypto.randomUUID(), name.trim() || "未命名项目", customer.trim(), author.trim(), now());
      if (!response.created || !response.project) throw new Error("项目创建未完成");
      await loadProjects();
      setNotice(`已创建 ${response.project.name}`);
    } catch (error) {
      setNotice(`创建项目失败：${String(error)}`);
    } finally {
      setCreating(false);
    }
  }

  function openProject(item: RecentProject) {
    setDeliveryPreview(null);
    setSelectedFileIds([]);
    setFilePreview(null);
    setPreviewFileId(null);
    setProject(item);
    setNodeId("basic-info");
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
        setNotice("节点在确认前已被修改；已显示最新版本，未覆盖它");
      } else if (result.saved) {
        setNode(result.saved); setDraft(result.saved.markdown);
        setDeliveryPreview(null);
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
    setPreviewFileId(fileId);
    try {
      setFilePreview(await getFilePreview(project.id, fileId));
    } catch (error) {
      setFilePreview(null);
      setNotice(`读取文件预览失败：${String(error)}`);
    }
  }

  function toggleFileDrawer() {
    setIsFileDrawerOpen((current) => !current);
  }

  function exitProject() {
    setDeliveryPreview(null);
    setFilePreview(null);
    setPreviewFileId(null);
    setProject(null);
  }

  function selectNode(id: NodeId) {
    setDeliveryPreview(null);
    setNodeId(id);
  }

  function selectSession(nextSessionId: string) {
    setDeliveryPreview(null);
    setSessionId(nextSessionId);
  }

  if (!project) {
    return (
      <>
        <LandingPage
          projects={projects}
          providers={providers}
          settings={settings}
          creating={creating}
          onCreate={createProjectFromForm}
          onOpenProject={openProject}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenProviders={() => setProvidersOpen(true)}
          notice={notice}
          appVersion={version}
        />
        {settingsOpen ? (
          <SettingsDialog
            settings={settings}
            onPickDirectory={() => void chooseDefaultDirectory()}
            onClearDirectory={() => void resetDefaultDirectory()}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
        {providersOpen ? (
          <ProviderManager
            providers={providers}
            onSave={(draft) => void handleSaveProvider(draft)}
            onSetDefault={(id) => void handleSetDefaultProvider(id)}
            onDelete={(id) => void handleDeleteProvider(id)}
            onClose={() => setProvidersOpen(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <Workbench
      project={project}
      node={node}
      nodeTitle={nodeTitle}
      draft={draft}
      setDraft={setDraft}
      dirty={dirty}
      saving={saving}
      exporting={exporting}
      onExit={exitProject}
      onSave={() => void saveNodeDraft()}
      onExportDocx={() => void exportDocx()}
      onSelectNode={selectNode}
      tab={workbenchTab}
      onSelectTab={setWorkbenchTab}
      files={files}
      selectedFileIds={selectedFileIds}
      importingFile={importingFile}
      onImport={() => void importFile()}
      onToggleFile={toggleFileContext}
      preview={filePreview}
      onSelectPreview={(id) => void selectFilePreview(id)}
      isFileDrawerOpen={isFileDrawerOpen}
      onToggleFileDrawer={toggleFileDrawer}
      agentOverride={agentOverride}
      agentOverrideOpen={agentOverrideOpen}
      agentOverrideDraft={agentOverrideDraft}
      setAgentOverrideDraft={setAgentOverrideDraft}
      openAgentOverride={openAgentOverride}
      closeAgentOverride={() => setAgentOverrideOpen(false)}
      savingAgentOverride={savingAgentOverride}
      saveAgentOverride={() => void saveAgentOverrideDraft()}
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
      setMessageDraft={setMessageDraft}
      onSendMessage={() => void sendMessage()}
      sendingMessage={sendingMessage}
      notice={notice}
      deliveryPreview={deliveryPreview}
      onCloseDeliveryPreview={() => setDeliveryPreview(null)}
      onApplyAssistant={(id) => void applyAssistant(id)}
    />
  );
}
