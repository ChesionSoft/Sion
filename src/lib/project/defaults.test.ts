import { describe, expect, it } from "vitest";
import { createDefaultProject, createDefaultProjectNodes, createNodeMarkdown } from "./defaults";

describe("project defaults", () => {
  it("creates project metadata with customer-facing defaults", () => {
    const project = createDefaultProject({
      id: "p-001",
      name: "库存管理系统",
      customerName: "示例客户",
      authorName: "示例团队",
      now: "2026-06-14T10:00:00.000Z",
    });

    expect(project).toMatchObject({
      id: "p-001",
      name: "库存管理系统",
      customerName: "示例客户",
      authorName: "示例团队",
      version: "V1.0",
      createdAt: "2026-06-14T10:00:00.000Z",
      updatedAt: "2026-06-14T10:00:00.000Z",
    });
  });

  it("creates one draft node per workflow node", () => {
    const nodes = createDefaultProjectNodes("2026-06-14T10:00:00.000Z");
    expect(nodes).toHaveLength(12);
    expect(nodes[0]).toMatchObject({
      id: "basic-info",
      status: "draft",
    });
    expect(nodes[11]).toMatchObject({
      id: "final-export",
      status: "not_started",
    });
  });

  it("uses a standard weak-structured Markdown frame for node content", () => {
    const markdown = createNodeMarkdown("feature-design");
    expect(markdown).toContain("# 功能模块设计");
    expect(markdown).toContain("## 已确认内容");
    expect(markdown).toContain("## 设计假设");
    expect(markdown).toContain("## 待确认问题");
  });
});
