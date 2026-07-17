// Shared frontend domain types and component prop contracts. This is the single
// source of truth for the wire shapes exchanged with the Rust command layer.

export const API_VERSION = 1;

export const NODES = [
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

export type NodeId = (typeof NODES)[number][0];
export type NodeStatus = "not_started" | "draft" | "generated" | "confirmed" | "needs_confirmation";
export type MainDestination = "projects" | "exports" | "workspace";
export type DurableRightTabId = "delivery" | "files" | `file:${string}`;
export type TransientRightTabId = `delivery-preview:${string}`;
export type RightTabId = DurableRightTabId | TransientRightTabId;

// Rust flattens the payload alongside `apiVersion`, so the response object is
// `{ apiVersion } & T`. `invokePayload` strips the envelope and returns `T`.
export type VersionedResponse<T> = { apiVersion: number } & T;

export type RecentProject = { id: string; name: string; rootPath: string; openedAt: string };
export type ProjectManifest = { id: string; name: string; customerName: string; authorName: string; version: string };
export type WorkflowNode = { id: NodeId; status: NodeStatus; markdown: string; revision: number; updatedAt: string };
export type ReasoningEffort = "off" | "low" | "medium" | "high";
export type ChatModelSelection = { providerId: string; model: string; reasoningEffort: ReasoningEffort };
export type MessageAttachmentRef = { fileId: string; originalName: string };
export type ModelExecution = ChatModelSelection;
export type ContextEstimate = {
  estimatedInputTokens: number;
  contextWindowTokens: number;
  ratio: number;
  status: "ready" | "warning" | "blocked";
};
export type ChatSession = { id: string; nodeId: NodeId; name: string; messageCount: number; createdAt: string; updatedAt: string; modelSelection?: ChatModelSelection | null };
export type ChatMessage = { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; attachments?: MessageAttachmentRef[]; modelExecution?: ModelExecution | null };
export type FileExtractionStatus = "available" | "failed" | "unsupported";
export type ProjectFile = {
  id: string;
  originalName: string;
  storedName: string;
  extension: string;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
  status: string;
  textPath?: string;
  characterCount?: number;
  kind?: string;
  extractionStatus?: FileExtractionStatus;
  extractionError?: string;
  pageCount?: number;
  sheetCount?: number;
  truncated?: boolean;
};

export type ProjectUiSettings = {
  initialized: boolean;
  openedNodeIds: NodeId[];
  activeNodeId: NodeId | null;
  tabsInitialized: boolean;
  rightTabIds: RightTabId[];
  activeRightTabId: RightTabId | null;
  rightPaneWidth: number;
};

export type UiSettings = {
  sidebarCollapsed: boolean;
  lastDestination: Exclude<MainDestination, "workspace">;
  projects: Record<string, ProjectUiSettings>;
};

export type DeliveryView = "preview" | "source";

export type RightSurface =
  | { kind: "delivery" }
  | { kind: "agent-rules" }
  | { kind: "file-pool" }
  | { kind: "file"; fileId: string }
  | { kind: "delivery-preview"; messageId: string };

export type WorkspaceView = {
  rightSurface: RightSurface | null;
  deliveryView: DeliveryView;
};

export type AppSettings = { projectsDirectory: string | null; ui: UiSettings };
export type NoticeMessage = {
  id: string;
  kind: "success" | "warning" | "error";
  message: string;
  dismissAfterMs: number | null;
};
export type FilePreview = { file: ProjectFile; text?: string; truncated: boolean };

export type ProviderModel = { name: string; isDefault: boolean; toolCalling: boolean; contextWindowTokens: number | null };
export type Provider = {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiUrlMode: "base" | "full";
  protocol: "chat_completions" | "openai_responses";
  models: ProviderModel[];
  isDefault: boolean;
  hasApiKey: boolean;
};

export type AgentRun = {
  id: string;
  projectId: string;
  nodeId: NodeId;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  summary?: string;
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fileIds?: string[];
};
export type AgentTokenEvent = { runId: string; projectId: string; nodeId: NodeId; sessionId: string; delta: string };
export type AgentFinishedEvent = { run: AgentRun };

// Frontend-only form model for saving a provider. It carries a single default
// model; `apiKey` is omitted to preserve the stored secret on edit.
export type ProviderDraft = {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiUrlMode: "base" | "full";
  protocol: "chat_completions" | "openai_responses";
  model: string;
  contextWindow: string;
  isDefault: boolean;
  apiKey?: string;
  now: string;
};

export type AssistantDeliveryPreview = {
  assistantMessageId: string;
  nodeId: NodeId;
  currentRevision: number;
  markdown: string;
  additions: number;
  deletions: number;
  unchanged: number;
};
export type SaveNodeResult = { saved?: WorkflowNode; conflict?: { latest: WorkflowNode } };

export type EffectiveAgentRules = {
  builtInMarkdown: string;
  customMarkdown: string | null;
  effectiveMarkdown: string;
};

export const statusLabel: Record<NodeStatus, string> = {
  not_started: "未开始",
  draft: "草稿",
  generated: "已生成",
  confirmed: "已确认",
  needs_confirmation: "待确认",
};

// --- Component prop contracts -------------------------------------------------
