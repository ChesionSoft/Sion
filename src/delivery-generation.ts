import type { DeliveryGeneration, WorkflowNode } from "./types.ts";

export function isCurrentGenerationEvent(activeGenerationId: string | null, eventGenerationId: string) {
  return activeGenerationId === eventGenerationId;
}

export function reconcileGeneratedNode(
  currentNode: WorkflowNode | null,
  draft: string,
  generation: DeliveryGeneration,
  savedNode?: WorkflowNode,
): { node: WorkflowNode | null; draft: string } {
  if (
    !currentNode
    || !savedNode
    || generation.status !== "completed"
    || savedNode.revision <= currentNode.revision
  ) {
    return { node: currentNode, draft };
  }
  return {
    node: savedNode,
    draft: draft === currentNode.markdown ? savedNode.markdown : draft,
  };
}

export function reconcileSavedNode(
  currentNode: WorkflowNode | null,
  draft: string,
  savedNode: WorkflowNode,
): { node: WorkflowNode; draft: string } {
  if (currentNode && savedNode.revision <= currentNode.revision) {
    return { node: currentNode, draft };
  }
  return {
    node: savedNode,
    draft: currentNode && draft === currentNode.markdown ? savedNode.markdown : draft,
  };
}
