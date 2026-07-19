import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelAgentRun,
  cancelDeliveryRegeneration,
  clearProjectsDirectory,
  createProject,
  createSession as createSessionApi,
  deleteProvider,
  getConversationContext,
  getAgentRunDetail,
  deleteSession as deleteSessionApi,
  getAgentRules,
  getFilePreview,
  getNode,
  getProjects,
  getSettings,
  importFile as importFileApi,
  listConversationTurns,
  listFiles,
  listMessages,
  listProviders,
  listRuns,
  listSessions,
  pickProjectsDirectory,
  revealProject,
  retryConversationTurnDelivery,
  saveAgentOverride,
  saveNode,
  saveProvider,
  saveUiSettings,
  setDefaultProvider,
  startAgentRun,
  startDeliveryRegeneration,
  updateSessionModel,
} from "./api";
import { AppShell } from "./components/app/AppShell";
import { DirtyNavigationDialog } from "./components/app/DirtyNavigationDialog";
import { ExportCenter } from "./components/app/ExportCenter";
import { ProjectHome } from "./components/app/ProjectHome";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ProjectWorkspace } from "./components/workspace/ProjectWorkspace";
import { RevisionConflictDialog } from "./components/workspace/RevisionConflictDialog";
import { AgentRulesWorkspace } from "./components/workspace/AgentRulesWorkspace";
import { DeliveryWorkspace } from "./components/workspace/DeliveryWorkspace";
import { FilePreviewTab } from "./components/workspace/FilePreviewTab";
import { FilePoolWorkspace } from "./components/workspace/FilePoolWorkspace";
import { RightWorkspacePane } from "./components/workspace/RightWorkspacePane";
import { RunDetailDialog } from "./components/workspace/RunDetailDialog";
import { NODES, type AgentFinishedEvent, type AgentReasoningSummaryEvent, type AgentRun, type AgentRunDetail, type AgentTokenEvent, type AppSettings, type ChatMessage, type ChatModelSelection, type ChatSession, type ConversationContextSnapshot, type DeliveryGeneration, type DeliveryGenerationTokenEvent, type DeliveryGenerationFinishedEvent, type ConversationTurn, type ConversationTurnEvent, type EffectiveAgentRules, type ExportRunEvent, type ExportWorkspaceInvalidatedEvent, type FilePreview, type MainDestination, type NodeId, type NoticeMessage, type ProjectFile, type Provider, type ProviderDraft, type RecentProject, type RightSurface, type UiSettings, type WorkflowNode, type WorkspaceView } from "./types";
import { activeRunIdForContext, createSerialTaskQueue, durableUiSettings, initialProjectUi, initialUiSettings, initialWorkspaceView, isAgentRulesDirty, isLatestRequest, requestNavigationDecision, requestScope, resolveNavigationDecision, sanitizeUiSettings, selectNode, shouldChangeNode, shouldChangeProject, type NavigationIntent, type SaveResult } from "./ui-state.ts";

import { conversationCanSend, defaultModelSelection } from "./conversation-controls";
import { mergeTurnSnapshot } from "./conversation-turns.ts";
import { isCurrentGenerationEvent, reconcileGeneratedNode, reconcileSavedNode } from "./delivery-generation.ts";
import { appendLiveReasoning, clearLiveReasoning, removeLiveReasoning, type LiveReasoningByRun } from "./reasoning-stream.ts";

const now = () => new Date().toISOString();
const contextSectionLabel: Record<string, string> = {
  protocol: "协议提示",
  rules: "Agent 规则",
  node_markdown: "节点文稿",
  conversation: "会话历史",
  attachment: "本轮资料",
};

