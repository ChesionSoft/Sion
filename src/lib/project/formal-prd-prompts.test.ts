import { describe, expect, it } from "vitest";
import {
  buildBlueprintSystemPrompt,
  buildBlueprintUserPrompt,
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  parseModelJson,
} from "./formal-prd-prompts";
import type { FormalPrdBlueprint } from "./formal-prd";
import type { Project, ProjectNode, WorkflowNodeId } from "./types";

const project: Project = {
  id: "p1",
  name: "库存管理",
  customerName: "示例客户",
  authorName: "示例团队",
  version: "v0.1",
  createdAt: "2026-06-14T10:00:00.000Z",
  updatedAt: "2026-06-14T10:00:00.000Z",
};

function node(id: WorkflowNodeId, markdown: string, status: ProjectNode["status"] = "confirmed"): ProjectNode {
  return { id, status, markdown, revision: 1, updatedAt: "2026-06-14T10:00:00.000Z" };
}

describe("buildBlueprintSystemPrompt", () => {
  it("tells the blueprint model to omit open questions instead of exposing them", () => {
    const p = buildBlueprintSystemPrompt();
    expect(p).toContain("未确认内容默认 omit");
    expect(p).not.toContain("归入待确认");
  });

  it("demands source mapping on every included section", () => {
    const p = buildBlueprintSystemPrompt();
    expect(p).toContain("sourceNodeIds");
    expect(p).toContain("inclusion");
    expect(p).toContain("presentation");
  });

  it("forbids inventing facts and process noise", () => {
    const p = buildBlueprintSystemPrompt();
    expect(p).toContain("不得新增产品事实");
    expect(p).toContain("omit");
  });
});

describe("buildBlueprintUserPrompt", () => {
  it("includes project meta and every non-final-export node body", () => {
    const prompt = buildBlueprintUserPrompt(project, [
      node("basic-info", "# 项目基本信息\n\n## 背景\n\n这是已确认背景。"),
      node("final-export", "# 最终文档生成\n\n- 检查项"),
    ]);
    expect(prompt).toContain("库存管理");
    expect(prompt).toContain("这是已确认背景。");
    // final-export node is the curator itself, never a source
    expect(prompt).not.toContain("检查项");
  });
});

describe("buildDraftSystemPrompt", () => {
  it("writes only from approved blueprint facts and forbids process noise", () => {
    const p = buildDraftSystemPrompt();
    expect(p).toContain("蓝图");
    expect(p).toContain("不得输出待确认");
  });

  it("prescribes table and flow forms", () => {
    const p = buildDraftSystemPrompt();
    expect(p).toContain("表格");
    expect(p).toContain("flow");
  });
});

describe("buildDraftUserPrompt", () => {
  const blueprint: FormalPrdBlueprint = {
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
  };

  it("includes the approved blueprint and the referenced source node bodies", () => {
    const prompt = buildDraftUserPrompt(blueprint, [
      node("goals", "# 需求背景与建设目标\n\n## 总体目标\n\n目标 A。"),
      node("basic-info", "# 项目基本信息\n\n## 背景\n\n其他。"),
    ]);
    expect(prompt).toContain("执行摘要");
    expect(prompt).toContain("目标 A。");
    // a non-referenced node must not be fed as a draft source
    expect(prompt).not.toContain("其他。");
  });

  it("excludes omitted and unconfirmed source nodes from the draft context", () => {
    const curatedBlueprint: FormalPrdBlueprint = {
      title: "正式 PRD 导出蓝图",
      sections: [
        {
          id: "included",
          title: "已纳入",
          inclusion: "confirmed",
          presentation: "paragraphs",
          sourceNodeIds: ["goals"],
          sourceHeadings: ["总体目标"],
          rationale: "r",
        },
        {
          id: "omitted",
          title: "不纳入",
          inclusion: "omit",
          presentation: "paragraphs",
          sourceNodeIds: ["risks-open-questions"],
          sourceHeadings: ["开放问题"],
          rationale: "r",
        },
        {
          id: "unconfirmed",
          title: "未确认",
          inclusion: "confirmed-summary",
          presentation: "paragraphs",
          sourceNodeIds: ["basic-info"],
          sourceHeadings: ["背景"],
          rationale: "r",
        },
      ],
    };

    const prompt = buildDraftUserPrompt(curatedBlueprint, [
      node("goals", "# 目标\n\n已确认目标。"),
      node("risks-open-questions", "# 风险\n\n不得外发的风险。"),
      node("basic-info", "# 基本信息\n\n尚未确认的背景。", "needs_confirmation"),
    ]);

    expect(prompt).toContain("已确认目标。");
    expect(prompt).not.toContain("不得外发的风险。");
    expect(prompt).not.toContain("尚未确认的背景。");
  });
});

describe("parseModelJson", () => {
  it("parses only one fenced JSON payload", () => {
    expect(parseModelJson('```json\n{"title":"x","sections":[]}\n```')).toEqual({ title: "x", sections: [] });
    expect(() => parseModelJson("先解释，再给 JSON")).toThrow("有效 JSON");
  });

  it("throws when there is more than one fenced block", () => {
    expect(() => parseModelJson('```json\n{"a":1}\n```\n```json\n{"b":2}\n```')).toThrow("有效 JSON");
  });

  it("throws when the fenced content is not valid JSON", () => {
    expect(() => parseModelJson('```json\nnot json\n```')).toThrow("有效 JSON");
  });

  it("accepts a bare JSON object as the whole payload", () => {
    expect(parseModelJson('{"title":"y","sections":[]}')).toEqual({ title: "y", sections: [] });
  });
});
