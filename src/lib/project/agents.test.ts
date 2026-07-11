import { describe, expect, it } from "vitest";
import { loadAgentRule, renderAgentSystemPrompt } from "./agents";
import { getDeliverySchema } from "./node-delivery-schemas";
import { WORKFLOW_NODES } from "./nodes";

const SIX_HEADINGS = [
  "## 角色与边界",
  "## 输入依赖",
  "## 交付稿骨架",
  "## 事实判定规则",
  "## 追问策略",
  "## 禁止事项",
];

describe("agent rules", () => {
  it("loads the fixed feature-design rule file", async () => {
    const rule = await loadAgentRule("feature-design");
    expect(rule.nodeId).toBe("feature-design");
    expect(rule.content).toContain("你只负责功能模块设计");
    expect(rule.content).toContain("每轮最多 3 个关键问题");
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

  // final-export is a blueprint-only curator, not a delivery-skeleton writer, so
  // it is exempt from the six-section / 交付稿骨架 invariants that the 11 content
  // nodes follow. Its own contract is checked separately below.
  describe("six-section structure", () => {
    for (const node of WORKFLOW_NODES.filter((n) => n.id !== "final-export")) {
      it(`${node.id} has six sections in order`, async () => {
        const rule = await loadAgentRule(node.id);
        const content = rule.content;

        let prevIndex = -1;
        for (const heading of SIX_HEADINGS) {
          const idx = content.indexOf(heading);
          expect(idx).toBeGreaterThan(-1);
          expect(idx).toBeGreaterThan(prevIndex);
          prevIndex = idx;
        }
      });
    }
  });

  describe("交付稿骨架 contains schema headings and table columns", () => {
    for (const node of WORKFLOW_NODES.filter((n) => n.id !== "final-export")) {
      it(`${node.id} 骨架 contains all schema headings and table columns`, async () => {
        const rule = await loadAgentRule(node.id);
        const schema = getDeliverySchema(node.id);
        expect(schema).toBeDefined();

        const content = rule.content;
        const skeletonStart = content.indexOf("## 交付稿骨架");
        expect(skeletonStart).toBeGreaterThan(-1);

        // Find the next ## heading after 交付稿骨架
        const afterSkeleton = content.slice(skeletonStart + "## 交付稿骨架".length);
        const nextHeadingMatch = afterSkeleton.match(/\n## /);
        const skeletonEnd = nextHeadingMatch
          ? skeletonStart + "## 交付稿骨架".length + nextHeadingMatch.index!
          : content.length;
        const skeletonSection = content.slice(skeletonStart, skeletonEnd);

        for (const section of schema!.sections) {
          expect(skeletonSection).toContain(section.heading);
          if (section.tableColumns) {
            for (const col of section.tableColumns) {
              expect(skeletonSection).toContain(col);
            }
          }
        }
      });
    }
  });

  describe("final-export blueprint-only curator", () => {
    it("curates an export blueprint instead of writing a delivery skeleton or checklist", async () => {
      const rule = await loadAgentRule("final-export");
      const content = rule.content;

      // produces a blueprint, not a delivery draft or quality checklist
      expect(content).toContain("导出蓝图");
      expect(content).not.toContain("## 交付稿骨架");
      expect(content).not.toContain("导出检查清单");
      expect(content).not.toContain("export_checklist");

      // marks open questions / history / process noise as omit
      expect(content).toContain("omit");
      expect(content).toContain("待确认");

      // never appends a quality checklist to project content
      expect(content).toContain("不向项目内容追加质量检查清单");
    });
  });

  describe("输入依赖 lists dependsOn titles", () => {
    for (const node of WORKFLOW_NODES) {
      it(`${node.id} 输入依赖 lists upstream node titles`, async () => {
        const rule = await loadAgentRule(node.id);
        const content = rule.content;

        const depStart = content.indexOf("## 输入依赖");
        expect(depStart).toBeGreaterThan(-1);

        const afterDep = content.slice(depStart + "## 输入依赖".length);
        const nextHeadingMatch = afterDep.match(/\n## /);
        const depEnd = nextHeadingMatch
          ? depStart + "## 输入依赖".length + nextHeadingMatch.index!
          : content.length;
        const depSection = content.slice(depStart, depEnd);

        if (node.dependsOn.length === 0) {
          expect(depSection).toContain("无上游依赖");
        } else {
          for (const depId of node.dependsOn) {
            const depNode = WORKFLOW_NODES.find((n) => n.id === depId);
            expect(depNode).toBeDefined();
            expect(depSection).toContain(depNode!.title);
          }
        }
      });
    }
  });
});
