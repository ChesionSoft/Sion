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
export type RightTabId = DurableRightTabId;

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
export type TokenUsageSource = "exact" | "estimated" | "mixed";
export type ModelCallCategory = "answer" | "tool_planning" | "document_update" | "other";
export type ModelCallStatus = "completed" | "interrupted" | "failed";
export type ModelCallUsage = {
  id: string;
  category: ModelCallCategory;
  providerId: string;
  model: string;
  source: TokenUsageSource;
  status: ModelCallStatus;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};
export type TurnTokenUsage = {
  turnId: string;
  source: TokenUsageSource;
  callCount: number;
  calls: ModelCallUsage[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};
export type CumulativeTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  source: TokenUsageSource;
};
export type ConversationContextSnapshot = ContextEstimate & {
  breakdown: {
    protocolTokens: number;
    rulesTokens: number;
    dependencyNodeTokens: number;
    nodeMarkdownTokens: number;
    conversationTokens: number;
    attachmentTokens: number;
  };
  cumulativeUsage: CumulativeTokenUsage;
  calculatedAt: string;
};
export type ChatSession = { id: string; nodeId: NodeId; name: string; messageCount: number; createdAt: string; updatedAt: string; modelSelection?: ChatModelSelection | null };
export type ChatMessage = { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; turnId?: string; usage?: TurnTokenUsage; attachments?: MessageAttachmentRef[]; modelExecution?: ModelExecution | null };
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
  | { kind: "file"; fileId: string };

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

export type AgentRunKind = "conversation" | "delivery_decision" | "delivery_retry" | "delivery_regeneration";
export type AgentRun = {
  id: string;
  projectId: string;
  nodeId: NodeId;
  kind: AgentRunKind;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fileIds?: string[];
  sessionId?: string;
  turnId?: string;
  contextSnapshot?: ConversationContextSnapshot;
  usage?: TurnTokenUsage;
  durationMs?: number;
};
export type AgentRunStartResult = { run: AgentRun; turn: ConversationTurn };
export type AgentRunStartOutcome =
  | { kind: "started"; run: AgentRun; turn: ConversationTurn }
  | {
      kind: "context_blocked";
      snapshot: ConversationContextSnapshot;
      excessTokens: number;
      largestSection: string;
    };
export type AgentTokenEvent = { runId: string; projectId: string; nodeId: NodeId; sessionId: string; delta: string };
export type AgentReasoningSummaryEvent = { runId: string; projectId: string; nodeId: NodeId; sessionId: string; delta: string };
export type DeliveryDecisionTokenEvent = { runId: string; projectId: string; nodeId: NodeId; sessionId: string; turnId: string; delta: string };
export type AgentFinishedEvent = { run: AgentRun };
export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type TurnActivityKind = "response" | "delivery_check" | "delivery_validate" | "delivery_save";
export type TurnActivityStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type DeliveryStage = "response" | "decision" | "validation" | "save";
export type TurnActivity = {
  id: string;
  kind: TurnActivityKind;
  status: TurnActivityStatus;
  label: string;
  publicSummary?: string;
  startedAt?: string;
  finishedAt?: string;
};
export type DeliveryOutcome =
  | { kind: "pending" }
  | { kind: "unchanged" }
  | { kind: "patch_applied"; previousRevision: number; revision: number; sectionTitles: string[] }
  | { kind: "awaiting_manual_draft_resolution"; expectedRevision: number }
  | { kind: "conflict"; expectedRevision: number; actualRevision: number }
  | { kind: "failed"; stage: DeliveryStage; publicError: string }
  | { kind: "cancelled" };
export type DeliveryDecisionInspection = {
  rawResponse: string;
  baseMarkdown: string;
  proposedMarkdown?: string;
};
export type ConversationTurn = {
  id: string;
  projectId: string;
  nodeId: NodeId;
  sessionId: string;
  runId: string;
  userMessageId: string;
  assistantMessageId?: string;
  status: TurnStatus;
  activities: TurnActivity[];
  reasoningSummary?: string;
  deliveryOutcome: DeliveryOutcome;
  deliveryInspection?: DeliveryDecisionInspection;
  startedAt: string;
  finishedAt?: string;
};
export type AgentRunDetail = {
  run: AgentRun;
  turn?: ConversationTurn;
  assistantMessage?: ChatMessage;
};
export type ConversationTurnEvent = { turn: ConversationTurn; savedNode?: WorkflowNode };
export type DeliveryGenerationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "conflict";
export type DeliveryGeneration = {
  id: string;
  runId: string;
  projectId: string;
  nodeId: NodeId;
  status: DeliveryGenerationStatus;
  expectedRevision: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};
export type DeliveryGenerationTokenEvent = { generationId: string; projectId: string; nodeId: NodeId; delta: string };
export type DeliveryGenerationFinishedEvent = { generation: DeliveryGeneration; savedNode?: WorkflowNode };

