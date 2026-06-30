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
    revision: 0,
    updatedAt: "2026-06-14T10:00:00.000Z",
  },
  {
    id: "feature-design",
    status: "generated",
    markdown: [
      "# 功能模块设计",
      "",
      "## 已确认内容",
      "",
      "- 入库管理",
      "",
      "## 设计假设",
      "",
      "- 默认使用后台管理系统",
      "",
      "## 待确认问题",
      "",
      "- 是否需要扫码入库？",
      "",
    ].join("\n"),
    revision: 0,
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
    // The aggregated assumptions/open-questions sections were removed — the
    // per-node delivery docs no longer carry those meta-sections, so the
    // export must not ship empty 汇总 headers.
    expect(markdown).not.toContain("汇总设计假设");
    expect(markdown).not.toContain("汇总待确认事项");
  });

  it("creates developer-oriented SPEC.md", () => {
    const markdown = createSpecMarkdown(project, nodes);
    expect(markdown).toContain("# 库存管理系统 SPEC");
    expect(markdown).toContain("## 功能模块设计");
  });

  it("creates TASKS.md and AGENTS.md", () => {
    expect(createTasksMarkdown(project, nodes)).toContain("# 库存管理系统 开发任务");
    const agents = createAgentsMarkdown(project);
    expect(agents).toContain("# AGENTS.md");
    expect(agents).not.toContain("当前待确认事项");
  });
});
