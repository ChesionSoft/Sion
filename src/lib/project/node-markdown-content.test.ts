import { describe, expect, it } from "vitest";
import {
  collectNodeAssumptions,
  collectNodeOpenQuestions,
  extractSectionBullets,
  mergeLegacyNodeListsIntoMarkdown,
} from "./node-markdown-content";
import type { ProjectNode } from "./types";

describe("extractSectionBullets", () => {
  const markdown = [
    "# 功能模块设计",
    "",
    "## 已确认内容",
    "",
    "- 入库管理",
    "- 出库管理",
    "",
    "## 设计假设",
    "",
    "- 默认使用后台管理系统",
    "- 用户已通过企业微信认证",
    "",
    "## 待确认问题",
    "",
    "- 是否需要扫码入库？",
    "- 是否需要批次管理？",
    "",
    "## 其他",
    "",
    "- 无关内容",
  ].join("\n");

  it("extracts bullets from a section", () => {
    expect(extractSectionBullets(markdown, "设计假设")).toEqual([
      "默认使用后台管理系统",
      "用户已通过企业微信认证",
    ]);
  });

  it("extracts bullets from 待确认问题 section", () => {
    expect(extractSectionBullets(markdown, "待确认问题")).toEqual([
      "是否需要扫码入库？",
      "是否需要批次管理？",
    ]);
  });

  it("returns empty array when section is missing", () => {
    expect(extractSectionBullets(markdown, "不存在的章节")).toEqual([]);
  });

  it("filters out placeholder bullets 暂无 and 暂无。", () => {
    const md = [
      "# 测试",
      "",
      "## 设计假设",
      "",
      "- 暂无",
      "- 暂无。",
      "- 真实假设",
      "",
    ].join("\n");
    expect(extractSectionBullets(md, "设计假设")).toEqual(["真实假设"]);
  });

  it("stops at the next same-level heading", () => {
    const md = [
      "## 设计假设",
      "",
      "- 假设A",
      "",
      "## 待确认问题",
      "",
      "- 问题A",
      "",
    ].join("\n");
    expect(extractSectionBullets(md, "设计假设")).toEqual(["假设A"]);
  });

  it("stops at a higher-level heading mid-document", () => {
    const md = [
      "## 设计假设",
      "",
      "- 假设A",
      "",
      "# 其他",
      "",
      "- 不应被收集的内容",
      "",
      "## 待确认问题",
      "",
      "- 也不应被收集",
      "",
    ].join("\n");
    expect(extractSectionBullets(md, "设计假设")).toEqual(["假设A"]);
  });
});

describe("mergeLegacyNodeListsIntoMarkdown", () => {
  it("appends legacy assumptions to existing section, deduping", () => {
    const markdown = [
      "## 设计假设",
      "",
      "- 已有假设",
      "",
    ].join("\n");
    const result = mergeLegacyNodeListsIntoMarkdown(markdown, ["已有假设", "新假设"]);
    expect(extractSectionBullets(result, "设计假设")).toEqual(["已有假设", "新假设"]);
  });

  it("appends legacy open questions to existing section, deduping", () => {
    const markdown = [
      "## 待确认问题",
      "",
      "- 已有问题",
      "",
    ].join("\n");
    const result = mergeLegacyNodeListsIntoMarkdown(markdown, undefined, ["已有问题", "新问题"]);
    expect(extractSectionBullets(result, "待确认问题")).toEqual(["已有问题", "新问题"]);
  });

  it("creates section if missing for assumptions", () => {
    const markdown = "# 标题\n\n一些内容\n";
    const result = mergeLegacyNodeListsIntoMarkdown(markdown, ["旧假设"]);
    expect(extractSectionBullets(result, "设计假设")).toEqual(["旧假设"]);
  });

  it("creates section if missing for open questions", () => {
    const markdown = "# 标题\n\n一些内容\n";
    const result = mergeLegacyNodeListsIntoMarkdown(markdown, undefined, ["旧问题"]);
    expect(extractSectionBullets(result, "待确认问题")).toEqual(["旧问题"]);
  });

  it("returns markdown unchanged when both arrays are empty", () => {
    const markdown = "# 标题\n\n内容\n";
    expect(mergeLegacyNodeListsIntoMarkdown(markdown, [], [])).toBe(markdown);
  });

  it("returns markdown unchanged when both arrays are undefined", () => {
    const markdown = "# 标题\n\n内容\n";
    expect(mergeLegacyNodeListsIntoMarkdown(markdown)).toBe(markdown);
  });

  it("does not duplicate items already in markdown", () => {
    const markdown = [
      "## 设计假设",
      "",
      "- 已有假设",
      "",
    ].join("\n");
    const result = mergeLegacyNodeListsIntoMarkdown(markdown, ["已有假设"]);
    expect(extractSectionBullets(result, "设计假设")).toEqual(["已有假设"]);
  });
});

describe("collectNodeAssumptions", () => {
  it("collects assumptions from all nodes", () => {
    const nodes: ProjectNode[] = [
      {
        id: "basic-info",
        status: "confirmed",
        markdown: [
          "## 设计假设",
          "",
          "- 假设A",
          "",
        ].join("\n"),
        revision: 0,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
      {
        id: "feature-design",
        status: "generated",
        markdown: [
          "## 设计假设",
          "",
          "- 假设B",
          "",
        ].join("\n"),
        revision: 0,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
    ];
    expect(collectNodeAssumptions(nodes)).toEqual(["假设A", "假设B"]);
  });

  it("deduplicates assumptions across nodes", () => {
    const nodes: ProjectNode[] = [
      {
        id: "basic-info",
        status: "confirmed",
        markdown: [
          "## 设计假设",
          "",
          "- 重复假设",
          "",
        ].join("\n"),
        revision: 0,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
      {
        id: "feature-design",
        status: "generated",
        markdown: [
          "## 设计假设",
          "",
          "- 重复假设",
          "",
        ].join("\n"),
        revision: 0,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
    ];
    expect(collectNodeAssumptions(nodes)).toEqual(["重复假设"]);
  });
});

describe("collectNodeOpenQuestions", () => {
  it("collects open questions from all nodes", () => {
    const nodes: ProjectNode[] = [
      {
        id: "basic-info",
        status: "confirmed",
        markdown: [
          "## 待确认问题",
          "",
          "- 问题A",
          "",
        ].join("\n"),
        revision: 0,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
      {
        id: "feature-design",
        status: "generated",
        markdown: [
          "## 待确认问题",
          "",
          "- 问题B",
          "",
        ].join("\n"),
        revision: 0,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
    ];
    expect(collectNodeOpenQuestions(nodes)).toEqual(["问题A", "问题B"]);
  });

  it("deduplicates open questions across nodes", () => {
    const nodes: ProjectNode[] = [
      {
        id: "basic-info",
        status: "confirmed",
        markdown: [
          "## 待确认问题",
          "",
          "- 重复问题",
          "",
        ].join("\n"),
        revision: 0,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
      {
        id: "feature-design",
        status: "generated",
        markdown: [
          "## 待确认问题",
          "",
          "- 重复问题",
          "",
        ].join("\n"),
        revision: 0,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
    ];
    expect(collectNodeOpenQuestions(nodes)).toEqual(["重复问题"]);
  });
});
