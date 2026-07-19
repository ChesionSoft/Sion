import assert from "node:assert/strict";
import test from "node:test";
import {
  appendLiveReasoning,
  clearLiveReasoning,
  removeLiveReasoning,
} from "../src/reasoning-stream.ts";

const scope = { projectId: "p", nodeId: "goals", sessionId: "s" } as const;

test("appends only matching scoped public reasoning", () => {
  const matching = {
    runId: "r",
    projectId: "p",
    nodeId: "goals",
    sessionId: "s",
    delta: "公开",
  } as const;
  assert.deepEqual(appendLiveReasoning({}, matching, scope), { r: "公开" });
  assert.deepEqual(
    appendLiveReasoning({}, { ...matching, sessionId: "other" }, scope),
    {},
  );
});

test("preserves complete live reasoning beyond 2000 Unicode characters", () => {
  const completeReasoning = `${"思".repeat(2_500)}${"🧭".repeat(10)}`;
  const event = {
    runId: "r",
    projectId: "p",
    nodeId: "goals",
    sessionId: "s",
    delta: completeReasoning,
  } as const;

  const next = appendLiveReasoning({}, event, scope);

  assert.equal(next.r, completeReasoning);
  assert.equal([...next.r].length, 2_510);
});

test("clears one terminal run or the whole navigation scope", () => {
  assert.deepEqual(removeLiveReasoning({ a: "A", b: "B" }, "a"), { b: "B" });
  assert.deepEqual(clearLiveReasoning(), {});
});
