import { describe, expect, it } from "vitest";
import { buildProjectDesignDocument, createProjectDesignDocx } from "./docx";
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
  return {
    id,
    status: "confirmed",
    markdown,
    revision: 1,
    updatedAt: "2026-06-14T10:00:00.000Z",
  } as ProjectNode;
}

const xml = (o: unknown): string => JSON.stringify(o);

describe("buildProjectDesignDocument", () => {
  it("includes cover (project name), TOC, revision record, and chapter headings", () => {
    const doc = buildProjectDesignDocument(project, [
      node("basic-info", "# 项目基本信息\n\n## 背景\n\n正文，含 **加粗** 与 `code`。"),
      node("goals", "# 需求背景与建设目标\n\n## 目标\n\n| 维度 | 说明 |\n| --- | --- |\n| 范围 | v0.1 |"),
    ]);
    const serialized = xml(doc);
    // 封面：项目名
    expect(serialized).toContain("库存管理项目开发设计文档");
    // 目录
    expect(serialized).toContain("目录");
    // 修订记录
    expect(serialized).toContain("修订记录");
    // 章节标题（documentHeading）
    expect(serialized).toContain("1. 项目基本信息");
    expect(serialized).toContain("2. 需求背景与建设目标");
    // 正文内联渲染（加粗 + 行内代码）进树
    expect(serialized).toContain("加粗");
    expect(serialized).toContain("code");
  });

  it("renders a markdown table as a docx table element", () => {
    const doc = buildProjectDesignDocument(project, [
      node("goals", "# 目标\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"),
    ]);
    const serialized = xml(doc);
    expect(serialized).toContain("w:tbl");
    expect(serialized).toContain("A");
    expect(serialized).toContain("2");
  });

  it("skips the final-export node and orders chapters by workflow", () => {
    const doc = buildProjectDesignDocument(project, [
      node("goals", "# 需求背景与建设目标\n\n正文"),
      node("basic-info", "# 项目基本信息\n\n正文"),
      node("final-export", "# 最终文档生成\n\n- 检查项"),
    ]);
    const serialized = xml(doc);
    // final-export 不进正文
    expect(serialized).not.toContain("12. 最终文档生成");
    // basic-info 在 goals 之前（workflow 顺序）
    expect(serialized.indexOf("1. 项目基本信息")).toBeLessThan(serialized.indexOf("2. 需求背景与建设目标"));
  });

  it("does not throw on an empty node body", () => {
    expect(() => buildProjectDesignDocument(project, [node("basic-info", "")])).not.toThrow();
  });
});

describe("createProjectDesignDocx", () => {
  it("returns a valid docx (zip) buffer", async () => {
    const buf = await createProjectDesignDocx(project, [node("basic-info", "# 项目基本信息\n\n正文")]);
    expect(buf.byteLength).toBeGreaterThan(1000);
    // docx 是 zip，以 PK 开头
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
  });
});
