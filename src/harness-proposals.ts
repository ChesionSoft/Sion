import type { HarnessProposal } from "./types.ts";

export type HarnessProposalAction = "approve" | "reject";

export function proposalTargetLabel(proposal: HarnessProposal): string {
  return proposal.kind === "delivery" ? "当前节点交付稿" : "当前节点 Agent 规则";
}

export function proposalStatusLabel(proposal: HarnessProposal): string {
  switch (proposal.status) {
    case "ready": return "等待审核";
    case "applied": return "已应用";
    case "rejected": return "已拒绝";
    case "stale": return "已过期";
  }
}

export function proposalCanResolve(proposal: HarnessProposal, busy: boolean, blocked: boolean): boolean {
  return proposal.status === "ready" && !busy && !blocked;
}

export function proposalStaleDetail(proposal: HarnessProposal): string | null {
  if (proposal.status !== "stale") return null;
  if (proposal.kind === "delivery" && proposal.latestRevision !== undefined) {
    return `当前交付稿已更新到 revision ${proposal.latestRevision}，请基于最新内容重新讨论。`;
  }
  if (proposal.kind === "agent_rule" && proposal.latestRuleDigest) {
    return "当前 Agent 规则已变化，请基于最新规则重新讨论。";
  }
  return "提案的来源内容已变化，请基于最新内容重新讨论。";
}
