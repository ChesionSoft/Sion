import type { DeliveryGeneration, NodeId, WorkflowNode } from "./types.ts";

export type DeliveryGenerationProgress = {
  generation: DeliveryGeneration | null;
  candidate: string;
  starting: boolean;
};

export type DeliveryGenerationProgressByScope = Record<string, DeliveryGenerationProgress>;

export function deliveryGenerationScope(projectId: string, nodeId: NodeId, sessionId: string) {
  return `${projectId}:${nodeId}:${sessionId}`;
}

export function beginDeliveryGeneration(
  progressByScope: DeliveryGenerationProgressByScope,
  scope: string,
): DeliveryGenerationProgressByScope {
  return {
    ...progressByScope,
    [scope]: { generation: null, candidate: "", starting: true },
  };
}

export function receiveDeliveryGeneration(
  progressByScope: DeliveryGenerationProgressByScope,
  scope: string,
  generation: DeliveryGeneration,
): DeliveryGenerationProgressByScope {
  const current = progressByScope[scope];
  return {
    ...progressByScope,
    [scope]: {
      generation,
      candidate: current?.candidate ?? "",
      starting: false,
    },
  };
}

export function appendDeliveryGenerationCandidate(
  progressByScope: DeliveryGenerationProgressByScope,
  scope: string,
  delta: string,
): DeliveryGenerationProgressByScope {
  const current = progressByScope[scope];
  if (!current) return progressByScope;
  return {
    ...progressByScope,
    [scope]: { ...current, candidate: current.candidate + delta },
  };
}

export function failToStartDeliveryGeneration(
  progressByScope: DeliveryGenerationProgressByScope,
  scope: string,
): DeliveryGenerationProgressByScope {
  const current = progressByScope[scope];
  if (!current || current.generation) return progressByScope;
  const { [scope]: _discarded, ...remaining } = progressByScope;
  return remaining;
}

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
