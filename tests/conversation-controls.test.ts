import assert from "node:assert/strict";
import test from "node:test";
import { contextIndicatorKind, defaultModelSelection, toggleAttachment } from "../src/conversation-controls.ts";

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
