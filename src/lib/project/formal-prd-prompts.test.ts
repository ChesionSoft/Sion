import { describe, expect, it } from "vitest";
import {
  buildBlueprintReviseSystemPrompt,
  buildBlueprintReviseUserPrompt,
  buildBlueprintSystemPrompt,
  buildBlueprintUserPrompt,
  buildDraftReviseSystemPrompt,
  buildDraftReviseUserPrompt,
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

  it("requires ## chapters for Word TOC and forbids layout-only sections", () => {
    const p = buildDraftSystemPrompt();
    expect(p).toContain("##");
    expect(p).toContain("目录");
    expect(p).toContain("修订记录");
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

describe("buildBlueprintReviseSystemPrompt", () => {
  it("lists the four allowed ops, demands one JSON object, and mentions artifactDigest", () => {
    const p = buildBlueprintReviseSystemPrompt();
    expect(p).toContain("add");
    expect(p).toContain("remove");
    expect(p).toContain("update");
    expect(p).toContain("reorder");
    expect(p).toContain("一个 JSON 对象");
    expect(p).toContain("artifactDigest");
  });

  it("forbids invented facts and process noise", () => {
    const p = buildBlueprintReviseSystemPrompt();
    expect(p).toContain("不得新增产品事实");
    expect(p).toContain("待确认");
  });
});

describe("buildBlueprintReviseUserPrompt", () => {
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
      {
        id: "omitted-risks",
        title: "风险",
        inclusion: "omit",
        presentation: "bullets",
        sourceNodeIds: [],
        sourceHeadings: [],
        rationale: "不对外披露",
      },
    ],
  };

  it("includes the user instruction, the current section ids, and confirmed source node content", () => {
    const prompt = buildBlueprintReviseUserPrompt(
      blueprint,
      [node("goals", "# 需求背景与建设目标\n\n## 总体目标\n\n目标 A。")],
      "把执行摘要改名为总览",
    );
    expect(prompt).toContain("把执行摘要改名为总览");
    expect(prompt).toContain("executive-summary");
    expect(prompt).toContain("omitted-risks");
    expect(prompt).toContain("artifactDigest");
    // confirmed source node content is included so an update can keep source mapping valid
    expect(prompt).toContain("目标 A。");
  });
});

describe("buildDraftReviseSystemPrompt", () => {
  it("lists replace/remove/insert ops and the one-JSON-object rule", () => {
    const p = buildDraftReviseSystemPrompt();
    expect(p).toContain("replace");
    expect(p).toContain("remove");
    expect(p).toContain("insert");
    expect(p).toContain("一个 JSON 对象");
    expect(p).toContain("artifactDigest");
  });

  it("prohibits ## lines in replacement bodies", () => {
    const p = buildDraftReviseSystemPrompt();
    expect(p).toContain("##");
    expect(p).toContain("不得");
  });
});

describe("buildDraftReviseUserPrompt", () => {
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
        rationale: "r",
      },
      {
        id: "omitted-risks",
        title: "风险",
        inclusion: "omit",
        presentation: "bullets",
        sourceNodeIds: [],
        sourceHeadings: [],
        rationale: "r",
      },
    ],
  };

  it("includes the current markdown, the approved blueprint's included sections, and the instruction", () => {
    const prompt = buildDraftReviseUserPrompt("## 执行摘要\n\n已确认结论。", blueprint, "补充一句背景");
    expect(prompt).toContain("## 执行摘要\n\n已确认结论。");
    expect(prompt).toContain("执行摘要");
    // the omitted section is not listed as an included section
    expect(prompt).not.toContain("风险");
    expect(prompt).toContain("补充一句背景");
    expect(prompt).toContain("artifactDigest");
  });
});
