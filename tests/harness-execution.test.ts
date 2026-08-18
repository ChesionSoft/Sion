import test from "node:test";
import assert from "node:assert/strict";
import { effectiveExecutionPlanStatus, executionInvalidReasonLabel, executionPlanStatusLabel, executionStatusLabel, executionTargetState } from "../src/harness-execution.ts";

test("execution plan labels preserve the confirmation boundary", () => {
  const plan = {
    id: "plan-1",
    projectId: "project-1",
    nodeId: "goals",
    sessionId: "session-1",
    planTurnId: "turn-1",
    planMessageId: "message-1",
    baseRevision: 3,
    summary: "补充建设目标",
    status: "pending" as const,
    createdAt: "2026-08-18T00:00:00Z",
    expiresAt: "2026-08-18T00:30:00Z",
  };
  assert.equal(executionPlanStatusLabel(plan), "等待确认");
  assert.equal(executionInvalidReasonLabel("node_changed"), "当前节点内容已变化");
});

test("execution audit labels expose partial completion without implying rollback", () => {
  assert.equal(executionStatusLabel({
    runId: "run-1",
    turnId: "turn-2",
    startedAt: "now",
    status: "failed",
    writes: [{ revision: 4, summary: "保存建设目标", savedAt: "later" }],
    publicError: "模型服务暂时不可用",
  }), "执行未完整完成");
});

test("an execution record suppresses stale plan state", () => {
  const plan = {
    id: "plan-1",
    projectId: "project-1",
    nodeId: "goals",
    sessionId: "session-1",
    planTurnId: "turn-1",
    planMessageId: "message-1",
    baseRevision: 3,
    summary: "补充建设目标",
    status: "pending" as const,
    createdAt: "2026-08-18T00:00:00Z",
    expiresAt: "2026-08-18T00:30:00Z",
  };
  const execution = {
    runId: "run-1",
    turnId: "turn-2",
    startedAt: "now",
    finishedAt: "later",
    status: "completed" as const,
    writes: [{ revision: 4, summary: "保存建设目标", savedAt: "later" }],
  };
  assert.equal(effectiveExecutionPlanStatus(plan, execution), "consumed");
  assert.equal(executionPlanStatusLabel(plan, execution), "已确认执行");
  assert.equal(
    effectiveExecutionPlanStatus({
      ...plan,
      status: "invalidated",
      invalidReason: "restarted",
      invalidatedAt: "later",
    }, execution),
    "consumed",
  );
});

test("execution target state tolerates legacy records without empty writes", () => {
  assert.equal(executionTargetState(planForExecutionStateTest(), {
    runId: "run-1",
    turnId: "turn-2",
    startedAt: "now",
    status: "running",
  }, "goals"), "pending");
});

function planForExecutionStateTest() {
  return {
    id: "plan-1",
    projectId: "project-1",
    nodeId: "goals" as const,
    sessionId: "session-1",
    planTurnId: "turn-1",
    planMessageId: "message-1",
    baseRevision: 3,
    summary: "补充建设目标",
    status: "consumed" as const,
    createdAt: "2026-08-18T00:00:00Z",
    expiresAt: "2026-08-18T00:30:00Z",
  };
}
