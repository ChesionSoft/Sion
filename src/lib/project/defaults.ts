import { WORKFLOW_NODES, getNodeDefinition } from "./nodes";
import type { Project, ProjectNode, WorkflowNodeId } from "./types";

export type CreateDefaultProjectInput = {
  id: string;
  name: string;
  customerName?: string;
  authorName?: string;
  now?: string;
};

export function createDefaultProject(input: CreateDefaultProjectInput): Project {
  const now = input.now ?? new Date().toISOString();

  return {
    id: input.id,
    name: input.name,
    customerName: input.customerName ?? "",
    authorName: input.authorName ?? "",
    version: "V1.0",
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultProjectNodes(now = new Date().toISOString()): ProjectNode[] {
  return WORKFLOW_NODES.map((node) => ({
    id: node.id,
    status: node.requiredForInitialization ? "draft" : "not_started",
    markdown: createNodeMarkdown(node.id),
    revision: 0,
    updatedAt: now,
  }));
}

export function createNodeMarkdown(nodeId: WorkflowNodeId): string {
  const node = getNodeDefinition(nodeId);

  if (!node) {
    throw new Error(`Unknown workflow node: ${nodeId}`);
  }

  return [
    `# ${node.title}`,
    "",
    "## 已确认内容",
    "",
    "- 本节内容尚未确认。",
    "",
    "## 设计假设",
    "",
    "- 暂无。",
    "",
    "## 待确认问题",
    "",
    "- 暂无。",
    "",
  ].join("\n");
}
