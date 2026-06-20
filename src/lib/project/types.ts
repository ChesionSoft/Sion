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

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  reasoningContent?: string;
  createdAt: string;
};

export type ChatSession = {
  id: string;
  nodeId: WorkflowNodeId;
  name: string;
  messageCount: number;
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
};

export type ModelProvider = {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
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

export type NodeMarkdownPatch = {
  category: FactCategory;
  targetSectionKey: string;
  patchKind: PatchKind;
  markdown: string;
  evidence: {
    source: "user" | "assistant";
    quote: string;
  };
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
  | { type: "markdown_check_start" }
  | { type: "markdown_unchanged"; warning?: string }
  | { type: "markdown_start"; mode: "increment"; baseRevision: number }
  | { type: "markdown_patch_preview"; patch: NodeMarkdownPatch }
  | { type: "markdown_error"; error: string }
  | { type: "done"; sessionId: string }
  | { type: "error"; error: string };