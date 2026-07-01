import { describe, expect, it } from "vitest";
import { stripToolCallLeakage } from "./tool-call-strip";

// Build the proprietary leakage markers from parts so this source file does
// not contain the contiguous literal sequences. The real model emits a
// bracketed model-name marker, a tool-call sentinel, then an XML-ish
// tool-name / parameters block at the end of an otherwise clean answer.
const MARKER_A = "]" + "<]" + "minimax" + "[>";
const SENTINEL = "【" + "tool_call" + "】";
const TN_OPEN = "<" + "tool_name" + ">";
const TN_CLOSE = "</" + "tool_name" + ">";
const P_OPEN = "<" + "parameters" + ">";
const P_CLOSE = "</" + "parameters" + ">";

const CLEAN = "# 模块清单\n\n| 模块 | 职责 |\n|---|---|\n| 合同 | 提取 |";

describe("stripToolCallLeakage", () => {
  it("returns clean content unchanged", () => {
    expect(stripToolCallLeakage(CLEAN)).toBe(CLEAN);
  });

  it("returns empty string unchanged", () => {
    expect(stripToolCallLeakage("")).toBe("");
  });

  it("cuts everything from the bracketed model-name marker", () => {
    const leaked = CLEAN + "\n" + MARKER_A + SENTINEL + TN_OPEN + "ask_user_question" + TN_CLOSE;
    expect(stripToolCallLeakage(leaked)).toBe(CLEAN);
  });

  it("cuts everything from a bare tool-name tag", () => {
    const leaked = CLEAN + TN_OPEN + "ask_user_question" + TN_CLOSE + P_OPEN + P_CLOSE;
    expect(stripToolCallLeakage(leaked)).toBe(CLEAN);
  });

  it("cuts everything from a parameters tag", () => {
    const leaked = CLEAN + P_OPEN + "x" + P_CLOSE;
    expect(stripToolCallLeakage(leaked)).toBe(CLEAN);
  });

  it("trims trailing whitespace left behind after the cut", () => {
    const leaked = CLEAN + "\n\n  \n" + MARKER_A + "junk";
    expect(stripToolCallLeakage(leaked)).toBe(CLEAN);
  });

  it("keeps the answer text that precedes the marker", () => {
    const prefix = "在正式落稿前，有 3 个问题需要你确认后我才能写定稿：";
    const leaked = prefix + MARKER_A + SENTINEL + TN_OPEN + "ask_user_question" + TN_CLOSE + P_OPEN;
    expect(stripToolCallLeakage(leaked)).toBe(prefix);
  });
});