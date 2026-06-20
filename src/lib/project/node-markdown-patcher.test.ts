import { describe, expect, it } from "vitest";
import {
  UnpatchableError,
  applyPartialPatchForPreview,
  applyPatches,
  validateNodeMarkdownPatch,
} from "./node-markdown-patcher";
import type { NodeMarkdownPatch, WorkflowNodeId } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validPatch: NodeMarkdownPatch = {
  category: "confirmed_fact",
  targetSectionKey: "confirmed",
  patchKind: "append_bullet",
  markdown: "客户管理模块支持增删改查",
  evidence: { source: "user", quote: "用户说需要客户管理" },
};

const featureDesignId: WorkflowNodeId = "feature-design";

// ---------------------------------------------------------------------------
// validateNodeMarkdownPatch
// ---------------------------------------------------------------------------

describe("validateNodeMarkdownPatch", () => {
  it("accepts a valid patch", () => {
    const result = validateNodeMarkdownPatch(featureDesignId, validPatch);
    expect(result).toEqual(validPatch);
  });

  it("rejects an unknown sectionKey", () => {
    expect(() =>
      validateNodeMarkdownPatch(featureDesignId, {
        ...validPatch,
        targetSectionKey: "nonexistent",
      }),
    ).toThrow(UnpatchableError);
  });

  it("rejects an invalid patchKind for the section", () => {
    // "assumptions" only allows append_bullet, not append_table_row
    expect(() =>
      validateNodeMarkdownPatch(featureDesignId, {
        ...validPatch,
        targetSectionKey: "assumptions",
        patchKind: "append_table_row",
      }),
    ).toThrow(UnpatchableError);
  });

  it("rejects markdown containing a heading line", () => {
    expect(() =>
      validateNodeMarkdownPatch(featureDesignId, {
        ...validPatch,
        markdown: "## subheading\n- foo",
      }),
    ).toThrow(UnpatchableError);
  });

  it("rejects missing evidence", () => {
    expect(() =>
      validateNodeMarkdownPatch(featureDesignId, {
        ...validPatch,
        evidence: undefined,
      }),
    ).toThrow(UnpatchableError);
  });

  it("rejects wrong category", () => {
    expect(() =>
      validateNodeMarkdownPatch(featureDesignId, {
        ...validPatch,
        category: "invalid_category",
      }),
    ).toThrow(UnpatchableError);
  });

  it("rejects empty markdown", () => {
    expect(() =>
      validateNodeMarkdownPatch(featureDesignId, {
        ...validPatch,
        markdown: "",
      }),
    ).toThrow(UnpatchableError);
  });

  it("rejects non-object input", () => {
    expect(() => validateNodeMarkdownPatch(featureDesignId, null)).toThrow(UnpatchableError);
    expect(() => validateNodeMarkdownPatch(featureDesignId, "string")).toThrow(UnpatchableError);
    expect(() => validateNodeMarkdownPatch(featureDesignId, 42)).toThrow(UnpatchableError);
  });
});

// ---------------------------------------------------------------------------
// applyPatches
// ---------------------------------------------------------------------------

