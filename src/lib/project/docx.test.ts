import { describe, expect, it } from "vitest";
import { buildFormalPrdDocument, buildProjectDesignDocument, createProjectDesignDocx } from "./docx";
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

  it("renders a master markdown (preface + chapters, H1 per chapter, page breaks)", () => {
    const master = "## 项目概述\n\n前言正文。\n\n## 1. 项目基本信息\n\n章节正文。";
    const doc = buildProjectDesignDocument(
      project,
      [node("basic-info", "# 项目基本信息\n\n原始")],
      master,
    );
    const serialized = xml(doc);
    expect(serialized).toContain("项目概述");
    expect(serialized).toContain("前言正文");
    expect(serialized).toContain("1. 项目基本信息");
    // master 的 ## -> Heading1(offset=1)
    expect(serialized).toContain("Heading1");
    // 章节前分页
    expect(serialized).toContain("w:br");
    expect(serialized).toContain('"page"');
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

describe("buildFormalPrdDocument", () => {
  it("uses the formal PRD title and explicit Chinese styles", () => {
    const doc = buildFormalPrdDocument(project, "## 执行摘要\n\n已确认结论。");
    const serialized = xml(doc);
    expect(serialized).toContain("正式产品需求文档（PRD）");
    expect(serialized).toContain("PingFang SC");
    expect(serialized).toContain("eastAsia");
  });

  it("prefills a visible TOC with chapter titles and heading outline levels", () => {
    const doc = buildFormalPrdDocument(
      project,
      "## 执行摘要\n\n已确认。\n\n## 用户与场景\n\n### 角色\n\n终端用户。",
    );
    const serialized = xml(doc);
    // Prefetched TOC entries (not an empty TOC field placeholder)
    expect(serialized).toContain("执行摘要");
    expect(serialized).toContain("用户与场景");
    expect(serialized).toContain("角色");
    // Word will refresh page numbers on open
    expect(serialized).toContain("updateFields");
    // Heading styles carry outline level (docx serializes as outlineLvl)
    expect(serialized).toContain("outlineLvl");
    // Bookmarks for hyperlink navigation
    expect(serialized).toContain("toc-");
    // 修订记录 sits before body chapters
    expect(serialized).toContain("修订记录");
    // TOC title is present
    expect(serialized).toContain("目录");
  });

  it("omits optional cover metadata instead of rendering unresolved placeholders", () => {
    const doc = buildFormalPrdDocument(
      { ...project, customerName: "", authorName: "" },
      "## 执行摘要\n\n已确认结论。",
    );
    const serialized = xml(doc);

    // Cover no longer prints “未填写” for empty customer/author
    expect(serialized).not.toContain("客户名称：未填写");
    expect(serialized).not.toContain("编制方：未填写");
  });

  it("renders a constrained flow block as a diagram image, not literal ASCII text", () => {
    const doc = buildFormalPrdDocument(project, "## 核心流程\n\n```flow\n报告解读 -> 健康评估 -> 调理方案\n```");
    const serialized = xml(doc);
    expect(serialized).toContain("data:image/svg+xml");
    expect(serialized).not.toContain("报告解读 -> 健康评估");
  });

  it("accepts Chinese fullwidth arrows as flow separators", () => {
    // Models frequently emit "→" in Chinese drafts; must not throw, and must
    // still embed as an SVG diagram (labels live inside the SVG buffer).
    const doc = buildFormalPrdDocument(
      project,
      "## 核心流程\n\n```flow\n首页 AI 医生对话页 → 医生选择 → 健康咨询 → 健康评估 → 调理方案\n```",
    );
    expect(xml(doc)).toContain("data:image/svg+xml");
  });

  it("rejects an invalid flow block (too few or too many labels)", () => {
    expect(() => buildFormalPrdDocument(project, "## 流程\n\n```flow\n只有一项\n```")).toThrow();
    expect(() =>
      buildFormalPrdDocument(project, "## 流程\n\n```flow\nA -> B -> C -> D -> E -> F -> G\n```"),
    ).toThrow();
  });

  it("rejects a multi-line flow block", () => {
    expect(() => buildFormalPrdDocument(project, "## 流程\n\n```flow\nA -> B\nC -> D\n```")).toThrow();
  });

  it("omits non-flow code blocks from the formal body", () => {
    const doc = buildFormalPrdDocument(project, "## 概述\n\n正文。\n\n```js\nconst x = 1;\n```");
    const serialized = xml(doc);
    expect(serialized).toContain("正文");
    expect(serialized).not.toContain("const x = 1");
  });

  it("rejects a prose-stuffed table in the formal body", () => {
    const longCell = "x".repeat(130);
    expect(() =>
      buildFormalPrdDocument(
        project,
        `## 表\n\n| A | B |\n| --- | --- |\n| ${longCell} | ${longCell} |\n| ${longCell} | ${longCell} |`,
      ),
    ).toThrow();
  });

  it("packs a valid formal docx buffer", async () => {
    const { Packer } = await import("docx");
    const buf = Buffer.from(
      await Packer.toBuffer(buildFormalPrdDocument(project, "## 执行摘要\n\n已确认结论。")),
    );
    expect(buf.byteLength).toBeGreaterThan(1000);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});
