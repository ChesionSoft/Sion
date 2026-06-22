export type NodeStatus = "not_started" | "draft" | "generated" | "confirmed" | "needs_confirmation";

export type PatchKind = "append_bullet" | "append_block" | "append_table_row";

export type WorkflowNodeId =
  | "basic-info"
  | "goals"
  | "roles-permissions"
  | "business-flow"
  | "feature-design"
  | "page-interaction"
  | "data-structure"
  | "api-design"
  | "architecture-deployment"
  | "development-tasks"
  | "risks-open-questions"
  | "final-export";

export type WorkflowNodeDefinition = {
  id: WorkflowNodeId;
  order: number;
  title: string;
  documentHeading: string;
  requiredForInitialization: boolean;
  dependsOn: WorkflowNodeId[];
  agentRuleFile: string;
};

export type ChatRole = "user" | "assistant" | "system";

export type ExternalSource = {
  id: string;
  kind: "provided_url" | "web_search";
  url: string;
  title: string;
  domain: string;
  snippet?: string;
  retrievedAt: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  reasoningContent?: string;
  sources?: ExternalSource[];
  createdAt: string;
  /** Server-generated id shared by every model call in one user turn. */
  turnId?: string;
  /** Wall-clock ms from turn start to first content token (or completion). */
  reasoningDurationMs?: number;
  /** Whole-turn token usage persisted on the assistant message. */
  usage?: TurnTokenUsage;
};

// ---------------------------------------------------------------------------
// Token usage — normalized across Chat Completions and Responses providers.
// ---------------------------------------------------------------------------

export type TokenUsageSource = "exact" | "estimated" | "mixed";
export type ModelCallCategory = "answer" | "tool_planning" | "fact_judge" | "document_update";

export type ProviderTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ModelCallUsage = ProviderTokenUsage & {
  id: string;
  category: ModelCallCategory;
  providerId: string;
  model: string;
  source: Exclude<TokenUsageSource, "mixed">;
  status: "completed" | "interrupted" | "failed";
};

export type TurnTokenUsage = ProviderTokenUsage & {
  turnId: string;
  source: TokenUsageSource;
  callCount: number;
  calls: ModelCallUsage[];
};

export type ChatSession = {
  id: string;
  nodeId: WorkflowNodeId;
  name: string;
  messageCount: number;
  webSearchEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectNode = {
  id: WorkflowNodeId;
  status: NodeStatus;
  markdown: string;
  revision: number;
  updatedAt: string;
};

export type ModelConfig = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
};

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type Project = {
  id: string;
  name: string;
  customerName: string;
  authorName: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  modelConfig?: Partial<ModelConfig>;
};

export type ContextLength = 4096 | 8192 | 16384 | 32768 | 65536 | 131072 | 128000 | 200000 | 1000000;

export type ApiUrlMode = "base" | "full";

export type ModelEntry = {
  name: string;
  contextLength?: ContextLength;
  isDefault?: boolean;
  /**
   * Whether this model accepts OpenAI-style function tool calls. Stored
   * explicitly per model — never derived from protocol, provider URL, or
   * model name. Models without it use the JSON planning fallback.
   */
  toolCalling?: boolean;
};

export type ModelProviderProtocol = "chat_completions" | "openai_responses";

export type ModelProvider = {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  protocol: ModelProviderProtocol;
  models: ModelEntry[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectFile = {
  id: string;
  originalName: string;
  storedName: string;
  extension: string;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
  status: "available" | "unsupported" | "read_failed";
  textPath?: string;
  characterCount?: number;
};

export type AgentRuleMode = "default" | "custom";

export type AgentOverrideSetting = {
  nodeId: WorkflowNodeId;
  mode: AgentRuleMode;
  customRulePath?: string;
  updatedAt: string;
};

export type FactCategory = "confirmed_fact" | "assumption" | "open_question";

export type PatchEvidence =
  | { source: "user" | "assistant"; quote: string }
  | { source: "external"; quote: string; sourceId: string };

export type NodeMarkdownPatch = {
  category: FactCategory;
  targetSectionKey: string;
  patchKind: PatchKind;
  markdown: string;
  evidence: PatchEvidence;
};

export type NodeFactDecision = {
  changes: NodeMarkdownPatch[];
};

export type RewriteStreamEvent =
  | { type: "markdown_start"; mode: "rewrite"; baseRevision: number }
  | { type: "markdown_token"; content: string; mode: "rewrite" }
  | { type: "markdown_done"; updatedNode: ProjectNode }
  | { type: "markdown_conflict"; latestNode: ProjectNode; candidateMarkdown: string }
  | { type: "markdown_error"; error: string };

export type ChatStreamEvent =
  | { type: "reasoning"; content: string }
  | { type: "token"; content: string }
  | { type: "url_read_start"; urls: string[] }
  | { type: "url_read_result"; url: string; ok: true; source: ExternalSource }
  | { type: "url_read_result"; url: string; ok: false; error: string }
  | { type: "source"; source: ExternalSource }
  | { type: "web_search_start"; query: string }
  | { type: "web_search_result"; query: string; ok: true; results: SearchResult[] }
  | { type: "web_search_result"; query: string; ok: false; code: BrowserWebErrorCode; message: string; verificationId?: string }
  | { type: "web_fetch_start"; url: string }
  | { type: "web_fetch_result"; url: string; ok: true; content: string }
  | { type: "web_fetch_result"; url: string; ok: false; code: BrowserWebErrorCode; message: string }
  | { type: "browser_verification_required"; verificationId: string; engine: SearchEngineId }
  | { type: "notice"; message: string }
  | { type: "markdown_check_start" }
  | { type: "markdown_unchanged"; warning?: string }
  | { type: "markdown_start"; mode: "increment"; baseRevision: number }
  | { type: "markdown_patch_preview"; patch: NodeMarkdownPatch }
  | { type: "markdown_error"; error: string }
  | { type: "activity"; stage: Exclude<AgentActivityStage, "idle">; summary: string; at: string }
  | { type: "done"; sessionId: string; assistantMessage: ChatMessage }
  | { type: "error"; error: string; assistantMessage?: ChatMessage };

// ---------------------------------------------------------------------------
// Agent activity — authoritative stage feedback streamed to the chat UI.
// ---------------------------------------------------------------------------

export type AgentActivityStage =
  | "idle"
  | "thinking"
  | "reading_files"
  | "searching_web"
  | "generating_answer"
  | "updating_document"
  | "completed"
  | "failed"
  | "interrupted";

// ---------------------------------------------------------------------------
// Browser search — shared contracts reused across the foundation and
// orchestration plans. See docs/superpowers/plans/2026-06-21-*-browser-search*.
// ---------------------------------------------------------------------------

export type SearchEngineId = "google" | "baidu";

export type BrowserWebErrorCode =
  | "browser_unavailable"
  | "browser_launch_failed"
  | "search_timeout"
  | "search_page_unrecognized"
  | "verification_required"
  | "blocked_address"
  | "response_too_large"
  | "aborted";

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  rank: number;
};

export type BrowserSearchPreferences = {
  defaultEngine: SearchEngineId;
  browserPreference: "system" | "chromium";
};

export type BrowserSearchStatus = {
  systemBrowser: { kind: "chrome" | "edge"; version: string } | null;
  managedChromiumInstalled: boolean;
  profileConfigured: boolean;
};
