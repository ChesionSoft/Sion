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

test("bounds live reasoning to 2000 Unicode characters", () => {
  const event = {
    runId: "r",
    projectId: "p",
    nodeId: "goals",
    sessionId: "s",
    delta: "思".repeat(2001),
  } as const;
  assert.equal([...appendLiveReasoning({}, event, scope).r].length, 2000);
});

test("clears one terminal run or the whole navigation scope", () => {
  assert.deepEqual(removeLiveReasoning({ a: "A", b: "B" }, "a"), { b: "B" });
  assert.deepEqual(clearLiveReasoning(), {});
});
