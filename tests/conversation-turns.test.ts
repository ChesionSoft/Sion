import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ConversationTurn } from "../src/types.ts";
import {
  groupConversation,
  mergeTurnSnapshot,
  turnCanRetryDelivery,
  turnHeadline,
} from "../src/conversation-turns.ts";

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "message-1",
  role: "assistant",
  content: "内容",
  createdAt: "2026-07-18T00:00:00Z",
  ...overrides,
});

const turn = (overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: "turn-1",
  projectId: "project-1",
  nodeId: "goals",
  sessionId: "session-1",
  runId: "run-1",
  userMessageId: "user-1",
  assistantMessageId: "assistant-1",
  status: "completed",
  activities: [],
  deliveryOutcome: { kind: "unchanged" },
  startedAt: "2026-07-18T00:00:00Z",
  finishedAt: "2026-07-18T00:00:01Z",
  ...overrides,
});

test("newer turn snapshots replace in place without reordering history", () => {
  const queued = turn({ id: "turn-1", status: "queued", startedAt: "2026-07-18T00:00:00Z" });
  const running = turn({ id: "turn-1", status: "running", startedAt: "2026-07-18T00:00:00Z" });
  assert.deepEqual(mergeTurnSnapshot([queued], running), [running]);
});

test("grouping links one user and assistant message without duplicating legacy messages", () => {
  const messages = [
    message({ id: "user-1", role: "user", turnId: "turn-1" }),
    message({ id: "assistant-1", role: "assistant", turnId: "turn-1" }),
    message({ id: "legacy", role: "assistant" }),
  ];
  const grouped = groupConversation(
    messages,
    [turn({ id: "turn-1", userMessageId: "user-1", assistantMessageId: "assistant-1" })],
  );
  assert.deepEqual(
    grouped.map((item) => item.kind),
    ["turn", "legacy_message"],
  );
});

test("retry is allowed only when the draft is clean and the turn is awaiting resolution", () => {
  const awaiting = turn({
    deliveryOutcome: { kind: "awaiting_manual_draft_resolution", expectedRevision: 7 },
  });
  assert.equal(turnCanRetryDelivery(awaiting, false), true);
  assert.equal(turnCanRetryDelivery(awaiting, true), false);
  assert.equal(turnCanRetryDelivery(turn({ deliveryOutcome: { kind: "unchanged" } }), false), false);
});

test("headline summarizes the terminal delivery outcome", () => {
  assert.equal(
    turnHeadline(turn({ deliveryOutcome: { kind: "patch_applied", previousRevision: 7, revision: 8, sectionTitles: ["建设目标"] } })),
    "交付稿已更新 · revision 8",
  );
  assert.equal(turnHeadline(turn({ status: "interrupted" })), "运行在应用退出前中断");
});

test("response failures headline the mapped provider reason", () => {
  const failed = turn({
    status: "failed",
    deliveryOutcome: {
      kind: "failed",
      stage: "response",
      publicError: "模型服务上游网关超时（HTTP 504），请稍后重新发送",
    },
  });
  assert.equal(
    turnHeadline(failed),
    "模型服务上游网关超时（HTTP 504），请稍后重新发送",
  );
});