export function App() {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [project, setProject] = useState<RecentProject | null>(null);
  const [node, setNode] = useState<WorkflowNode | null>(null);
  const [draft, setDraft] = useState("");
  const [agentOverrideDraft, setAgentOverrideDraft] = useState("");
  const [savingAgentOverride, setSavingAgentOverride] = useState(false);
  const [workspaceView, setWorkspaceView] = useState(initialWorkspaceView);
  const [agentRules, setAgentRules] = useState<EffectiveAgentRules | null>(null);
  const [loadingAgentRules, setLoadingAgentRules] = useState(false);
  const [notice, setNoticeState] = useState<NoticeMessage | null>({ id: "startup", kind: "warning", message: "正在连接本机应用服务", dismissAfterMs: null });
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [importingFile, setImportingFile] = useState(false);
  const [modelSelection, setModelSelection] = useState<ChatModelSelection | null>(null);
  const [savingModelSelection, setSavingModelSelection] = useState(false);
  const [conversationContext, setConversationContext] = useState<ConversationContextSnapshot | null>(null);
  const [loadingConversationContext, setLoadingConversationContext] = useState(false);
  const [conversationContextError, setConversationContextError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ projectsDirectory: null, ui: initialUiSettings() });
  const [ui, setUi] = useState<UiSettings>(initialUiSettings);
  const [destination, setDestination] = useState<MainDestination>("projects");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runDetailId, setRunDetailId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<AgentRunDetail | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);
  const [exportProjectId, setExportProjectId] = useState<string | null>(null);
  const [exportRefreshByProject, setExportRefreshByProject] = useState<Record<string, number>>({});
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [liveReasoningByRun, setLiveReasoningByRun] = useState<LiveReasoningByRun>({});
  const [generation, setGeneration] = useState<DeliveryGeneration | null>(null);
  const [generationCandidate, setGenerationCandidate] = useState<string>("");
  const [regenerating, setRegenerating] = useState(false);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<NavigationIntent | null>(null);
  const [conflictLatest, setConflictLatest] = useState<WorkflowNode | null>(null);
  const [uiHydrated, setUiHydrated] = useState(false);
  const uiPersistenceWarningShown = useRef(false);
  const skipNextUiPersistence = useRef(true);
  const uiRef = useRef<UiSettings>(initialUiSettings());
  const uiChangeGeneration = useRef(0);
  const uiPersistedGeneration = useRef(0);
  const uiSaveQueue = useRef(createSerialTaskQueue());
  const workspaceScopeRef = useRef<string | null>(null);
  const messageScopeRef = useRef<string | null>(null);
  const projectScopeRef = useRef<string | null>(null);
  const filePreviewScopeRef = useRef<string | null>(null);
  const sessionMutationScopeRef = useRef<string | null>(null);
  const messageMutationScopeRef = useRef<string | null>(null);
  const fileImportScopeRef = useRef<string | null>(null);
  const projectsRequestScopeRef = useRef<string | null>(null);
  const conversationContextScopeRef = useRef<string | null>(null);
  const runDetailScopeRef = useRef<string | null>(null);
  const nodeRef = useRef<WorkflowNode | null>(null);
  const draftRef = useRef("");
  const activeGenerationIdRef = useRef<string | null>(null);

  const projectUi = project ? ui.projects[project.id] : undefined;
  const activeNodeId = projectUi?.activeNodeId ?? null;
  const activeRightTabId = projectUi?.activeRightTabId ?? null;
  const nodeId: NodeId = activeNodeId ?? "basic-info";
  const nodeTitle = useMemo(() => NODES.find(([id]) => id === nodeId)?.[1] ?? "节点", [nodeId]);
  const markdownDirty = node !== null && draft !== node.markdown;
  const agentRulesDirty = agentRules !== null && isAgentRulesDirty(agentOverrideDraft, agentRules.customMarkdown);
  const dirty = markdownDirty || agentRulesDirty;
  const activeRunId = activeRunIdForContext(runs, project?.id ?? null, activeNodeId);
  const deliveryLocked = Boolean(activeRunId) || regenerating;
  const dismissNotice = useCallback(() => setNoticeState(null), []);
  workspaceScopeRef.current = requestScope(project?.id, activeNodeId);
  messageScopeRef.current = requestScope(project?.id, activeNodeId, sessionId);
  projectScopeRef.current = project?.id ?? null;
  uiRef.current = ui;
  nodeRef.current = node;
  draftRef.current = draft;

  function setNotice(message: string) {
    const kind = /失败|错误|不可用/.test(message) ? "error" : /正在|请先|未|取消|检测|暂/.test(message) ? "warning" : "success";
    setNoticeState({ id: crypto.randomUUID(), kind, message, dismissAfterMs: kind === "success" ? 4000 : null });
  }

  function updateUi(next: UiSettings) {
    const sanitized = sanitizeUiSettings(next);
    uiRef.current = sanitized;
    uiChangeGeneration.current += 1;
    setUi(sanitized);
    setSettings((current) => ({ ...current, ui: sanitized }));
  }

  function persistUiSnapshot(snapshot: UiSettings, generation: number, showWarning: boolean): Promise<boolean> {
    return uiSaveQueue.current(async () => {
      try {
        await saveUiSettings(durableUiSettings(snapshot));
        uiPersistedGeneration.current = Math.max(uiPersistedGeneration.current, generation);
        uiPersistenceWarningShown.current = false;
        return true;
      } catch (error) {
        if (showWarning && !uiPersistenceWarningShown.current) {
          uiPersistenceWarningShown.current = true;
          setNotice(`保存界面状态失败：${String(error)}`);
        }
        return false;
      }
    });
  }

  useEffect(() => {
    void Promise.all([loadProjects(), loadProviders(), loadSettings()]).finally(() => {
      // 首次加载完成。若没有任何错误/警告替换掉启动提示，就清除“正在连接本机应用服务”；
      // 否则保留那条更有信息量的通知。
      setNoticeState((current) => (current?.id === "startup" ? null : current));
    });
  }, []);

  useEffect(() => {
    if (!uiHydrated) return;
    if (skipNextUiPersistence.current) {
      skipNextUiPersistence.current = false;
      return;
    }
    const generation = uiChangeGeneration.current;
    const timer = window.setTimeout(() => {
      void persistUiSnapshot(ui, generation, true);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [ui, uiHydrated]);

  useEffect(() => {
    if (project && activeNodeId) {
      void loadNode(project.id, activeNodeId);
      void loadAgentRules(project.id, activeNodeId);
      void loadSessions(project.id, activeNodeId);
    } else if (project) {
      setNode(null);
      setDraft("");
      setSessions([]);
      setSessionId(null);
      setMessages([]);
      setTurns([]);
      setGeneration(null);
      setGenerationCandidate("");
      setRegenerating(false);
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
    runDetailScopeRef.current = null;
    setRunDetailId(null);
    setRunDetail(null);
    setRunDetailLoading(false);
    setRunDetailError(null);
  }, [project?.id]);

  useEffect(() => {
    if (project && activeNodeId && sessionId) {
      void loadMessages(project.id, activeNodeId, sessionId);
      void loadTurns(project.id, activeNodeId, sessionId);
    }
  }, [project, activeNodeId, sessionId]);

  useEffect(() => {
    activeGenerationIdRef.current = null;
  }, [project?.id, nodeId, sessionId]);

  useEffect(() => {
    setLiveReasoningByRun(clearLiveReasoning());
  }, [project?.id, nodeId, sessionId]);

  useEffect(() => {
    const subscriptions = Promise.all([
      listen<AgentTokenEvent>("agent-token", (event) => {
        const token = event.payload;
        if (!project || token.projectId !== project.id || token.nodeId !== nodeId || token.sessionId !== sessionId) return;
        setMessages((current) => {
          const transientId = `stream-${token.runId}`;
          const existing = current.find((message) => message.id === transientId);
          if (existing) return current.map((message) => message.id === transientId ? { ...message, content: message.content + token.delta } : message);
          return [...current, { id: transientId, role: "assistant", content: token.delta, createdAt: now() }];
        });
      }),
      listen<AgentReasoningSummaryEvent>("agent-reasoning-summary", (event) => {
        if (!project || !sessionId) return;
        setLiveReasoningByRun((current) => appendLiveReasoning(current, event.payload, {
          projectId: project.id,
          nodeId,
          sessionId,
        }));
      }),
      listen<AgentFinishedEvent>("agent-run-finished", (event) => {
        const run = event.payload.run;
        if (!project || run.projectId !== project.id || run.nodeId !== nodeId) return;
        setRuns((current) => current.map((item) => item.id === run.id ? run : item));
        setMessages((current) => current.filter((message) => message.id !== `stream-${run.id}`));
        setLiveReasoningByRun((current) => removeLiveReasoning(current, run.id));
        if (sessionId) void loadMessages(project.id, nodeId, sessionId);
        if (sessionId) void loadTurns(project.id, nodeId, sessionId);
        if (sessionId && modelSelection) {
          void loadConversationContext(project.id, nodeId, sessionId, modelSelection, selectedFileIds);
        }
        void loadRuns(project.id);
      }),
      listen<ConversationTurnEvent>("conversation-turn-updated", (event) => {
        const { turn, savedNode } = event.payload;
        if (!project || turn.projectId !== project.id || turn.nodeId !== nodeId) return;
        if (savedNode) {
          const reconciled = reconcileSavedNode(nodeRef.current, draftRef.current, savedNode);
          setNode(reconciled.node);
          setDraft(reconciled.draft);
        }
        if (sessionId && turn.sessionId !== sessionId) return;
        setTurns((current) => mergeTurnSnapshot(current, turn));
      }),
      listen<DeliveryGenerationTokenEvent>("delivery-generation-token", (event) => {
        const payload = event.payload;
        if (!project || payload.projectId !== project.id || payload.nodeId !== nodeId) return;
        if (activeGenerationIdRef.current !== payload.generationId) return;
        setGenerationCandidate((candidate) => candidate + payload.delta);
        setGeneration((current) => current?.id === payload.generationId
          ? { ...current, status: "running" }
          : current);
      }),
      listen<DeliveryGeneration>("delivery-generation-running", (event) => {
        const next = event.payload;
        if (!project || next.projectId !== project.id || next.nodeId !== nodeId) return;
        if (activeGenerationIdRef.current !== next.id) return;
        setGeneration(next);
      }),
      listen<DeliveryGenerationFinishedEvent>("delivery-generation-finished", (event) => {
        const payload = event.payload;
        if (!project || payload.generation.projectId !== project.id || payload.generation.nodeId !== nodeId) return;
        if (!isCurrentGenerationEvent(activeGenerationIdRef.current, payload.generation.id)) return;
        activeGenerationIdRef.current = null;
        setGeneration(payload.generation);
        setRegenerating(false);
        setGenerationCandidate("");
        const reconciled = reconcileGeneratedNode(
          nodeRef.current,
          draftRef.current,
          payload.generation,
          payload.savedNode,
        );
        setNode(reconciled.node);
        setDraft(reconciled.draft);
        if (sessionId && modelSelection) {
          void loadConversationContext(project.id, nodeId, sessionId, modelSelection, selectedFileIds);
        }
      }),
    ]);
    return () => { void subscriptions.then((unlisten) => unlisten.forEach((stop) => stop())); };
  }, [project, nodeId, sessionId, modelSelection, selectedFileIds]);

  // Export events are centralized here. Only terminal run updates and workspace
  // invalidations bump the project-scoped refresh token; model progress and
  // review status never produce a global notice.
  useEffect(() => {
    const subscriptions = Promise.all([
      listen<ExportWorkspaceInvalidatedEvent>("export-workspace-invalidated", (event) => {
        const projectId = event.payload.projectId;
        if (!projectId) return;
        setExportRefreshByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? 0) + 1 }));
      }),
      listen<ExportRunEvent>("export-run-updated", (event) => {
        const payload = event.payload;
        if (!payload.projectId) return;
        const terminal = payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled" || payload.status === "interrupted";
        if (!terminal) return;
        setExportRefreshByProject((current) => ({ ...current, [payload.projectId]: (current[payload.projectId] ?? 0) + 1 }));
      }),
    ]);
    return () => { void subscriptions.then((unlisten) => unlisten.forEach((stop) => stop())); };
  }, []);

  useEffect(() => {
    function saveWithShortcut(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "s" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (!event.repeat && project && node && markdownDirty && !saving && !deliveryLocked) void saveNodeDraft();
    }
    window.addEventListener("keydown", saveWithShortcut);
    return () => window.removeEventListener("keydown", saveWithShortcut);
  }, [project, node, draft, markdownDirty, saving, deliveryLocked]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      void getCurrentWindow().onCloseRequested((event) => {
        const pendingUiSave = uiHydrated && uiPersistedGeneration.current < uiChangeGeneration.current;
        if (!dirty && !pendingUiSave) return;
        event.preventDefault();
        if (dirty) requestNavigation({ kind: "close-window" });
        else void closeWindowSafely();
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch(() => {
        // The Vite browser preview has no native window; Tauri desktop does.
      });
    } catch {
      // getCurrentWindow itself throws outside the Tauri webview.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dirty, uiHydrated]);

  async function loadProjects(): Promise<RecentProject[]> {
    const scope = requestScope("projects", crypto.randomUUID());
    projectsRequestScopeRef.current = scope;
    try {
      const result = await getProjects();
      if (!isLatestRequest(scope, projectsRequestScopeRef.current)) return [];
      setProjects(result.projects);
      setExportProjectId((current) => result.projects.some((item) => item.id === current) ? current : result.projects[0]?.id ?? null);
      if (result.warnings.length > 0) setNotice(result.warnings[0]);
      return result.projects;
    } catch (error) {
      if (!isLatestRequest(scope, projectsRequestScopeRef.current)) return [];
      setProjects([]);
      setExportProjectId(null);
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
      const loadedUi = durableUiSettings(loaded.ui);
      uiRef.current = loadedUi;
      setSettings({ ...loaded, ui: loadedUi });
      setUi(loadedUi);
      setDestination(loadedUi.lastDestination);
      setUiHydrated(true);
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
      projectsRequestScopeRef.current = null;
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
    if (projectScopeRef.current === projectId) {
      setRuns([]);
      setRunsError(null);
    }
    try {
      const loaded = await listRuns(projectId);
      if (projectScopeRef.current !== projectId) return;
      setRuns(loaded);
    } catch (error) {
      if (projectScopeRef.current !== projectId) return;
      const message = `读取运行记录失败：${String(error)}`;
      setRuns([]);
      setRunsError(message);
      setNotice(message);
    }
  }

  async function loadRunDetail(projectId: string, runId: string) {
    const scope = requestScope("run-detail", projectId, runId, crypto.randomUUID());
    runDetailScopeRef.current = scope;
    setRunDetailId(runId);
    setRunDetail(null);
    setRunDetailError(null);
    setRunDetailLoading(true);
    try {
      const loaded = await getAgentRunDetail(projectId, runId);
      if (!isLatestRequest(scope, runDetailScopeRef.current) || projectScopeRef.current !== projectId) return;
      setRunDetail(loaded);
    } catch (error) {
      if (!isLatestRequest(scope, runDetailScopeRef.current) || projectScopeRef.current !== projectId) return;
      setRunDetailError(`读取运行详情失败：${String(error)}`);
    } finally {
      if (isLatestRequest(scope, runDetailScopeRef.current) && projectScopeRef.current === projectId) {
        setRunDetailLoading(false);
      }
    }
  }

  function openRunDetail(runId: string) {
    if (!project) return;
    void loadRunDetail(project.id, runId);
  }

  function retryRunDetail() {
    if (!project || !runDetailId) return;
    void loadRunDetail(project.id, runDetailId);
  }

  function closeRunDetail() {
    runDetailScopeRef.current = null;
    setRunDetailId(null);
    setRunDetail(null);
    setRunDetailLoading(false);
    setRunDetailError(null);
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
      if (created) requestNavigation({ kind: "project", projectId: created.id });
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

  function openProjectImmediate(item: RecentProject) {
    const projectChanged = shouldChangeProject(project?.id ?? null, item.id);
    if (projectChanged) {
      sessionMutationScopeRef.current = null;
      messageMutationScopeRef.current = null;
      fileImportScopeRef.current = null;
      setSavingModelSelection(false);
      setSendingMessage(false);
      setImportingFile(false);
    }
    filePreviewScopeRef.current = null;
    setFilePreview(null);
    if (projectChanged) {
      setMessageDraft("");
      setSelectedFileIds([]);
      setFiles([]);
      setRuns([]);
      setRunsError(null);
      setSessionsError(null);
    }
    setTurns([]);
    setGeneration(null);
    setGenerationCandidate("");
    setRegenerating(false);
    setWorkspaceView(initialWorkspaceView());
    const existing = ui.projects[item.id];
    const nextProjectUi = existing?.initialized ? existing : initialProjectUi();
    if (projectChanged) {
      setNode(null);
      setDraft("");
    }
    projectScopeRef.current = item.id;
    workspaceScopeRef.current = requestScope(item.id, nextProjectUi.activeNodeId);
    messageScopeRef.current = null;
    updateUi({ ...ui, projects: { ...ui.projects, [item.id]: nextProjectUi } });
    setProject(item);
    setDestination("workspace");
  }

  async function loadNode(projectId: string, nextNodeId: NodeId) {
    const scope = requestScope(projectId, nextNodeId);
    setNotice(`正在读取 ${NODES.find(([id]) => id === nextNodeId)?.[1] ?? "节点"}`);
    try {
      const loaded = await getNode(projectId, nextNodeId);
      if (workspaceScopeRef.current !== scope) return;
      setNode(loaded);
      setDraft(loaded.markdown);
      setNotice(`节点 revision ${loaded.revision} 已从本地项目读取`);
    } catch (error) {
      if (workspaceScopeRef.current !== scope) return;
      setNode(null);
      setNotice(`读取节点失败：${String(error)}`);
    }
  }

  async function loadAgentRules(projectId: string, nextNodeId: NodeId) {
    const scope = requestScope(projectId, nextNodeId);
    setLoadingAgentRules(true);
    setAgentRules(null);
    try {
      const loaded = await getAgentRules(projectId, nextNodeId);
      if (workspaceScopeRef.current !== scope) return;
      setAgentRules(loaded);
      setAgentOverrideDraft(loaded.customMarkdown ?? "");
    } catch (error) {
      if (workspaceScopeRef.current !== scope) return;
      setNotice("读取 agent.md 失败：" + String(error));
    } finally {
      if (workspaceScopeRef.current === scope) setLoadingAgentRules(false);
    }
  }

  async function saveAgentOverrideDraft(): Promise<boolean> {
    if (!project) return false;
    const scope = requestScope(project.id, nodeId);
    setSavingAgentOverride(true);
    try {
      await saveAgentOverride(project.id, nodeId, agentOverrideDraft);
      if (!isLatestRequest(scope, workspaceScopeRef.current)) return false;
      setNotice(agentOverrideDraft.trim() ? "节点自定义规则已保存；它会追加到内置规则后" : "已清除节点自定义规则；Agent 将只使用内置规则");
      await loadAgentRules(project.id, nodeId);
      if (sessionId && modelSelection) {
        void loadConversationContext(project.id, nodeId, sessionId, modelSelection, selectedFileIds);
      }
      return isLatestRequest(scope, workspaceScopeRef.current);
    } catch (error) {
      if (!isLatestRequest(scope, workspaceScopeRef.current)) return false;
      setNotice(`保存节点自定义规则失败：${String(error)}`);
      return false;
    } finally {
      if (isLatestRequest(scope, workspaceScopeRef.current)) setSavingAgentOverride(false);
    }
  }

  async function saveNodeDraft(): Promise<SaveResult> {
    if (!project || !node || deliveryLocked) return "cancelled";
    if (node.id !== nodeId) return "failed";
    setSaving(true);
    try {
      const result = await saveNode(project.id, nodeId, node.revision, draft, node.status, now());
      if (result.conflict) {
        setConflictLatest(result.conflict.latest);
        setNotice("检测到另一次保存；你的草稿仍保留在编辑器中");
        return "conflict";
      } else if (result.saved) {
        setNode(result.saved);
        setDraft(result.saved.markdown);
        setConflictLatest(null);
        setNotice(`已原子保存 revision ${result.saved.revision}`);
        if (sessionId && modelSelection) {
          void loadConversationContext(project.id, nodeId, sessionId, modelSelection, selectedFileIds);
        }
        return "saved";
      }
      setNotice("保存失败：本机服务没有返回保存结果");
      return "failed";
    } catch (error) {
      setNotice(`保存失败：${String(error)}`);
      return "failed";
    } finally {
      setSaving(false);
    }
  }

  async function loadSessions(projectId: string, nextNodeId: NodeId) {
    const scope = requestScope(projectId, nextNodeId);
    setSessionsError(null);
    setSessions([]);
    setSessionId(null);
    setMessages([]);
    setTurns([]);
    setGeneration(null);
    setGenerationCandidate("");
    setRegenerating(false);
    try {
      const loaded = await listSessions(projectId, nextNodeId);
      if (workspaceScopeRef.current !== scope) return;
      setSessions(loaded);
      setSessionId(loaded[0]?.id ?? null);
    } catch (error) {
      if (workspaceScopeRef.current !== scope) return;
      setSessions([]);
      const message = `读取会话失败：${String(error)}`;
      setSessionsError(message);
      setNotice(message);
    }
  }

  async function createSession(): Promise<ChatSession | null> {
    if (!project) return null;
    const contextScope = requestScope(project.id, nodeId);
    const scope = requestScope(project.id, nodeId, "create-session", crypto.randomUUID());
    sessionMutationScopeRef.current = scope;
    try {
      const session = await createSessionApi(project.id, nodeId, `会话 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, now(), modelSelection ?? undefined);
      if (!isLatestRequest(scope, sessionMutationScopeRef.current) || !isLatestRequest(contextScope, workspaceScopeRef.current)) return null;
      setSessions((current) => [session, ...current]);
      setSessionId(session.id);
      setMessages([]);
      setNotice("已创建本地会话");
      return session;
    } catch (error) {
      if (!isLatestRequest(scope, sessionMutationScopeRef.current) || !isLatestRequest(contextScope, workspaceScopeRef.current)) return null;
      setNotice(`创建会话失败：${String(error)}`);
      return null;
    }
  }

  async function deleteSession(targetSessionId: string): Promise<void> {
    if (!project) return;
    const projectId = project.id;
    const targetNodeId = nodeId;
    const wasActive = sessionId === targetSessionId;
    try {
      await deleteSessionApi(projectId, targetNodeId, targetSessionId);
      if (project?.id !== projectId || nodeId !== targetNodeId) return;
      const remaining = sessions.filter((session) => session.id !== targetSessionId);
      setSessions(remaining);
      if (wasActive) {
        const nextSessionId = remaining[0]?.id ?? null;
        if (nextSessionId) {
          selectSession(nextSessionId);
        } else {
          sessionMutationScopeRef.current = null;
          messageMutationScopeRef.current = null;
          messageScopeRef.current = null;
          setSessionId(null);
          setMessages([]);
          setTurns([]);
          setGeneration(null);
          setGenerationCandidate("");
        }
      }
      setNotice("已删除会话");
    } catch (error) {
      if (project?.id !== projectId || nodeId !== targetNodeId) return;
      setNotice(`删除会话失败：${String(error)}`);
    }
  }

  async function loadMessages(projectId: string, nextNodeId: NodeId, nextSessionId: string) {
    const scope = requestScope(projectId, nextNodeId, nextSessionId);
    try {
      const loaded = await listMessages(projectId, nextNodeId, nextSessionId);
      if (messageScopeRef.current !== scope) return;
      setMessages(loaded);
    } catch (error) {
      if (messageScopeRef.current !== scope) return;
      setMessages([]);
      setNotice(`读取消息失败：${String(error)}`);
    }
  }

  async function loadTurns(projectId: string, nextNodeId: NodeId, nextSessionId: string) {
    const scope = requestScope(projectId, nextNodeId, nextSessionId);
    try {
      const next = await listConversationTurns(projectId, nextNodeId, nextSessionId, now());
      if (messageScopeRef.current !== scope) return;
      setTurns(next);
    } catch (error) {
      if (messageScopeRef.current !== scope) return;
      setNotice(`加载会话轮次失败：${String(error)}`);
    }
  }

  async function retryDelivery(turnId: string) {
    if (!project || !sessionId) return;
    setSavingModelSelection(true);
    try {
      const result = await retryConversationTurnDelivery(project.id, nodeId, sessionId, turnId, now());
      setRuns((current) => [result.run, ...current.filter((run) => run.id !== result.run.id)]);
      setTurns((current) => mergeTurnSnapshot(current, result.turn));
    } catch (error) {
      setNotice(`重新判断交付稿失败：${String(error)}`);
    } finally {
      setSavingModelSelection(false);
    }
  }

  async function startRegeneration() {
    if (!project || !node || !sessionId) return;
    const activeGenerationId = crypto.randomUUID();
    activeGenerationIdRef.current = activeGenerationId;
    setRegenerating(true);
    setGenerationCandidate("");
    try {
      const result = await startDeliveryRegeneration(project.id, nodeId, sessionId, activeGenerationId, selectedFileIds, node.revision, now());
      if (activeGenerationIdRef.current === activeGenerationId) setGeneration(result);
    } catch (error) {
      if (activeGenerationIdRef.current !== activeGenerationId) return;
      activeGenerationIdRef.current = null;
      setNotice(`重新生成交付稿失败：${String(error)}`);
      setRegenerating(false);
    }
  }

  async function cancelRegeneration() {
    if (!project || !generation) return;
    try {
      await cancelDeliveryRegeneration(project.id, generation.id, now());
    } catch (error) {
      setNotice(`取消重新生成失败：${String(error)}`);
    }
  }

  useEffect(() => {
    if (!project) { setModelSelection(null); return; }
    const active = sessionId ? sessions.find((item) => item.id === sessionId) ?? null : null;
    if (active?.modelSelection) setModelSelection(active.modelSelection);
    else setModelSelection(defaultModelSelection(providers));
  }, [project, sessionId, sessions, providers]);

  async function loadConversationContext(
    projectId: string,
    nextNodeId: NodeId,
    nextSessionId: string,
    selection: ChatModelSelection,
    fileIds: string[],
  ) {
    const scope = requestScope(
      projectId,
      nextNodeId,
      nextSessionId,
      selection.providerId,
      selection.model,
      selection.reasoningEffort,
      ...fileIds,
    );
    conversationContextScopeRef.current = scope;
    setLoadingConversationContext(true);
    setConversationContextError(null);
    try {
      const snapshot = await getConversationContext(
        projectId,
        nextNodeId,
        nextSessionId,
        selection,
        fileIds,
        now(),
      );
      if (conversationContextScopeRef.current !== scope) return;
      setConversationContext(snapshot);
    } catch (error) {
      if (conversationContextScopeRef.current !== scope) return;
      setConversationContextError(String(error));
    } finally {
      if (conversationContextScopeRef.current === scope) setLoadingConversationContext(false);
    }
  }

  useEffect(() => {
    if (!project || !sessionId || !modelSelection) {
      conversationContextScopeRef.current = null;
      setConversationContext(null);
      setLoadingConversationContext(false);
      setConversationContextError(null);
      return;
    }
    void loadConversationContext(project.id, nodeId, sessionId, modelSelection, selectedFileIds);
  }, [project, nodeId, sessionId, modelSelection, selectedFileIds]);

  async function changeModelSelection(selection: ChatModelSelection) {
    if (!project || !sessionId) { setModelSelection(selection); return; }
    const contextScope = requestScope(project.id, nodeId);
    const activeSessionId = sessionId;
    const scope = requestScope(project.id, nodeId, activeSessionId, "update-model", crypto.randomUUID());
    sessionMutationScopeRef.current = scope;
    setSavingModelSelection(true);
    try {
      const updated = await updateSessionModel(project.id, nodeId, activeSessionId, selection, now());
      if (!isLatestRequest(scope, sessionMutationScopeRef.current) || !isLatestRequest(contextScope, workspaceScopeRef.current)) return;
      setSessions((current) => current.map((item) => item.id === activeSessionId ? updated : item));
      setModelSelection(selection);
    } catch (error) {
      if (!isLatestRequest(scope, sessionMutationScopeRef.current) || !isLatestRequest(contextScope, workspaceScopeRef.current)) return;
      setNotice(`保存模型选择失败：${String(error)}`);
    } finally {
      if (isLatestRequest(scope, sessionMutationScopeRef.current) && isLatestRequest(contextScope, workspaceScopeRef.current)) setSavingModelSelection(false);
    }
  }

  async function sendMessage() {
    const content = messageDraft.trim();
    if (!project || !content || !conversationCanSend({
      nodeAvailable: Boolean(node),
      draft: content,
      selection: modelSelection,
      providers,
      savingSelection: savingModelSelection,
    })) return;
    const contextScope = requestScope(project.id, nodeId);
    const scope = requestScope(project.id, nodeId, sessionId ?? "new-session", "send-message", crypto.randomUUID());
    messageMutationScopeRef.current = scope;
    setSendingMessage(true);
    try {
      const active = sessionId ? sessions.find((session) => session.id === sessionId) ?? null : await createSession();
      if (!active || !isLatestRequest(scope, messageMutationScopeRef.current) || !isLatestRequest(contextScope, workspaceScopeRef.current)) return;
      const outcome = await startAgentRun(project.id, nodeId, active.id, content, selectedFileIds, node?.revision ?? 0, !markdownDirty, now());
      if (!isLatestRequest(scope, messageMutationScopeRef.current) || !isLatestRequest(contextScope, workspaceScopeRef.current)) return;
      if (outcome.kind === "context_blocked") {
        setConversationContext(outcome.snapshot);
        const largest = contextSectionLabel[outcome.largestSection] ?? outcome.largestSection;
        setNotice(`上下文超出模型窗口：超出 ${outcome.excessTokens} tokens，最大占用来自${largest}`);
        return;
      }
      const { run } = outcome;
      await loadMessages(project.id, nodeId, active.id);
      void loadTurns(project.id, nodeId, active.id);
      if (!isLatestRequest(scope, messageMutationScopeRef.current) || !isLatestRequest(contextScope, workspaceScopeRef.current)) return;
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setMessageDraft("");
      setSelectedFileIds([]);
    } catch {
      if (!isLatestRequest(scope, messageMutationScopeRef.current) || !isLatestRequest(contextScope, workspaceScopeRef.current)) return;
    } finally {
      if (isLatestRequest(scope, messageMutationScopeRef.current)) setSendingMessage(false);
    }
  }

  async function cancelAgent() {
    if (!project || !activeRunId) return;
    try {
      await cancelAgentRun(project.id, activeRunId, now());
      await loadRuns(project.id);
    } catch (error) {
      setNotice(`取消 Agent Run 失败：${String(error)}`);
    }
  }

  async function loadFiles(projectId: string) {
    try {
      const loaded = await listFiles(projectId);
      if (projectScopeRef.current !== projectId) return;
      setFiles(loaded);
    } catch (error) {
      if (projectScopeRef.current !== projectId) return;
      setFiles([]);
      setNotice(`读取文件池失败：${String(error)}`);
    }
  }

  async function importFile(): Promise<ProjectFile | null> {
    if (!project) return null;
    const contextScope = project.id;
    const scope = requestScope(project.id, "import-file", crypto.randomUUID());
    fileImportScopeRef.current = scope;
    setImportingFile(true);
    try {
      const result = await importFileApi(project.id, now());
      if (!isLatestRequest(scope, fileImportScopeRef.current) || projectScopeRef.current !== contextScope) return null;
      if (!result.imported || !result.file) {
        setNotice("已取消文件选择，项目未改变");
        return null;
      }
      setFiles((current) => [...current, result.file!]);
      setNotice(result.file.extractionStatus === "available"
        ? `已导入并提取 ${result.file.originalName}`
        : `已导入 ${result.file.originalName}；该格式尚未提取文本`);
      return result.file;
    } catch (error) {
      if (isLatestRequest(scope, fileImportScopeRef.current) && projectScopeRef.current === contextScope) {
        setNotice(`导入文件失败：${String(error)}`);
      }
      return null;
    } finally {
      if (isLatestRequest(scope, fileImportScopeRef.current)) setImportingFile(false);
    }
  }

  function toggleFileContext(fileId: string) {
    setSelectedFileIds((current) => current.includes(fileId) ? current.filter((id) => id !== fileId) : [...current, fileId]);
  }

  async function selectFilePreview(fileId: string) {
    if (!project) return;
    const scope = requestScope(project.id, fileId);
    filePreviewScopeRef.current = scope;
    setFilePreview(null);
    try {
      const preview = await getFilePreview(project.id, fileId);
      if (!isLatestRequest(scope, filePreviewScopeRef.current)) return;
      setFilePreview(preview);
    } catch (error) {
      if (!isLatestRequest(scope, filePreviewScopeRef.current)) return;
      setFilePreview(null);
      setNotice(`读取文件预览失败：${String(error)}`);
    }
  }

  function exitProject() {
    requestNavigation({ kind: "destination", destination: "projects" });
  }

  function exitProjectImmediate() {
    filePreviewScopeRef.current = null;
    setFilePreview(null);
    setTurns([]);
    setGeneration(null);
    setGenerationCandidate("");
    setRegenerating(false);
    selectDestinationImmediate("projects");
  }

  function selectNodeImmediate(id: NodeId) {
    if (!project) return;
    if (!shouldChangeNode(activeNodeId, id)) return;
    sessionMutationScopeRef.current = null;
    messageMutationScopeRef.current = null;
    fileImportScopeRef.current = null;
    setSavingModelSelection(false);
    setSendingMessage(false);
    setImportingFile(false);
    setMessageDraft("");
    setSelectedFileIds([]);
    filePreviewScopeRef.current = null;
    setNode(null);
    setDraft("");
    setFilePreview(null);
    setTurns([]);
    setGeneration(null);
    setGenerationCandidate("");
    setRegenerating(false);
    setWorkspaceView(initialWorkspaceView());
    const current = ui.projects[project.id] ?? initialProjectUi();
    workspaceScopeRef.current = requestScope(project.id, id);
    messageScopeRef.current = null;
    updateUi({ ...ui, projects: { ...ui.projects, [project.id]: selectNode(current, id) } });
    setDestination("workspace");
  }

  function updateActiveProjectUi(transform: (current: ReturnType<typeof initialProjectUi>) => ReturnType<typeof initialProjectUi>) {
    if (!project) return;
    const current = ui.projects[project.id] ?? initialProjectUi();
    updateUi({ ...ui, projects: { ...ui.projects, [project.id]: transform(current) } });
  }

  function setWorkspacePaneWidth(width: number) {
    updateActiveProjectUi((current) => ({ ...current, rightPaneWidth: width }));
  }

  function rightSurfaceTitle(surface: RightSurface): string {
    if (surface.kind === "delivery") return "交付稿";
    if (surface.kind === "agent-rules") return "agent.md";
    if (surface.kind === "file-pool") return "文件池";
    if (surface.kind === "file") {
      return files.find((file) => file.id === surface.fileId)?.originalName ?? "文件预览";
    }
    return "Assistant 修改预览";
  }

  function closeRightSurface() {
    const surface = workspaceView.rightSurface;
    const kind = surface?.kind;
    if (kind === "file-pool") {
      fileImportScopeRef.current = null;
      setImportingFile(false);
    }
    if (kind === "file") filePreviewScopeRef.current = null;
    const action = kind === "file" ? "file-pool" : kind;
    setWorkspaceView((current) => ({ ...current, rightSurface: null }));
    if (action) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(`[data-workspace-action="${action}"]`)?.focus();
      });
    }
  }

  function openRightSurface(nextSurface: RightSurface) {
    if (nextSurface.kind !== "file-pool") {
      fileImportScopeRef.current = null;
      setImportingFile(false);
    }
    filePreviewScopeRef.current = null;
    setWorkspaceView((current) => ({ ...current, rightSurface: nextSurface }));
  }

  function selectDestinationImmediate(nextDestination: "projects" | "exports") {
    fileImportScopeRef.current = null;
    setImportingFile(false);
    setDestination(nextDestination);
    // Always list-first for Export Center, including re-click while mid-workbench.
    if (nextDestination === "exports") {
      setExportProjectId(null);
    }
    updateUi({ ...ui, lastDestination: nextDestination });
  }

  function executeNavigation(intent: NavigationIntent) {
    if (intent.kind === "destination") {
      if (intent.destination === "projects") exitProjectImmediate();
      else selectDestinationImmediate(intent.destination);
      return;
    }
    if (intent.kind === "project") {
      const nextProject = projects.find((item) => item.id === intent.projectId);
      if (nextProject) openProjectImmediate(nextProject);
      return;
    }
    if (intent.kind === "node") {
      selectNodeImmediate(intent.nodeId);
      return;
    }
    void closeWindowSafely();
  }

  async function closeWindowSafely() {
    const generation = uiChangeGeneration.current;
    if (uiHydrated && uiPersistedGeneration.current < generation) {
      await persistUiSnapshot(uiRef.current, generation, false);
    }
    await getCurrentWindow().destroy();
  }

  function requestNavigation(intent: NavigationIntent) {
    const threatensDraft = intent.kind === "close-window"
      || (intent.kind === "project" && intent.projectId !== project?.id)
      || (intent.kind === "node" && intent.nodeId !== activeNodeId)
      || (intent.kind === "destination" && intent.destination !== destination);
    const decision = requestNavigationDecision(dirty && threatensDraft, intent);
    if (decision.pending) setPendingNavigation(decision.pending);
    if (decision.execute) executeNavigation(decision.execute);
  }

  function cancelPendingNavigation() {
    if (!pendingNavigation) return;
    const decision = resolveNavigationDecision(pendingNavigation, "cancel");
    setPendingNavigation(decision.pending);
  }

  function discardAndNavigate() {
    if (!pendingNavigation) return;
    const decision = resolveNavigationDecision(pendingNavigation, "discard");
    setDraft(node?.markdown ?? "");
    setAgentOverrideDraft(agentRules?.customMarkdown ?? "");
    setPendingNavigation(decision.pending);
    if (decision.execute) executeNavigation(decision.execute);
  }

  async function saveAndNavigate() {
    if (!pendingNavigation) return;
    const intent = pendingNavigation;
    if (markdownDirty) {
      const result = await saveNodeDraft();
      if (result !== "saved") return;
    }
    if (agentRulesDirty && !await saveAgentOverrideDraft()) return;
    setPendingNavigation(null);
    executeNavigation(intent);
  }

  function keepConflictedDraft() {
    setConflictLatest(null);
    setPendingNavigation(null);
  }

  function loadLatestAfterConflict() {
    if (!conflictLatest) return;
    const intent = pendingNavigation;
    setNode(conflictLatest);
    setDraft(conflictLatest.markdown);
    setConflictLatest(null);
    if (intent && agentRulesDirty) setPendingNavigation(intent);
    else {
      setPendingNavigation(null);
      if (intent) executeNavigation(intent);
    }
  }

  function toggleSidebar() {
    updateUi({ ...ui, sidebarCollapsed: !ui.sidebarCollapsed });
  }

  function selectSession(nextSessionId: string) {
    if (nextSessionId !== sessionId) {
      fileImportScopeRef.current = null;
      setImportingFile(false);
      setMessageDraft("");
      setSelectedFileIds([]);
    }
    sessionMutationScopeRef.current = null;
    messageMutationScopeRef.current = null;
    setSavingModelSelection(false);
    setSendingMessage(false);
    setTurns([]);
    setGeneration(null);
    setGenerationCandidate("");
    setRegenerating(false);
    messageScopeRef.current = requestScope(project?.id, activeNodeId, nextSessionId);
    setSessionId(nextSessionId);
  }

  const surface = workspaceView.rightSurface;
  const rightWorkContent = surface?.kind === "delivery" ? (
    <DeliveryWorkspace
      node={node}
      nodeTitle={nodeTitle}
      markdown={draft}
      view={workspaceView.deliveryView}
      dirty={markdownDirty}
      saving={saving}
      generation={generation}
      candidateLength={generationCandidate.length}
      canRegenerate={Boolean(node) && !markdownDirty && !Boolean(activeRunId) && Boolean(modelSelection) && Boolean(sessionId) && !regenerating}
      regenerating={regenerating}
      locked={deliveryLocked}
      onView={(deliveryView) => setWorkspaceView((current) => ({ ...current, deliveryView }))}
      onMarkdown={setDraft}
      onSave={() => void saveNodeDraft()}
      onRegenerate={() => void startRegeneration()}
      onCancelRegeneration={() => void cancelRegeneration()}
    />
  ) : surface?.kind === "agent-rules" ? (
    <AgentRulesWorkspace
      rules={agentRules}
      loading={loadingAgentRules}
      saving={savingAgentOverride}
      customDraft={agentOverrideDraft}
      onCustomDraft={setAgentOverrideDraft}
      onSave={() => void saveAgentOverrideDraft()}
      onRetry={() => { if (project && activeNodeId) void loadAgentRules(project.id, activeNodeId); }}
    />
  ) : surface?.kind === "file-pool" ? (
    <FilePoolWorkspace
      files={files}
      selectedFileIds={selectedFileIds}
      importing={importingFile}
      onImport={() => void importFile()}
      onToggleContext={toggleFileContext}
      onPreview={(fileId) => {
        setWorkspaceView((current) => ({ ...current, rightSurface: { kind: "file", fileId } }));
        void selectFilePreview(fileId);
      }}
    />
  ) : surface?.kind === "file" ? (
    <FilePreviewTab
      file={files.find((file) => file.id === surface.fileId) ?? null}
      preview={filePreview?.file.id === surface.fileId ? filePreview : null}
      onBack={() => {
        filePreviewScopeRef.current = null;
        setWorkspaceView((current) => ({ ...current, rightSurface: { kind: "file-pool" } }));
      }}
    />
  ) : null;
  const workPane = surface ? (
    <RightWorkspacePane
      title={rightSurfaceTitle(surface)}
      paneWidth={projectUi?.rightPaneWidth ?? 440}
      onClose={closeRightSurface}
      onPaneWidth={setWorkspacePaneWidth}
    >
      {rightWorkContent}
    </RightWorkspacePane>
  ) : null;

  const pageContent = destination === "projects" ? (
    <ProjectHome
      projects={projects}
      settings={settings}
      hasProvider={providers.length > 0}
      creating={creating}
      onCreate={createProjectFromForm}
      onOpen={(item) => requestNavigation({ kind: "project", projectId: item.id })}
      onReveal={(projectId) => void revealProjectInFileManager(projectId)}
      onOpenSettings={() => setSettingsOpen(true)}
      notice={null}
    />
  ) : destination === "exports" ? (
    <ExportCenter
      projects={projects}
      projectId={exportProjectId}
      projectsDirectory={settings.projectsDirectory}
      providers={providers}
      refreshToken={exportRefreshByProject[exportProjectId ?? ""] ?? 0}
      onOpenProject={setExportProjectId}
      onBackToList={() => setExportProjectId(null)}
      onOpenSettings={() => setSettingsOpen(true)}
      onGoToProjects={() => requestNavigation({ kind: "destination", destination: "projects" })}
      onNotice={setNotice}
    />
  ) : !project ? (
    <ProjectHome
      projects={projects}
      settings={settings}
      hasProvider={providers.length > 0}
      creating={creating}
      onCreate={createProjectFromForm}
      onOpen={(item) => requestNavigation({ kind: "project", projectId: item.id })}
      onReveal={(projectId) => void revealProjectInFileManager(projectId)}
      onOpenSettings={() => setSettingsOpen(true)}
      notice={null}
    />
  ) : (
    <ProjectWorkspace
      project={project}
      node={node}
      nodeTitle={nodeTitle}
      workPane={workPane}
      onBack={exitProject}
      rightSurface={workspaceView.rightSurface}
      onRightSurface={openRightSurface}
      sessions={sessions}
      sessionsError={sessionsError}
      sessionId={sessionId}
      onSelectSession={selectSession}
      onCreateSession={() => void createSession()}
      onDeleteSession={(id) => deleteSession(id)}
      runs={runs}
      runsError={runsError}
      activeRunId={activeRunId}
      onCancelAgent={() => void cancelAgent()}
      messages={messages}
      turns={turns}
      liveReasoningByRun={liveReasoningByRun}
      markdownDirty={markdownDirty}
      onRetryDelivery={(id) => void retryDelivery(id)}
      onOpenRunDetail={openRunDetail}
      messageDraft={messageDraft}
      onMessageDraft={setMessageDraft}
      onSendMessage={() => void sendMessage()}
      sendingMessage={sendingMessage}
      providers={providers}
      files={files}
      selectedFileIds={selectedFileIds}
      importingFile={importingFile}
      modelSelection={modelSelection}
      savingModelSelection={savingModelSelection}
      conversationContext={conversationContext}
      loadingConversationContext={loadingConversationContext}
      conversationContextError={conversationContextError}
      onModelSelection={changeModelSelection}
      onToggleFile={toggleFileContext}
      onImportFile={() => importFile()}
    />
  );

  return (
    <>
      <AppShell
        destination={destination}
        projects={projects}
        activeProject={project}
        ui={ui}
        notice={notice}
        onDismissNotice={dismissNotice}
        onDestination={(nextDestination) => requestNavigation({ kind: "destination", destination: nextDestination })}
        onProject={(item) => requestNavigation({ kind: "project", projectId: item.id })}
        onNode={(id) => requestNavigation({ kind: "node", nodeId: id })}
        onToggleSidebar={toggleSidebar}
        onOpenSettings={() => setSettingsOpen(true)}
      >
        {pageContent}
      </AppShell>
      <DirtyNavigationDialog
        open={pendingNavigation !== null && conflictLatest === null}
        saving={saving || savingAgentOverride}
        description={markdownDirty && agentRulesDirty
          ? "当前交付稿和 agent.md 自定义规则都包含未保存修改。"
          : agentRulesDirty
            ? "当前 agent.md 自定义规则包含未保存修改。"
            : "当前交付稿包含尚未写入项目目录的修改。"}
        onSave={() => void saveAndNavigate()}
        onDiscard={discardAndNavigate}
        onCancel={cancelPendingNavigation}
      />
      <RevisionConflictDialog latest={conflictLatest} onKeepDraft={keepConflictedDraft} onLoadLatest={loadLatestAfterConflict} />
      <RunDetailDialog
        open={runDetailId !== null}
        detail={runDetail}
        loading={runDetailLoading}
        error={runDetailError}
        onClose={closeRunDetail}
        onRetry={retryRunDetail}
      />
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
