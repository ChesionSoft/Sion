import type { AgentReasoningSummaryEvent, NodeId } from "./types";

export type LiveReasoningByRun = Record<string, string>;

export type ReasoningScope = {
  projectId: string;
  nodeId: NodeId;
  sessionId: string;
};

const MAX_PUBLIC_REASONING_CHARACTERS = 2_000;

export function appendLiveReasoning(
  current: LiveReasoningByRun,
  event: AgentReasoningSummaryEvent,
  scope: ReasoningScope,
): LiveReasoningByRun {
  if (
    event.projectId !== scope.projectId ||
    event.nodeId !== scope.nodeId ||
    event.sessionId !== scope.sessionId
  ) {
    return current;
  }
  const next = [...`${current[event.runId] ?? ""}${event.delta}`]
    .slice(0, MAX_PUBLIC_REASONING_CHARACTERS)
    .join("");
  return { ...current, [event.runId]: next };
}

export function removeLiveReasoning(
  current: LiveReasoningByRun,
  runId: string,
): LiveReasoningByRun {
  if (!(runId in current)) return current;
  const next = { ...current };
  delete next[runId];
  return next;
}

export function clearLiveReasoning(): LiveReasoningByRun {
  return {};
}
