import assert from "node:assert/strict";
import test from "node:test";
import * as conversationControls from "../src/conversation-controls.ts";
import {
  contextIndicatorKind,
  conversationCanSend,
  defaultModelSelection,
  providerModelValidationError,
  selectionIsValid,
  selectionIsValidForExport,
  toggleAttachment,
} from "../src/conversation-controls.ts";
import type { ChatSession } from "../src/types.ts";

const providers = [{
  id: "p", name: "Provider", apiBaseUrl: "https://example.invalid/v1", apiUrlMode: "base" as const,
  protocol: "chat_completions" as const, isDefault: true, hasApiKey: true,
  models: [
    { name: "incomplete", isDefault: false, toolCalling: false, contextWindowTokens: null },
    { name: "ready", isDefault: true, toolCalling: true, contextWindowTokens: 128000 },
    { name: "export-only", isDefault: false, toolCalling: false, contextWindowTokens: 128000 },
  ],
}];

test("defaults to the configured default model and medium reasoning", () => {
  assert.deepEqual(defaultModelSelection(providers), { providerId: "p", model: "ready", reasoningEffort: "medium" });
});

test("toggles one-message attachments without duplicates", () => {
  assert.deepEqual(toggleAttachment(["a"], "a"), []);
  assert.deepEqual(toggleAttachment(["a"], "b"), ["a", "b"]);
});

test("conversation requests use only a session owned by the active node", () => {
  const activeSessionForNode = (conversationControls as unknown as {
    activeSessionForNode?: (
      sessions: ChatSession[],
      sessionId: string | null,
      nodeId: ChatSession["nodeId"] | null,
    ) => ChatSession | null;
  }).activeSessionForNode;
  const session: ChatSession = {
    id: "session-basic-info",
    nodeId: "basic-info",
    name: "需求讨论",
    messageCount: 1,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };

  assert.equal(typeof activeSessionForNode, "function");
  assert.equal(activeSessionForNode?.([session], session.id, "basic-info"), session);
  assert.equal(activeSessionForNode?.([session], session.id, "goals"), null);
  assert.equal(activeSessionForNode?.([session], "missing", "basic-info"), null);
});

test("maps context thresholds to compact indicator states", () => {
  assert.equal(contextIndicatorKind({ ratio: .79, status: "ready" }), "ready");
  assert.equal(contextIndicatorKind({ ratio: .8, status: "warning" }), "warning");
  assert.equal(contextIndicatorKind({ ratio: 1.01, status: "blocked" }), "blocked");
});

test("send eligibility does not depend on context telemetry", () => {
  const base = {
    nodeAvailable: true,
    draft: "hello",
    selection: { providerId: "p", model: "ready", reasoningEffort: "medium" as const },
    providers,
    savingSelection: false,
  };
  assert.equal(conversationCanSend(base), true);
  assert.equal(conversationCanSend({ ...base, draft: "  " }), false);
  assert.equal(conversationCanSend({ ...base, selection: null }), false);
  assert.equal(conversationCanSend({ ...base, selection: { ...base.selection, model: "deleted" } }), false);
});

test("a deleted session model is invalid instead of silently remaining selected", () => {
  assert.equal(selectionIsValid({ providerId: "p", model: "deleted", reasoningEffort: "medium" }, providers), false);
});

test("node harness chat rejects text-only models while export may use them", () => {
  const selection = { providerId: "p", model: "export-only", reasoningEffort: "medium" as const };
  assert.equal(selectionIsValid(selection, providers), false);
  assert.equal(selectionIsValidForExport(selection, providers), true);
  assert.equal(conversationCanSend({
    nodeAvailable: true,
    draft: "请继续",
    selection,
    providers,
    savingSelection: false,
  }), false);
});

test("provider model rows validate synchronously before the first save", () => {
  assert.equal(providerModelValidationError([
    { name: "same", contextWindow: "128000", isDefault: true },
    { name: " same ", contextWindow: "64000", isDefault: false },
  ]), "模型名称不能重复");
  assert.equal(providerModelValidationError([
    { name: "model", contextWindow: "", isDefault: true },
  ]), "每个模型需要正整数的上下文窗口");
  assert.equal(providerModelValidationError([
    { name: "model", contextWindow: "128000", isDefault: true },
  ]), null);
});
