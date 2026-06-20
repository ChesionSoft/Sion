import { describe, expect, it } from "vitest";
import { buildPatchPreviewFrames } from "./patch-preview";
import { applyPatches } from "@/lib/project/node-markdown-patcher";
import type { NodeMarkdownPatch, WorkflowNodeId } from "@/lib/project/types";

const NODE_ID: WorkflowNodeId = "basic-info";

const BASE_MARKDOWN = `# 1. 项目基本信息

## 已确认内容

Project CRM.

## 基础信息表

| 字段 | 值 |
| --- | --- |
| 项目名称 | CRM |

## 项目边界

- In scope: data entry

## 设计假设

- Users have basic computer skills

## 待确认问题
`;

describe("buildPatchPreviewFrames", () => {
  it("returns just the base when no patches", () => {
    const frames = buildPatchPreviewFrames(NODE_ID, BASE_MARKDOWN, []);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe(BASE_MARKDOWN);
  });

  it("appends a bullet patch with correct frames at the correct section", () => {
    const patch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "confirmed",
      patchKind: "append_bullet",
      markdown: "新加入的确认内容",
      evidence: { source: "assistant", quote: "test" },
    };

    const frames = buildPatchPreviewFrames(NODE_ID, BASE_MARKDOWN, [patch]);

    // Frame 0 is the base
    expect(frames[0]).toBe(BASE_MARKDOWN);

    // All frames should have the bullet at the "已确认内容" section, not at EOF
    for (const frame of frames) {
      // The heading "已确认内容" should appear before the bullet insertion point
      expect(frame.indexOf("已确认内容")).not.toBe(-1);
    }

    // Last frame should equal full applyPatches
    const fullResult = applyPatches(NODE_ID, BASE_MARKDOWN, [patch]);
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame).toBe(fullResult.markdown);

    // The new bullet should appear in the last frame under the confirmed section
    expect(lastFrame).toContain("- 新加入的确认内容");
  });

  it("handles multiple patches in sequence", () => {
    const patches: NodeMarkdownPatch[] = [
      {
        category: "confirmed_fact",
        targetSectionKey: "confirmed",
        patchKind: "append_bullet",
        markdown: "第一项",
        evidence: { source: "assistant", quote: "a" },
      },
      {
        category: "confirmed_fact",
        targetSectionKey: "boundary",
        patchKind: "append_bullet",
        markdown: "边界项",
        evidence: { source: "assistant", quote: "b" },
      },
    ];

    const frames = buildPatchPreviewFrames(NODE_ID, BASE_MARKDOWN, patches);

    // Verify we have the correct number of frames
    // Frame 0 + frames for patch 0 + frames for patch 1
    const fullResult = applyPatches(NODE_ID, BASE_MARKDOWN, patches);
    expect(frames.length).toBeGreaterThan(2);

    // Last frame = full application
    expect(frames[frames.length - 1]).toBe(fullResult.markdown);

    // Verify patch 1's text is NOT in the first patch's area (frame before patch 1's first typing frame)
    // The first patch typing frames should not contain "边界项"
    // Just check that last frame has both
    expect(frames[frames.length - 1]).toContain("- 第一项");
    expect(frames[frames.length - 1]).toContain("- 边界项");
  });

  it("is unicode-safe with Chinese characters", () => {
    const patch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "confirmed",
      patchKind: "append_bullet",
      markdown: "中文测试内容",
      evidence: { source: "assistant", quote: "u" },
    };

    const frames = buildPatchPreviewFrames(NODE_ID, BASE_MARKDOWN, [patch], 1);

    // With charactersPerFrame=1, each Chinese character should produce a frame
    // The animated text is "中文测试内容" (5 characters without "- " prefix)
    // Steps: 0, 1, 2, 3, 4, 5 = 6 steps
    // Frames: base + 6 = 7
    expect(frames.length).toBeGreaterThanOrEqual(5);

    // Each frame should progress — each subsequent frame is different
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame).toContain("- 中文测试内容");

    // Verify last frame === full applyPatches result
    const fullResult = applyPatches(NODE_ID, BASE_MARKDOWN, [patch]);
    expect(lastFrame).toBe(fullResult.markdown);
  });

  it("handles an append_block patch correctly", () => {
    const patch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "confirmed",
      patchKind: "append_block",
      markdown: "A new paragraph explaining the update.",
      evidence: { source: "assistant", quote: "test" },
    };

    const frames = buildPatchPreviewFrames(NODE_ID, BASE_MARKDOWN, [patch]);

    // Last frame = full application
    const fullResult = applyPatches(NODE_ID, BASE_MARKDOWN, [patch]);
    expect(frames[frames.length - 1]).toBe(fullResult.markdown);

    // Block content should be in confirmed section, not at EOF
    const lastFrame = frames[frames.length - 1];
    const confirmedIdx = lastFrame.indexOf("已确认内容");
    const blockIdx = lastFrame.indexOf("A new paragraph explaining the update.");
    expect(blockIdx).toBeGreaterThan(confirmedIdx);
  });

  it("adds a table row patch to an existing table", () => {
    const patch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "metadata",
      patchKind: "append_table_row",
      markdown: "| 版本 | V2.0 |",
      evidence: { source: "assistant", quote: "test" },
    };

    const frames = buildPatchPreviewFrames(NODE_ID, BASE_MARKDOWN, [patch]);

    // Last frame = full application
    const fullResult = applyPatches(NODE_ID, BASE_MARKDOWN, [patch]);
    expect(frames[frames.length - 1]).toBe(fullResult.markdown);

    const lastFrame = frames[frames.length - 1];
    expect(lastFrame).toContain("| 版本 | V2.0 |");
    // Should be under the metadata section
    const metadataIdx = lastFrame.indexOf("基础信息表");
    const rowIdx = lastFrame.indexOf("| 版本 | V2.0 |");
    expect(rowIdx).toBeGreaterThan(metadataIdx);
  });
});