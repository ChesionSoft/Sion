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
