import { WORKFLOW_NODES, getNodeDefinition } from "./nodes";
import { getDeliverySchema } from "./node-delivery-schemas";
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

  // Seed only the node's real content sections (no confirmed/assumptions/
  // open_questions meta-sections). Required sections get a heading so the
  // document shows its structure; optional sections are created on demand
  // when the agent fills them. Section bodies are left empty — the patcher
  // appends real content (and creates tables) on the first patch.
  const schema = getDeliverySchema(nodeId);
  const lines = [`# ${node.title}`, ""];
  if (schema) {
    for (const section of schema.sections) {
      if (!section.required) continue;
      lines.push(`${"#".repeat(section.level)} ${section.heading}`, "");
    }
  }
  return lines.join("\n");
}
