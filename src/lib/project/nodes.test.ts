import { describe, expect, it } from "vitest";
import { getNodeDefinition, WORKFLOW_NODES } from "./nodes";

describe("WORKFLOW_NODES", () => {
  it("defines the fixed 12-node small outsourced project design workflow", () => {
    expect(WORKFLOW_NODES.map((node) => node.title)).toEqual([
      "项目基本信息",
      "需求背景与建设目标",
      "用户角色与权限",
      "业务流程设计",
      "功能模块设计",
      "页面与交互设计",
      "数据结构设计",
      "接口设计",
      "技术架构与部署",
      "开发任务拆分",
      "待确认事项与风险",
      "最终文档生成",
    ]);
  });

  it("marks only the first two nodes as required initialization context", () => {
    expect(WORKFLOW_NODES.filter((node) => node.requiredForInitialization).map((node) => node.id)).toEqual([
      "basic-info",
      "goals",
    ]);
  });

  it("finds node definitions by id", () => {
    expect(getNodeDefinition("feature-design")?.title).toBe("功能模块设计");
    expect(getNodeDefinition("missing-node")).toBeUndefined();
  });
});