// Frontend-only form model for saving a provider. It carries a single default
// model; `apiKey` is omitted to preserve the stored secret on edit.
export type ProviderDraft = {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiUrlMode: "base" | "full";
  protocol: "chat_completions" | "openai_responses";
  models: ProviderModel[];
  isDefault: boolean;
  apiKey?: string;
  now: string;
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

// --- Export center -----------------------------------------------------------

export type ExportArtifactKind =
  | "blueprint"
  | "formal_draft"
  | "qa_report"
  | "formal_docx"
  | "project_design"
  | "spec"
  | "tasks"
  | "agents";

export type ExportApproval = {
  artifactKind: ExportArtifactKind;
  approvedRevision: number;
  approvedDigest: string;
  approvedAt: string;
};

export type ExportApprovals = {
  blueprint: ExportApproval | null;
  draft: ExportApproval | null;
};

export type ExportQaState =
  | "none"
  | { passed: { checkedDraftDigest: string; checkedAt: string } }
  | { failed: { checkedDraftDigest: string; checkedAt: string; issueCodes: string[] } };

export type ExportAttachmentBatchStatus =
  | "none"
  | "complete"
  | { failed: { failedKinds: ExportArtifactKind[] } };

export type ExportArtifactSummary = {
  kind: ExportArtifactKind;
  filename: string;
  revision: number;
  digest: string;
  available: boolean;
  updatedAt: string | null;
  stale: boolean;
  byteSize: number;
};

export type ExportRunSummary = {
  runId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  publicSummary: string | null;
  updatedAt: string;
};

export type ExportCandidate = {
  id: string;
  targetKind: ExportArtifactKind;
  baseRevision: number;
  baseDigest: string;
  candidateDigest: string;
  markdown: string;
  modelSelection: ChatModelSelection | null;
  createdAt: string;
};

export type BlueprintPatchOp =
  | { op: "update"; sectionId: string; section: ExportBlueprintSection }
  | { op: "insert"; afterSectionId: string | null; section: ExportBlueprintSection }
  | { op: "delete"; sectionId: string }
  | { op: "reorder"; orderedSectionIds: string[] };

export type DraftPatchOp =
  | { op: "replace"; heading: string; markdown: string }
  | { op: "insert"; afterHeading: string | null; heading: string; markdown: string }
  | { op: "delete"; heading: string }
  | { op: "reorder"; orderedHeadings: string[] };

export type ExportBlueprintSection = {
  title: string;
  id: string;
  inclusion: "confirmed" | "confirmed-summary" | "omit" | "required-disclosure";
  presentation: "paragraphs" | "bullets" | "table" | "flow" | "appendix";
  source: NodeId;
  headings: string;
  rationale: string;
};

export type ExportProposedOp = { blueprint: BlueprintPatchOp } | { draft: DraftPatchOp };

export type ExportPatchApplication = {
  changeId: string;
  applied: boolean;
  reason: string | null;
};

export type ExportReviewStatus =
  | "queued"
  | "running"
  | "ready"
  | "partially_applied"
  | "applied"
  | "stale"
  | "failed"
  | "cancelled";

export type ExportProposedChange = {
  id: string;
  targetKind: ExportArtifactKind;
  op: ExportProposedOp;
  before: string;
  after: string;
};

export type ExportReviewTask = {
  id: string;
  targetKind: ExportArtifactKind;
  instruction: string;
  baseRevision: number;
  baseDigest: string;
  modelSelection: ChatModelSelection | null;
  status: ExportReviewStatus;
  proposedChanges: ExportProposedChange[];
  appliedResults: ExportPatchApplication[];
  createdAt: string;
  finishedAt: string | null;
  appliedAt: string | null;
};

export type ExportWorkspaceSnapshot = {
  projectId: string;
  modelSelection: ChatModelSelection | null;
  blueprint: ExportArtifactSummary;
  deliveryArtifacts: ExportArtifactSummary[];
  approvals: ExportApprovals;
  qaState: ExportQaState;
  pendingCandidates: ExportCandidate[];
  reviewTasks: ExportReviewTask[];
  activeRun: ExportRunSummary | null;
  sourceWarnings: NodeId[];
  attachmentBatchStatus: ExportAttachmentBatchStatus;
};

export type ExportArtifactContent =
  | { kind: "markdown"; markdown: string; truncated: boolean }
  | { kind: "source"; markdown: string; truncated: boolean }
  | { kind: "docx_html"; html: string; truncated: boolean; characterCount: number }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export type ExportCommandErrorKind =
  | "not_found"
  | "validation_failed"
  | "revision_conflict"
  | "stale_review"
  | "run_busy"
  | "provider_failed"
  | "qa_failed"
  | "cancelled"
  | "io_failed";

export type ExportCommandError = {
  kind: ExportCommandErrorKind;
  message: string;
  latestRevision: number | null;
  latestDigest: string | null;
};

export type ExportCommandOutcome<T> =
  | { outcome: "success"; value: T }
  | { outcome: "error"; error: ExportCommandError };

export type ExportSaveAsResult = { exported: boolean; path: string | null };

export type ExportAction =
  | "generate_blueprint"
  | "regenerate_blueprint"
  | "generate_draft"
  | "regenerate_draft"
  | "finalize_docx"
  | "generate_engineering_attachments";

export type ExportRunEvent = {
  projectId: string;
  runId: string;
  status: ExportRunSummary["status"];
  publicSummary: string | null;
  updatedAt: string;
};

export type ExportWorkspaceInvalidatedEvent = { projectId: string };
