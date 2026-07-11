import { describe, expect, it } from "vitest";
import {
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
  sanitizeSynthesisOutput,
} from "./synthesis";
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

function node(id: WorkflowNodeId, markdown: string): ProjectNode {
  return { id, status: "confirmed", markdown, revision: 1, updatedAt: "2026-06-14T10:00:00.000Z" } as ProjectNode;
}

describe("buildSynthesisSystemPrompt", () => {
  it("states the synthesis contract and the hard constraints", () => {
    const p = buildSynthesisSystemPrompt();
    expect(p).toContain("项目概述");
    expect(p).toContain("不编造");
    expect(p).toContain("待确认");
    expect(p).toContain("不新增");
  });
});

describe("buildSynthesisUserPrompt", () => {
  it("includes project meta and each node chapter (skip final-export)", () => {
    const prompt = buildSynthesisUserPrompt(project, [
      node("basic-info", "# 项目基本信息\n\n## 背景\n\n这是一段正文。"),
      node("final-export", "# 最终文档生成\n\n- 检查项"),
    ]);
    expect(prompt).toContain("库存管理");
    expect(prompt).toContain("1. 项目基本信息");
    expect(prompt).toContain("这是一段正文。");
    // final-export 不进输入
    expect(prompt).not.toContain("12. 最终文档生成");
  });
});

describe("sanitizeSynthesisOutput", () => {
  it("strips thinking tags", () => {
    expect(sanitizeSynthesisOutput("<think>推理</think>\n## 项目概述\n正文")).toBe("## 项目概述\n正文");
  });

  it("unwraps a markdown fence the model wrongly added", () => {
    expect(sanitizeSynthesisOutput("```markdown\n## 项目概述\n正文\n```")).toBe("## 项目概述\n正文");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeSynthesisOutput("\n\n## 项目概述\n\n")).toBe("## 项目概述");
  });
});
