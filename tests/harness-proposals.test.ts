import assert from "node:assert/strict";
import test from "node:test";
import {
  proposalCanResolve,
  proposalStaleDetail,
  proposalStatusLabel,
  proposalTargetLabel,
} from "../src/harness-proposals.ts";
import type { HarnessProposal } from "../src/types.ts";

function proposal(overrides: Partial<HarnessProposal> = {}): HarnessProposal {
  return {
    id: "proposal-1",
    kind: "delivery",
    status: "ready",
    projectId: "project-1",
    nodeId: "goals",
    turnId: "turn-1",
    baseContent: "# 当前稿",
    proposedContent: "# 建议稿",
    reason: "补全建设目标",
    createdAt: "2026-08-17T00:00:00Z",
    ...overrides,
  };
}

test("ready proposals are actionable only when their source draft is clean", () => {
  const ready = proposal();
  assert.equal(proposalCanResolve(ready, false, false), true);
  assert.equal(proposalCanResolve(ready, true, false), false);
  assert.equal(proposalCanResolve(ready, false, true), false);
  assert.equal(proposalCanResolve(proposal({ status: "applied" }), false, false), false);
});

test("proposal labels distinguish document delivery and agent rules", () => {
  assert.equal(proposalTargetLabel(proposal()), "当前节点交付稿");
  assert.equal(proposalTargetLabel(proposal({ kind: "agent_rule" })), "当前节点 Agent 规则");
  assert.equal(proposalStatusLabel(proposal({ status: "rejected" })), "已拒绝");
});

test("stale proposals explain the revision source without exposing tool data", () => {
  assert.match(proposalStaleDetail(proposal({ status: "stale", latestRevision: 12 })) ?? "", /revision 12/);
  assert.match(proposalStaleDetail(proposal({ kind: "agent_rule", status: "stale", latestRuleDigest: "digest" })) ?? "", /规则已变化/);
  assert.equal(proposalStaleDetail(proposal()), null);
});
