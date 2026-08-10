import assert from "node:assert/strict";
import test from "node:test";

import { lineDiff, lineDiffWithNumbers } from "../src/export-diff.ts";

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

test("numbered line diff tracks old and new line numbers", () => {
  assert.deepEqual(lineDiffWithNumbers("a\nb", "a\nc"), [
    { kind: "same", text: "a", oldLine: 1, newLine: 1 },
    { kind: "remove", text: "b", oldLine: 2, newLine: null },
    { kind: "add", text: "c", oldLine: null, newLine: 2 },
  ]);
});

test("numbered line diff handles added and removed tails", () => {
  assert.deepEqual(lineDiffWithNumbers("a\nb", "a\nb\nc"), [
    { kind: "same", text: "a", oldLine: 1, newLine: 1 },
    { kind: "same", text: "b", oldLine: 2, newLine: 2 },
    { kind: "add", text: "c", oldLine: null, newLine: 3 },
  ]);
  assert.deepEqual(lineDiffWithNumbers("a\nb\nc", "a\nb"), [
    { kind: "same", text: "a", oldLine: 1, newLine: 1 },
    { kind: "same", text: "b", oldLine: 2, newLine: 2 },
    { kind: "remove", text: "c", oldLine: 3, newLine: null },
  ]);
});

test("numbered line diff stays additive to plain lineDiff", () => {
  const before = "x\ny\nz";
  const after = "x\nz\nw";
  assert.deepEqual(
    lineDiffWithNumbers(before, after).map(({ kind, text }) => ({ kind, text })),
    lineDiff(before, after),
  );
});
test("unchanged content produces only context rows with aligned line numbers", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nb"), [
    { kind: "same", text: "a" },
    { kind: "same", text: "b" },
  ]);
  assert.deepEqual(lineDiffWithNumbers("a\nb", "a\nb"), [
    { kind: "same", text: "a", oldLine: 1, newLine: 1 },
    { kind: "same", text: "b", oldLine: 2, newLine: 2 },
  ]);
});

test("empty inputs diff as all-removes or all-adds respectively", () => {
  assert.deepEqual(lineDiff("", "x\ny"), [
    { kind: "add", text: "x" },
    { kind: "add", text: "y" },
  ]);
  assert.deepEqual(lineDiff("x\ny", ""), [
    { kind: "remove", text: "x" },
    { kind: "remove", text: "y" },
  ]);
});
