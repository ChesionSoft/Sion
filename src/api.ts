// Typed wrappers around Tauri `invoke`. Every call sends the versioned request
// envelope `{ apiVersion: API_VERSION, ... }` and returns the validated payload.
// React components never call `invoke` directly; they use these wrappers so the
// IPC contract lives in one place. Event subscriptions (`listen`) stay in App.

import { invoke } from "@tauri-apps/api/core";
import {
  API_VERSION,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunStartOutcome,
  type AgentRunStartResult,
  type AppSettings,
  type ChatMessage,
  type ChatModelSelection,
  type ChatSession,
  type ConversationTurn,
  type ConversationContextSnapshot,
  type DeliveryGeneration,
  type EffectiveAgentRules,
  type ExportAction,
  type ExportArtifactContent,
  type ExportArtifactKind,
  type ExportCommandError,
  type ExportCommandOutcome,
  type ExportSaveAsResult,
  type ExportWorkspaceSnapshot,
  type FilePreview,
  type NodeId,
  type NodeStatus,
  type ProjectFile,
  type ProjectManifest,
  type Provider,
  type ProviderDraft,
  type RecentProject,
  type SaveNodeResult,
  type VersionedResponse,
  type WorkflowNode,
  type UiSettings,
} from "./types";
import { durableUiSettings } from "./ui-state.ts";

const invokePayload = async <T>(
  command: string,
  request: Record<string, unknown>,
): Promise<T> => {
  const response = await invoke<VersionedResponse<T>>(command, {
    request: { apiVersion: API_VERSION, ...request },
  });
  if (response.apiVersion !== API_VERSION) {
    throw new Error(`Unsupported response version: ${response.apiVersion}`);
  }
  // Rust flattens the payload alongside `apiVersion`; strip the envelope.
  const { apiVersion: _apiVersion, ...payload } = response;
  return payload as T;
};

/** Force-quit the desktop process (bypasses window destroy ACL edge cases). */
export const exitApp = () => invoke<void>("app_exit");

export const getSettings = () => invokePayload<AppSettings>("settings_get", {});
export const pickProjectsDirectory = () =>
  invokePayload<AppSettings>("settings_pick_projects_directory", {});
export const clearProjectsDirectory = () =>
  invokePayload<AppSettings>("settings_clear_projects_directory", {});
export const saveUiSettings = (ui: UiSettings) =>
  invokePayload<AppSettings>("settings_save_ui", { ui: durableUiSettings(ui) });

export const getProjects = () =>
  invokePayload<{ projects: RecentProject[]; warnings: string[] }>("project_list", {});
export const revealProject = (projectId: string) =>
  invokePayload<{ revealed: boolean }>("project_reveal", { projectId });
export const revealExportFolder = (projectId: string) =>
  invokePayload<{ revealed: boolean }>("export_folder_reveal", { projectId });
export const createProject = (
  id: string,
  name: string,
  customerName: string,
  authorName: string,
  now: string,
) =>
  invokePayload<{ created: boolean; project?: ProjectManifest }>("project_create", {
    id,
    name,
    customerName,
    authorName,
    now,
  });

export const getNode = (projectId: string, nodeId: NodeId) =>
  invokePayload<WorkflowNode>("project_get_node", { projectId, nodeId });
export const getAgentOverride = (projectId: string, nodeId: NodeId) =>
  invokePayload<{ markdown?: string }>("project_get_agent_override", { projectId, nodeId });
export const getAgentRules = (projectId: string, nodeId: NodeId) =>
  invokePayload<EffectiveAgentRules>("project_get_agent_rules", { projectId, nodeId });
export const saveAgentOverride = (projectId: string, nodeId: NodeId, markdown: string) =>
  invokePayload<{ markdown?: string }>("project_save_agent_override", {
    projectId,
    nodeId,
    markdown,
  });
export const saveNode = (
  projectId: string,
  nodeId: NodeId,
  expectedRevision: number,
  markdown: string,
  status: NodeStatus,
  now: string,
) =>
  invokePayload<SaveNodeResult>("project_save_node", {
    projectId,
    nodeId,
    expectedRevision,
    markdown,
    status,
    now,
  });

