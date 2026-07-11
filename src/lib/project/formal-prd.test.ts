import { describe, expect, it } from "vitest";
import {
  applyBlueprintPatches,
  lintFormalPrdMarkdown,
  parseBlueprint,
  serializeBlueprint,
  validateBlueprint,
  validateBlueprintPatch,
  validateDraft,
  validateDraftPatch,
} from "./formal-prd";
import type { FormalPrdBlueprint } from "./formal-prd";

const twoSectionBlueprint: FormalPrdBlueprint = {
  title: "正式 PRD 导出蓝图",
  sections: [
    {
      id: "executive-summary",
      title: "执行摘要",
      inclusion: "confirmed-summary",
      presentation: "paragraphs",
      sourceNodeIds: ["goals"],
      sourceHeadings: ["总体目标"],
      rationale: "向外部说明已确认的建设目标",
    },
    {
      id: "omitted-risks",
      title: "风险与开放问题",
      inclusion: "omit",
      presentation: "bullets",
      sourceNodeIds: [],
      sourceHeadings: [],
      rationale: "不对外披露",
    },
  ],
};

describe("formal PRD contracts", () => {
  it("accepts a source-mapped confirmed-summary section", () => {
    expect(() =>
      validateBlueprint({
        title: "正式 PRD 导出蓝图",
        sections: [
          {
            id: "executive-summary",
            title: "执行摘要",
            inclusion: "confirmed-summary",
            presentation: "paragraphs",
            sourceNodeIds: ["goals"],
            sourceHeadings: ["总体目标"],
            rationale: "向外部说明已确认的建设目标",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects unmapped material and process-noise phrases", () => {
    expect(() =>
      validateDraft({ markdown: "## 执行摘要\n\n待确认：补充客户名称。", sourceMap: [] }),
    ).toThrow();
    expect(lintFormalPrdMarkdown("## 范围\n\nTBD")).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "forbidden_phrase" })]),
    );
  });

  it("rejects a non-omit blueprint section with no source nodes", () => {
    expect(() =>
      validateBlueprint({
        title: "蓝图",
        sections: [
          {
            id: "x",
            title: "X",
            inclusion: "confirmed",
            presentation: "paragraphs",
            sourceNodeIds: [],
            sourceHeadings: [],
            rationale: "r",
          },
        ],
      }),
    ).toThrow();
  });

  it("allows an omit section with no source nodes", () => {
    expect(() =>
      validateBlueprint({
        title: "蓝图",
        sections: [
          {
            id: "x",
            title: "X",
            inclusion: "omit",
            presentation: "paragraphs",
            sourceNodeIds: [],
            sourceHeadings: [],
            rationale: "不对外披露",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a draft source-map entry with no source nodes", () => {
    expect(() =>
      validateDraft({
        markdown: "## 执行摘要\n\n已确认结论。",
        sourceMap: [{ sourceNodeIds: [], headings: ["执行摘要"] }],
      }),
    ).toThrow();
  });

  it("rejects invalid workflow node ids in source mapping", () => {
    expect(() =>
      validateBlueprint({
        title: "蓝图",
        sections: [
          {
            id: "x",
            title: "X",
            inclusion: "confirmed",
            presentation: "paragraphs",
            sourceNodeIds: ["not-a-real-node"],
            sourceHeadings: [],
            rationale: "r",
          },
        ],
      }),
    ).toThrow();
  });

  it("lint flags TBD/TODO/待确认/agent 建议/历史结论", () => {
    const issues = lintFormalPrdMarkdown("TBD\nTODO\n待确认\nagent 建议\n历史结论");
    expect(issues.length).toBeGreaterThanOrEqual(5);
    for (const issue of issues) expect(issue.code).toBe("forbidden_phrase");
  });

  it("does not flag clean confirmed prose", () => {
    expect(lintFormalPrdMarkdown("## 执行摘要\n\n项目目标已确认。")).toEqual([]);
  });

  it("serializeBlueprint emits visible metadata lines, not an HTML comment", () => {
    const md = serializeBlueprint(twoSectionBlueprint);
    // rationale is now a visible `- rationale:` line, no HTML comment
    expect(md).not.toContain("<!--");
    expect(md).toContain("# 正式 PRD 导出蓝图");
    expect(md).toContain("## 执行摘要");
    expect(md).toContain("- id: executive-summary");
    expect(md).toContain("- inclusion: confirmed-summary");
    expect(md).toContain("- presentation: paragraphs");
    expect(md).toContain("- source: goals");
    expect(md).toContain("- headings: 总体目标");
    expect(md).toContain("- rationale: 向外部说明已确认的建设目标");
  });

  it("serializeBlueprint records empty source/headings as a dash for an omit section", () => {
    const md = serializeBlueprint(twoSectionBlueprint);
    expect(md).toContain("- source: -");
    expect(md).toContain("- headings: -");
  });

  it("serializeBlueprint is deterministic across calls", () => {
    const blueprint = {
      title: "正式 PRD 导出蓝图",
      sections: [
        {
          id: "a",
          title: "A",
          inclusion: "confirmed" as const,
          presentation: "paragraphs" as const,
          sourceNodeIds: ["goals" as const],
          sourceHeadings: ["总体目标"],
          rationale: "r1",
        },
        {
          id: "b",
          title: "B",
          inclusion: "omit" as const,
          presentation: "bullets" as const,
          sourceNodeIds: [],
          sourceHeadings: [],
          rationale: "r2",
        },
      ],
    };
    expect(serializeBlueprint(blueprint)).toBe(serializeBlueprint(blueprint));
  });
});

describe("parseBlueprint (line format)", () => {
  it("round-trips a two-section blueprint including an omit section with empty arrays", () => {
    expect(parseBlueprint(serializeBlueprint(twoSectionBlueprint))).toEqual(twoSectionBlueprint);
  });

  it("throws when there is no level-1 title", () => {
    const md = [
      "## 执行摘要",
      "- id: x",
      "- inclusion: omit",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
    ].join("\n");
    expect(() => parseBlueprint(md)).toThrow();
  });

  it("throws when a section has no id", () => {
    const md = [
      "# 蓝图",
      "",
      "## 执行摘要",
      "- inclusion: omit",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
    ].join("\n");
    expect(() => parseBlueprint(md)).toThrow();
  });

  it("throws on an unknown metadata key", () => {
    const md = [
      "# 蓝图",
      "",
      "## 执行摘要",
      "- id: x",
      "- inclusion: omit",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
      "- bogus: y",
    ].join("\n");
    expect(() => parseBlueprint(md)).toThrow();
  });

  it("throws on a duplicate metadata key", () => {
    const md = [
      "# 蓝图",
      "",
      "## 执行摘要",
      "- id: x",
      "- inclusion: omit",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
      "- id: y",
    ].join("\n");
    expect(() => parseBlueprint(md)).toThrow();
  });

  it("throws on an invalid inclusion enum", () => {
    const md = [
      "# 蓝图",
      "",
      "## 执行摘要",
      "- id: x",
      "- inclusion: bogus",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
    ].join("\n");
    expect(() => parseBlueprint(md)).toThrow();
  });

  it("throws when a non-omit section maps to no source nodes", () => {
    const md = [
      "# 蓝图",
      "",
      "## 执行摘要",
      "- id: x",
      "- inclusion: confirmed",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
    ].join("\n");
    expect(() => parseBlueprint(md)).toThrow();
  });

  it("throws on prose between the metadata fields and the next section", () => {
    const md = [
      "# 蓝图",
      "",
      "## 执行摘要",
      "- id: x",
      "- inclusion: omit",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
      "这是不该出现的正文。",
      "",
      "## 其他",
      "- id: y",
      "- inclusion: omit",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
    ].join("\n");
    expect(() => parseBlueprint(md)).toThrow();
  });
});

describe("validateBlueprintPatch", () => {
  it("accepts add, remove, update, and reorder ops", () => {
    expect(() =>
      validateBlueprintPatch({
        artifactDigest: "d1",
        ops: [
          {
            op: "add",
            section: {
              id: "new",
              title: "新",
              inclusion: "omit",
              presentation: "paragraphs",
              sourceNodeIds: [],
              sourceHeadings: [],
              rationale: "r",
            },
            afterSectionId: "executive-summary",
          },
          { op: "remove", sectionId: "omitted-risks" },
          { op: "update", sectionId: "executive-summary", fields: { rationale: "新理由" } },
          { op: "reorder", sectionId: "executive-summary", afterSectionId: "new" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an empty artifactDigest", () => {
    expect(() =>
      validateBlueprintPatch({ artifactDigest: "", ops: [{ op: "remove", sectionId: "x" }] }),
    ).toThrow();
  });

  it("rejects an unknown operation name", () => {
    expect(() =>
      validateBlueprintPatch({ artifactDigest: "d", ops: [{ op: "bogus", sectionId: "x" }] }),
    ).toThrow();
  });

  it("rejects an invalid inclusion on an add section", () => {
    expect(() =>
      validateBlueprintPatch({
        artifactDigest: "d",
        ops: [
          {
            op: "add",
            section: {
              id: "new",
              title: "新",
              inclusion: "bogus",
              presentation: "paragraphs",
              sourceNodeIds: [],
              sourceHeadings: [],
              rationale: "r",
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an empty ops array", () => {
    expect(() => validateBlueprintPatch({ artifactDigest: "d", ops: [] })).toThrow();
  });
});

describe("applyBlueprintPatches", () => {
  it("applies add, update, and reorder in sequence and reports the new order", () => {
    const { blueprint, applied } = applyBlueprintPatches(twoSectionBlueprint, {
      artifactDigest: "d",
      ops: [
        {
          op: "add",
          section: {
            id: "new",
            title: "新",
            inclusion: "omit",
            presentation: "paragraphs",
            sourceNodeIds: [],
            sourceHeadings: [],
            rationale: "r",
          },
          afterSectionId: "executive-summary",
        },
        { op: "update", sectionId: "executive-summary", fields: { rationale: "新理由" } },
        { op: "reorder", sectionId: "executive-summary", afterSectionId: "omitted-risks" },
      ],
    });
    expect(applied.every((r) => r.status === "applied")).toBe(true);
    expect(blueprint.sections.map((s) => s.id)).toEqual(["new", "omitted-risks", "executive-summary"]);
    expect(blueprint.sections[2].rationale).toBe("新理由");
  });

  it("skips an unknown target id without affecting the other successful op", () => {
    const { blueprint, applied } = applyBlueprintPatches(twoSectionBlueprint, {
      artifactDigest: "d",
      ops: [
        { op: "remove", sectionId: "does-not-exist" },
        { op: "update", sectionId: "executive-summary", fields: { rationale: "改" } },
      ],
    });
    expect(applied).toHaveLength(2);
    expect(applied[0].status).toBe("skipped");
    expect(applied[0].reason).toBeTruthy();
    expect(applied[1].status).toBe("applied");
    expect(blueprint.sections.map((s) => s.id)).toEqual(["executive-summary", "omitted-risks"]);
    expect(blueprint.sections[0].rationale).toBe("改");
  });

  it("appends an add op when afterSectionId is omitted", () => {
    const { blueprint, applied } = applyBlueprintPatches(twoSectionBlueprint, {
      artifactDigest: "d",
      ops: [
        {
          op: "add",
          section: {
            id: "tail",
            title: "尾",
            inclusion: "omit",
            presentation: "paragraphs",
            sourceNodeIds: [],
            sourceHeadings: [],
            rationale: "r",
          },
        },
      ],
    });
    expect(applied[0].status).toBe("applied");
    expect(blueprint.sections.at(-1)?.id).toBe("tail");
  });
});

describe("validateDraftPatch", () => {
  it("accepts replace, remove, and insert ops", () => {
    expect(() =>
      validateDraftPatch({
        artifactDigest: "d1",
        ops: [
          { op: "replace", heading: "数据结构", body: "新内容" },
          { op: "remove", heading: "背景" },
          { op: "insert", heading: "新增", body: "正文", afterHeading: "数据结构" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an unknown operation", () => {
    expect(() => validateDraftPatch({ artifactDigest: "d", ops: [{ op: "bogus", heading: "x" }] })).toThrow();
  });

  it("rejects a missing digest", () => {
    expect(() => validateDraftPatch({ ops: [{ op: "remove", heading: "x" }] })).toThrow();
  });

  it("rejects a blank heading", () => {
    expect(() => validateDraftPatch({ artifactDigest: "d", ops: [{ op: "remove", heading: "" }] })).toThrow();
  });
});