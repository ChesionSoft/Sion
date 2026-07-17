// Typed wrappers around Tauri `invoke`. Every call sends the versioned request
// envelope `{ apiVersion: API_VERSION, ... }` and returns the validated payload.
// React components never call `invoke` directly; they use these wrappers so the
// IPC contract lives in one place. Event subscriptions (`listen`) stay in App.

import { invoke } from "@tauri-apps/api/core";
import {
  API_VERSION,
  type AgentRun,
  type AppSettings,
  type AssistantDeliveryPreview,
  type ChatMessage,
  type ChatSession,
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
export const previewAssistantDelivery = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  assistantMessageId: string,
) =>
  invokePayload<AssistantDeliveryPreview>("project_preview_assistant_delivery", {
    projectId,
    nodeId,
    sessionId,
    assistantMessageId,
  });
export const applyAssistant = (
  projectId: string,
  nodeId: NodeId,
  sessionId: string,
  assistantMessageId: string,
  expectedRevision: number,
  now: string,
) =>
  invokePayload<SaveNodeResult>("project_apply_assistant", {
    projectId,
    nodeId,
    sessionId,
    assistantMessageId,
    expectedRevision,
    now,
  });
export const exportDocx = (projectId: string) =>
  invokePayload<{ exported: boolean; path?: string }>("project_export_docx", { projectId });

export const listSessions = async (projectId: string, nodeId: NodeId): Promise<ChatSession[]> =>
  (await invokePayload<{ sessions: ChatSession[] }>("session_list", { projectId, nodeId })).sessions;
export const createSession = (projectId: string, nodeId: NodeId, name: string, now: string) =>
  invokePayload<ChatSession>("session_create", { projectId, nodeId, name, now });
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
    models: [{ name: draft.model, isDefault: true, toolCalling: false }],
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
  fileIds: string[],
  now: string,
) =>
  invokePayload<AgentRun>("agent_run_start", { projectId, nodeId, sessionId, fileIds, now });
export const listRuns = async (projectId: string): Promise<AgentRun[]> =>
  (await invokePayload<{ runs: AgentRun[] }>("agent_run_list", { projectId })).runs;
export const cancelAgentRun = (projectId: string, runId: string, now: string) =>
  invokePayload<AgentRun>("agent_run_cancel", { projectId, runId, now });