export const listSessions = async (projectId: string, nodeId: NodeId): Promise<ChatSession[]> =>
  (await invokePayload<{ sessions: ChatSession[] }>("session_list", { projectId, nodeId })).sessions;
export const createSession = (
  projectId: string,
  nodeId: NodeId,
  name: string,
  now: string,
  modelSelection?: ChatModelSelection,
) =>
  invokePayload<ChatSession>("session_create", { projectId, nodeId, name, modelSelection, now });
export const updateSessionModel = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  modelSelection: ChatModelSelection,
  now: string,
) =>
  invokePayload<ChatSession>("session_model_update", {
    projectId,
    nodeId,
    sessionId,
    modelSelection,
    now,
  });
export const deleteSession = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
) =>
  invokePayload<void>("session_delete", { projectId, nodeId, sessionId });
export const getConversationContext = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  modelSelection: ChatModelSelection,
  fileIds: string[],
  now: string,
) =>
  invokePayload<ConversationContextSnapshot>("conversation_context_get", {
    projectId,
    nodeId,
    sessionId,
    modelSelection,
    fileIds,
    now,
  });
export const listMessages = async (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
): Promise<ChatMessage[]> =>
  (
    await invokePayload<{ messages: ChatMessage[] }>("message_list", {
      projectId,
      nodeId,
      sessionId,
    })
  ).messages;
export const appendMessage = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  message: ChatMessage,
  now: string,
) =>
  invokePayload<ChatSession>("message_append", { projectId, nodeId, sessionId, message, now });

export const listFiles = async (projectId: string): Promise<ProjectFile[]> =>
  (await invokePayload<{ files: ProjectFile[] }>("file_list", { projectId })).files;
export const importFile = (projectId: string, now: string) =>
  invokePayload<{ imported: boolean; file?: ProjectFile }>("file_import", { projectId, now });
export const getFilePreview = (projectId: string, fileId: string) =>
  invokePayload<FilePreview>("file_preview", { projectId, fileId });

export const listProviders = async (): Promise<Provider[]> =>
  (await invokePayload<{ providers: Provider[] }>("provider_list", {})).providers;
export const saveProvider = (draft: ProviderDraft) =>
  invokePayload<Provider>("provider_save", {
    id: draft.id,
    name: draft.name,
    apiBaseUrl: draft.apiBaseUrl,
    apiUrlMode: draft.apiUrlMode,
    protocol: draft.protocol,
    models: draft.models,
    isDefault: draft.isDefault,
    apiKey: draft.apiKey,
    now: draft.now,
  });
export const setDefaultProvider = (providerId: string) =>
  invokePayload<Provider>("provider_set_default", { providerId });
export const deleteProvider = (providerId: string) =>
  invokePayload<void>("provider_delete", { providerId });

export const startAgentRun = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  message: string,
  fileIds: string[],
  expectedRevision: number,
  deliveryWriteAllowed: boolean,
  now: string,
) =>
  invokePayload<AgentRunStartOutcome>("agent_run_start", {
    projectId,
    nodeId,
    sessionId,
    message,
    fileIds,
    expectedRevision,
    deliveryWriteAllowed,
    now,
  });

export const listConversationTurns = async (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  now: string,
): Promise<ConversationTurn[]> =>
  (
    await invokePayload<{ turns: ConversationTurn[] }>("conversation_turn_list", {
      projectId,
      nodeId,
      sessionId,
      now,
    })
  ).turns;

export const retryConversationTurnDelivery = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  turnId: string,
  now: string,
) =>
  invokePayload<AgentRunStartResult>("conversation_turn_retry_delivery", {
    projectId,
    nodeId,
    sessionId,
    turnId,
    now,
  });

export const startDeliveryRegeneration = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  generationId: string,
  fileIds: string[],
  expectedRevision: number,
  now: string,
) =>
  invokePayload<DeliveryGeneration>("delivery_regeneration_start", {
    projectId,
    nodeId,
    sessionId,
    generationId,
    fileIds,
    expectedRevision,
    now,
  });

export const cancelDeliveryRegeneration = (
  projectId: string,
  generationId: string,
  now: string,
) =>
  invokePayload<DeliveryGeneration>("delivery_regeneration_cancel", {
    projectId,
    generationId,
    now,
  });
