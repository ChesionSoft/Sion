import assert from "node:assert/strict";
import test from "node:test";

import { lineDiff } from "../src/export-diff.ts";

test("line diff preserves stable and changed lines", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nc"), [
    { kind: "same", text: "a" },
    { kind: "remove", text: "b" },
    { kind: "add", text: "c" },
  ]);
});

test("line diff handles added and removed tails", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nb\nc"), [
    { kind: "same", text: "a" },
    { kind: "same", text: "b" },
    { kind: "add", text: "c" },
  ]);
  assert.deepEqual(lineDiff("a\nb\nc", "a\nb"), [
    { kind: "same", text: "a" },
    { kind: "same", text: "b" },
    { kind: "remove", text: "c" },
  ]);
});