describe("applyPatches", () => {
  it("returns original markdown for empty patches array", () => {
    const md = "# Test\n\nSome content";
    const result = applyPatches(featureDesignId, md, []);
    expect(result.markdown).toBe(md);
    expect(result.applied).toEqual([]);
  });

  it("inserts a bullet and preserves prefix/suffix byte-for-byte unchanged", () => {
    const prefix = "# 5. 功能模块设计\n\nSome intro text.\n\n";
    const suffix = "\n\n## 设计假设\n\n- 假设1\n\n## 待确认问题\n\n- 问题1\n";
    const md = prefix + "## 已确认内容\n\n- 已有项\n" + suffix;

    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "confirmed",
        patchKind: "append_bullet",
        markdown: "新确认项",
        evidence: { source: "user", quote: "test" },
      },
    ]);

    // Prefix and suffix unchanged
    expect(result.markdown.startsWith(prefix)).toBe(true);
    expect(result.markdown.endsWith(suffix)).toBe(true);
    // The new bullet appears in the section
    expect(result.markdown).toContain("- 新确认项");
    expect(result.applied).toHaveLength(1);
  });

  it("throws UnpatchableError for two same-level same-name headings", () => {
    const md =
      "# 5. 功能模块设计\n\n## 已确认内容\n\n- 项1\n\n## 已确认内容\n\n- 项2\n\n## 设计假设\n\n- 假设1\n";
    expect(() =>
      applyPatches(featureDesignId, md, [
        {
          category: "confirmed_fact",
          targetSectionKey: "confirmed",
          patchKind: "append_bullet",
          markdown: "新项",
          evidence: { source: "user", quote: "test" },
        },
      ]),
    ).toThrow(UnpatchableError);
  });

  it("does not confuse setext heading with ATX heading", () => {
    // Setext H1 "Foo\n====" should not interfere with "## 设计假设"
    const md =
      "Foo\n====\n\nSome text\n\n## 设计假设\n\n- 假设1\n\n## 待确认问题\n\n- 问题1\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "assumption",
        targetSectionKey: "assumptions",
        patchKind: "append_bullet",
        markdown: "新假设",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    expect(result.markdown).toContain("- 新假设");
    // The setext heading content is preserved
    expect(result.markdown).toContain("Foo\n====");
  });

  it("does not treat heading-like lines inside fenced code blocks as headings", () => {
    const md =
      "## 设计假设\n\n- 假设1\n\n```\n## not a heading\n```\n\n## 待确认问题\n\n- 问题1\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "assumption",
        targetSectionKey: "assumptions",
        patchKind: "append_bullet",
        markdown: "新假设",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    expect(result.markdown).toContain("- 新假设");
    // Code fence content unchanged
    expect(result.markdown).toContain("## not a heading");
  });

  it("creates a missing required section in correct schema-order position", () => {
    // Markdown has "已确认内容" and "模块详情" but no "功能模块清单"
    const md =
      "# 5. 功能模块设计\n\n## 已确认内容\n\n- 项1\n\n## 模块详情\n\nSome details\n\n## 设计假设\n\n- 假设1\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "module_list",
        patchKind: "append_table_row",
        markdown: "| 客户管理 | 管理客户档案 | P0 |",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    // The new section should appear BEFORE "模块详情" (schema order: confirmed, module_list, module_details)
    const moduleListIndex = result.markdown.indexOf("## 功能模块清单");
    const moduleDetailsIndex = result.markdown.indexOf("## 模块详情");
    expect(moduleListIndex).toBeGreaterThan(0);
    expect(moduleDetailsIndex).toBeGreaterThan(moduleListIndex);
    // Table header and separator should be present
    expect(result.markdown).toContain("| 模块名 | 职责一句话 | 优先级(P0/P1/P2) |");
    expect(result.markdown).toContain("| --- | --- | --- |");
    expect(result.markdown).toContain("| 客户管理 | 管理客户档案 | P0 |");
  });

  it("generates a new table with header, separator, and first data row", () => {
    const md =
      "# 5. 功能模块设计\n\n## 已确认内容\n\n- 项1\n\n## 功能模块清单\n\n(empty)\n\n## 模块详情\n\nDetails\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "module_list",
        patchKind: "append_table_row",
        markdown: "| 客户管理 | 管理客户档案 | P0 |",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    expect(result.markdown).toContain("| 模块名 | 职责一句话 | 优先级(P0/P1/P2) |");
    expect(result.markdown).toContain("| --- | --- | --- |");
    expect(result.markdown).toContain("| 客户管理 | 管理客户档案 | P0 |");
  });

  it("appends a row to an existing GFM table", () => {
    const md =
      "# 5. 功能模块设计\n\n## 功能模块清单\n\n| 模块名 | 职责一句话 | 优先级(P0/P1/P2) |\n| --- | --- | --- |\n| 用户管理 | 管理用户 | P0 |\n\n## 模块详情\n\nDetails\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "module_list",
        patchKind: "append_table_row",
        markdown: "| 客户管理 | 管理客户档案 | P0 |",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    // Header and first row unchanged
    expect(result.markdown).toContain("| 模块名 | 职责一句话 | 优先级(P0/P1/P2) |");
    expect(result.markdown).toContain("| 用户管理 | 管理用户 | P0 |");
    // New row appended
    expect(result.markdown).toContain("| 客户管理 | 管理客户档案 | P0 |");
    // The new row should be after the first data row
    const firstRowIdx = result.markdown.indexOf("| 用户管理 | 管理用户 | P0 |");
    const newRowIdx = result.markdown.indexOf("| 客户管理 | 管理客户档案 | P0 |");
    expect(newRowIdx).toBeGreaterThan(firstRowIdx);
  });

  it("throws UnpatchableError for column count mismatch", () => {
    const md =
      "# 5. 功能模块设计\n\n## 功能模块清单\n\n| 模块名 | 职责一句话 | 优先级(P0/P1/P2) |\n| --- | --- | --- |\n| 用户管理 | 管理用户 | P0 |\n\n## 模块详情\n\nDetails\n";
    expect(() =>
      applyPatches(featureDesignId, md, [
        {
          category: "confirmed_fact",
          targetSectionKey: "module_list",
          patchKind: "append_table_row",
          markdown: "| 客户管理 | P0 |", // Only 2 columns, needs 3
          evidence: { source: "user", quote: "test" },
        },
      ]),
    ).toThrow(UnpatchableError);
  });

  it("rejects fragment containing a heading line", () => {
    expect(() =>
      applyPatches(featureDesignId, "## 已确认内容\n\n- 项1\n", [
        {
          category: "confirmed_fact",
          targetSectionKey: "confirmed",
          patchKind: "append_bullet",
          markdown: "## subheading\n- foo",
          evidence: { source: "user", quote: "test" },
        },
      ]),
    ).toThrow(UnpatchableError);
  });

  it("rejects invalid patchKind for a bullet-only section", () => {
    const md =
      "# 5. 功能模块设计\n\n## 设计假设\n\n- 假设1\n\n## 待确认问题\n\n- 问题1\n";
    expect(() =>
      applyPatches(featureDesignId, md, [
        {
          category: "assumption",
          targetSectionKey: "assumptions",
          patchKind: "append_table_row",
          markdown: "| col1 | col2 | col3 |",
          evidence: { source: "user", quote: "test" },
        },
      ]),
    ).toThrow(UnpatchableError);
  });

  it("deduplicates bullets", () => {
    const md =
      "# 5. 功能模块设计\n\n## 已确认内容\n\n- 客户管理\n\n## 设计假设\n\n- 假设1\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "confirmed",
        patchKind: "append_bullet",
        markdown: "- 客户管理",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    // The bullet should be deduped — only one occurrence
    const bulletMatches = result.markdown.match(/- 客户管理/g);
    expect(bulletMatches).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
  });

  it("deduplicates table rows", () => {
    const md =
      "# 5. 功能模块设计\n\n## 功能模块清单\n\n| 模块名 | 职责一句话 | 优先级(P0/P1/P2) |\n| --- | --- | --- |\n| 客户管理 | 管理客户档案 | P0 |\n\n## 模块详情\n\nDetails\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "module_list",
        patchKind: "append_table_row",
        markdown: "| 客户管理 | 管理客户档案 | P0 |",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    // Only one occurrence of the row
    const rowMatches = result.markdown.match(/\| 客户管理 \| 管理客户档案 \| P0 \|/g);
    expect(rowMatches).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
  });

  it("preserves Chinese headings and content verbatim", () => {
    const md =
      "# 5. 功能模块设计\n\n## 已确认内容\n\n- 已有项\n\n## 设计假设\n\n- 假设1\n\n## 待确认问题\n\n- 问题1\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "confirmed",
        patchKind: "append_bullet",
        markdown: "中文内容测试",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    expect(result.markdown).toContain("## 已确认内容");
    expect(result.markdown).toContain("- 中文内容测试");
    expect(result.markdown).toContain("## 设计假设");
    expect(result.markdown).toContain("- 假设1");
  });

  it("applies multiple patches in order", () => {
    const md =
      "# 5. 功能模块设计\n\n## 已确认内容\n\n- 项1\n\n## 设计假设\n\n- 假设1\n\n## 待确认问题\n\n- 问题1\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "confirmed",
        patchKind: "append_bullet",
        markdown: "新项1",
        evidence: { source: "user", quote: "test" },
      },
      {
        category: "confirmed_fact",
        targetSectionKey: "confirmed",
        patchKind: "append_bullet",
        markdown: "新项2",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    expect(result.markdown).toContain("- 新项1");
    expect(result.markdown).toContain("- 新项2");
    expect(result.applied).toHaveLength(2);
  });

  it("appends a block to a section", () => {
    const md =
      "# 5. 功能模块设计\n\n## 已确认内容\n\n- 项1\n\n## 模块详情\n\nExisting block content.\n\n## 设计假设\n\n- 假设1\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "module_details",
        patchKind: "append_block",
        markdown: "New block paragraph.",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    expect(result.markdown).toContain("New block paragraph.");
    // Existing content preserved
    expect(result.markdown).toContain("Existing block content.");
  });

  it("deduplicates blocks", () => {
    const md =
      "# 5. 功能模块设计\n\n## 模块详情\n\nExisting block content.\n\n## 设计假设\n\n- 假设1\n";
    const result = applyPatches(featureDesignId, md, [
      {
        category: "confirmed_fact",
        targetSectionKey: "module_details",
        patchKind: "append_block",
        markdown: "Existing block content.",
        evidence: { source: "user", quote: "test" },
      },
    ]);
    // Only one occurrence
    const matches = result.markdown.match(/Existing block content\./g);
    expect(matches).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyPartialPatchForPreview
// ---------------------------------------------------------------------------

describe("applyPartialPatchForPreview", () => {
  it("shows partial text at the insertion point for a bullet patch", () => {
    const md =
      "# 5. 功能模块设计\n\n## 已确认内容\n\n- 已有项\n\n## 设计假设\n\n- 假设1\n";
    const patch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "confirmed",
      patchKind: "append_bullet",
      markdown: "新确认项",
      evidence: { source: "user", quote: "test" },
    };

    // visibleCharacterCount=0: just the "- " prefix
    const frame0 = applyPartialPatchForPreview(featureDesignId, md, patch, 0);
    expect(frame0).toContain("- ");
    expect(frame0).not.toContain("新确认项");

    // visibleCharacterCount=2: "- 新"
    const frame2 = applyPartialPatchForPreview(featureDesignId, md, patch, 2);
    expect(frame2).toContain("- 新");

    // visibleCharacterCount=full: same as applyPatches
    const full = applyPartialPatchForPreview(featureDesignId, md, patch, 999);
    const applied = applyPatches(featureDesignId, md, [patch]);
    expect(full).toBe(applied.markdown);
  });

  it("shows partial text for a block patch", () => {
    const md =
      "# 5. 功能模块设计\n\n## 模块详情\n\nExisting.\n\n## 设计假设\n\n- 假设1\n";
    const patch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "module_details",
      patchKind: "append_block",
      markdown: "New block text here",
      evidence: { source: "user", quote: "test" },
    };

    const frame0 = applyPartialPatchForPreview(featureDesignId, md, patch, 0);
    expect(frame0).not.toContain("New block text here");

    const frame5 = applyPartialPatchForPreview(featureDesignId, md, patch, 5);
    expect(frame5).toContain("New b");

    const full = applyPartialPatchForPreview(featureDesignId, md, patch, 999);
    const applied = applyPatches(featureDesignId, md, [patch]);
    expect(full).toBe(applied.markdown);
  });

  it("shows partial text for a table row patch", () => {
    const md =
      "# 5. 功能模块设计\n\n## 功能模块清单\n\n(empty)\n\n## 模块详情\n\nDetails\n";
    const patch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "module_list",
      patchKind: "append_table_row",
      markdown: "| 客户管理 | 管理客户档案 | P0 |",
      evidence: { source: "user", quote: "test" },
    };

    // visibleCharacterCount=0: table header + separator + empty row
    const frame0 = applyPartialPatchForPreview(featureDesignId, md, patch, 0);
    expect(frame0).toContain("| 模块名 | 职责一句话 | 优先级(P0/P1/P2) |");
    expect(frame0).toContain("| --- | --- | --- |");
    // Row should be empty or just the pipe structure
    expect(frame0).toContain("|");

    // visibleCharacterCount=full: same as applyPatches
    const full = applyPartialPatchForPreview(featureDesignId, md, patch, 999);
    const applied = applyPatches(featureDesignId, md, [patch]);
    expect(full).toBe(applied.markdown);
  });
});
