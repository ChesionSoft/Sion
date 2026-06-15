export type NodeStatus = "not_started" | "draft" | "generated" | "confirmed" | "needs_confirmation";

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
  assumptions: string[];
  openQuestions: string[];
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

export type ContextLength = 4096 | 8192 | 16384 | 32768 | 65536 | 131072 | 200000 | 1000000;

export type ModelEntry = {
  name: string;
  contextLength?: ContextLength;
  isDefault?: boolean;
};

export type ModelProvider = {
  id: string;
  name: string;
  apiBaseUrl: string;
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
