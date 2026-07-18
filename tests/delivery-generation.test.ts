import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentGenerationEvent, reconcileGeneratedNode, reconcileSavedNode } from "../src/delivery-generation.ts";
import type { DeliveryGeneration, WorkflowNode } from "../src/types.ts";

const node = (markdown: string, revision: number): WorkflowNode => ({
  id: "goals",
  status: "draft",
  markdown,
  revision,
  updatedAt: "now",
});

const generation = (status: DeliveryGeneration["status"]): DeliveryGeneration => ({
  id: "generation-1",
  runId: "run-1",
  projectId: "project-1",
  nodeId: "goals",
  status,
  expectedRevision: 1,
  startedAt: "now",
});

test("completed regeneration refreshes a clean editor", () => {
  const current = node("old", 1);
  const saved = node("new", 2);
  assert.deepEqual(
    reconcileGeneratedNode(current, "old", generation("completed"), saved),
    { node: saved, draft: "new" },
  );
});

test("conflict or a dirty editor never loses the current draft", () => {
  const current = node("old", 1);
  const saved = node("new", 2);
  assert.deepEqual(
    reconcileGeneratedNode(current, "manual draft", generation("completed"), saved),
    { node: saved, draft: "manual draft" },
  );
  assert.deepEqual(
    reconcileGeneratedNode(current, "manual draft", generation("conflict"), saved),
    { node: current, draft: "manual draft" },
  );
});

test("automatic patch refreshes a clean editor but preserves a dirty draft", () => {
  const current = node("old", 1);
  const saved = node("patched", 2);
  assert.deepEqual(reconcileSavedNode(current, "old", saved), { node: saved, draft: "patched" });
  assert.deepEqual(
    reconcileSavedNode(current, "manual draft", saved),
    { node: saved, draft: "manual draft" },
  );
  assert.deepEqual(
    reconcileSavedNode(saved, "new", current),
    { node: saved, draft: "new" },
  );
});

test("only the active generation may apply a terminal event", () => {
  assert.equal(isCurrentGenerationEvent("generation-2", "generation-2"), true);
  assert.equal(isCurrentGenerationEvent("generation-2", "generation-1"), false);
  assert.equal(isCurrentGenerationEvent(null, "generation-1"), false);
});

test("a completed generation cannot roll the editor back to an older revision", () => {
  const current = node("current", 3);
  const stale = node("stale", 2);
  assert.deepEqual(
    reconcileGeneratedNode(current, "current", generation("completed"), stale),
    { node: current, draft: "current" },
  );
});
