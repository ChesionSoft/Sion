import { describe, expect, it } from "vitest";
import { assembleProjectDesignMarkdown, createAgentsMarkdown, createSpecMarkdown, createTasksMarkdown } from "./markdown";
import type { Project, ProjectNode } from "./types";

const project: Project = {
  id: "p-1",
  name: "库存管理系统",
  customerName: "示例客户",
  authorName: "示例团队",
  version: "V1.0",
  createdAt: "2026-06-14T10:00:00.000Z",
  updatedAt: "2026-06-14T10:00:00.000Z",
};

const nodes: ProjectNode[] = [
  {
    id: "basic-info",
    status: "confirmed",
    markdown: "# 项目基本信息\n\n## 已确认内容\n\n- 项目名称：库存管理系统",
    assumptions: [],
    openQuestions: [],
    updatedAt: "2026-06-14T10:00:00.000Z",
  },
  {
    id: "feature-design",
    status: "generated",
    markdown: "# 功能模块设计\n\n## 已确认内容\n\n- 入库管理",
    assumptions: ["默认使用后台管理系统"],
    openQuestions: ["是否需要扫码入库？"],
    updatedAt: "2026-06-14T10:00:00.000Z",
  },
] as ProjectNode[];

describe("markdown generation", () => {
  it("assembles PROJECT_DESIGN.md with cover metadata and node content", () => {
    const markdown = assembleProjectDesignMarkdown(project, nodes);
    expect(markdown).toContain("# 库存管理系统项目开发设计文档");
    expect(markdown).toContain("客户名称：示例客户");
    expect(markdown).toContain("## 1. 项目基本信息");
    expect(markdown).toContain("- 入库管理");
    expect(markdown).toContain("## 汇总待确认事项");
    expect(markdown).toContain("是否需要扫码入库？");
  });

  it("creates developer-oriented SPEC.md", () => {
    const markdown = createSpecMarkdown(project, nodes);
    expect(markdown).toContain("# 库存管理系统 SPEC");
    expect(markdown).toContain("## 功能模块设计");
  });

  it("creates TASKS.md and AGENTS.md", () => {
    expect(createTasksMarkdown(project, nodes)).toContain("# 库存管理系统 开发任务");
    expect(createAgentsMarkdown(project, nodes)).toContain("# AGENTS.md");
  });
});
