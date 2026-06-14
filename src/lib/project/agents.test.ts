import { describe, expect, it } from "vitest";
import { loadAgentRule, renderAgentSystemPrompt } from "./agents";

describe("agent rules", () => {
  it("loads the fixed feature-design rule file", async () => {
    const rule = await loadAgentRule("feature-design");
    expect(rule.nodeId).toBe("feature-design");
    expect(rule.content).toContain("你只负责功能模块设计");
    expect(rule.content).toContain("每轮最多提出 3 个关键问题");
  });

  it("renders a node-scoped system prompt with project context", async () => {
    const prompt = await renderAgentSystemPrompt({
      nodeId: "feature-design",
      projectName: "库存管理系统",
      currentMarkdown: "# 功能模块设计",
      contextMarkdown: "## 项目基本信息\n\n库存管理系统",
    });

    expect(prompt).toContain("当前项目：库存管理系统");
    expect(prompt).toContain("你只负责功能模块设计");
    expect(prompt).toContain("## 当前节点 Markdown");
    expect(prompt).toContain("## 可参考项目上下文");
  });
});
