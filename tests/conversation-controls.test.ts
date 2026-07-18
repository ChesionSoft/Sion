import assert from "node:assert/strict";
import test from "node:test";
import {
  contextIndicatorKind,
  conversationCanSend,
  defaultModelSelection,
  providerModelValidationError,
  selectionIsValid,
  toggleAttachment,
} from "../src/conversation-controls.ts";

const providers = [{
  id: "p", name: "Provider", apiBaseUrl: "https://example.invalid/v1", apiUrlMode: "base" as const,
  protocol: "chat_completions" as const, isDefault: true, hasApiKey: true,
  models: [
    { name: "incomplete", isDefault: false, toolCalling: false, contextWindowTokens: null },
    { name: "ready", isDefault: true, toolCalling: false, contextWindowTokens: 128000 },
  ],
}];

test("defaults to the configured default model and medium reasoning", () => {
  assert.deepEqual(defaultModelSelection(providers), { providerId: "p", model: "ready", reasoningEffort: "medium" });
});

test("toggles one-message attachments without duplicates", () => {
  assert.deepEqual(toggleAttachment(["a"], "a"), []);
  assert.deepEqual(toggleAttachment(["a"], "b"), ["a", "b"]);
});

test("maps context thresholds to compact indicator states", () => {
  assert.equal(contextIndicatorKind({ ratio: .79, status: "ready" }), "ready");
  assert.equal(contextIndicatorKind({ ratio: .8, status: "warning" }), "warning");
  assert.equal(contextIndicatorKind({ ratio: 1.01, status: "blocked" }), "blocked");
});

test("send waits for a current context estimate and a valid model", () => {
  const selection = { providerId: "p", model: "ready", reasoningEffort: "medium" as const };
  const ready = { estimatedInputTokens: 10, contextWindowTokens: 100, ratio: .1, status: "ready" as const };
  const base = {
    nodeAvailable: true,
    draft: "hello",
    selection,
    providers,
    savingSelection: false,
    estimating: false,
    estimateError: null,
  };
  assert.equal(conversationCanSend({ ...base, estimate: null }), false);
  assert.equal(conversationCanSend({ ...base, estimate: ready, estimating: true }), false);
  assert.equal(conversationCanSend({ ...base, estimate: ready }), true);
  assert.equal(conversationCanSend({ ...base, estimate: { ...ready, status: "blocked" } }), false);
  assert.equal(conversationCanSend({ ...base, selection: { ...selection, model: "deleted" }, estimate: ready }), false);
});

test("a deleted session model is invalid instead of silently remaining selected", () => {
  assert.equal(selectionIsValid({ providerId: "p", model: "deleted", reasoningEffort: "medium" }, providers), false);
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