export const listRuns = async (projectId: string): Promise<AgentRun[]> =>
  (await invokePayload<{ runs: AgentRun[] }>("agent_run_list", { projectId })).runs;
export const getAgentRunDetail = (projectId: string, runId: string) =>
  invokePayload<AgentRunDetail>("agent_run_detail", { projectId, runId });
export const cancelAgentRun = (projectId: string, runId: string, now: string) =>
  invokePayload<AgentRun>("agent_run_cancel", { projectId, runId, now });

// --- Export center ----------------------------------------------------------

/**
 * Typed export error. Export domain failures travel inside a successful
 * versioned IPC envelope as `ExportCommandOutcome::Error`, so the frontend
 * unwraps a typed error instead of parsing an `ApiError` string.
 */
export class ExportClientError extends Error {
  constructor(readonly detail: ExportCommandError) {
    super(detail.message);
    this.name = "ExportClientError";
  }
}

const invokeExportPayload = async <T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> => {
  const outcome = await invokePayload<ExportCommandOutcome<T>>(command, args);
  if (outcome.outcome === "error") {
    throw new ExportClientError(outcome.error);
  }
  return outcome.value;
};

export const getExportWorkspace = (projectId: string) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_workspace_get", { projectId });

export const saveExportModelSelection = (
  projectId: string,
  modelSelection: ChatModelSelection,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_model_selection_save", {
    projectId,
    modelSelection,
    now,
  });

export const getExportArtifact = (
  projectId: string,
  artifactKind: ExportArtifactKind,
  view: "preview" | "source",
) =>
  invokeExportPayload<ExportArtifactContent>("export_artifact_get", {
    projectId,
    artifactKind,
    view,
  });

export const saveExportArtifact = (
  projectId: string,
  artifactKind: ExportArtifactKind,
  expectedRevision: number,
  expectedDigest: string,
  markdown: string,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_artifact_save", {
    projectId,
    artifactKind,
    expectedRevision,
    expectedDigest,
    markdown,
    now,
  });

export const approveExportArtifact = (
  projectId: string,
  artifactKind: ExportArtifactKind,
  expectedRevision: number,
  expectedDigest: string,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_artifact_approve", {
    projectId,
    artifactKind,
    expectedRevision,
    expectedDigest,
    now,
  });

export const applyExportCandidate = (
  projectId: string,
  candidateId: string,
  expectedRevision: number,
  expectedDigest: string,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_candidate_apply", {
    projectId,
    candidateId,
    expectedRevision,
    expectedDigest,
    now,
  });

export const discardExportCandidate = (
  projectId: string,
  candidateId: string,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_candidate_discard", {
    projectId,
    candidateId,
    now,
  });

export const applyExportReview = (
  projectId: string,
  taskId: string,
  selectedChangeIds: string[],
  expectedRevision: number,
  expectedDigest: string,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_review_apply", {
    projectId,
    taskId,
    selectedChangeIds,
    expectedRevision,
    expectedDigest,
    now,
  });

export const exportDocxSaveAs = (projectId: string) =>
  invokeExportPayload<ExportSaveAsResult>("export_docx_save_as", { projectId });

export const startExportAction = (
  projectId: string,
  action: ExportAction,
  modelSelection: ChatModelSelection | null,
  expectedRevision: number | null,
  expectedDigest: string | null,
  acknowledgeSourceWarnings: boolean,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_action_start", {
    projectId,
    action,
    modelSelection,
    expectedRevision,
    expectedDigest,
    acknowledgeSourceWarnings,
    now,
  });

export const cancelExportAction = (projectId: string, runId: string, now: string) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_action_cancel", {
    projectId,
    runId,
    now,
  });

export const startExportReview = (
  projectId: string,
  artifactKind: ExportArtifactKind,
  instruction: string,
  expectedRevision: number,
  expectedDigest: string,
  modelSelection: ChatModelSelection,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>("export_review_start", {
    projectId,
    artifactKind,
    instruction,
    expectedRevision,
    expectedDigest,
    modelSelection,
    now,
  });
