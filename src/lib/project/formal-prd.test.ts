import { describe, expect, it } from "vitest";
import {
  lintFormalPrdMarkdown,
  serializeBlueprint,
  validateBlueprint,
  validateDraft,
} from "./formal-prd";

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

  it("serializeBlueprint hides rationale from rendered view but keeps it in a comment", () => {
    const md = serializeBlueprint({
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
    });
    // rationale preserved as an HTML comment in stored markdown
    expect(md).toContain("<!--");
    expect(md).toContain("向外部说明已确认的建设目标");
    // visible heading line and section title present
    expect(md).toContain("# 正式 PRD 导出蓝图");
    expect(md).toContain("执行摘要");
    // source mapping recorded deterministically
    expect(md).toContain("goals");
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