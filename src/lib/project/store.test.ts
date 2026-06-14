import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./store";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "Sion-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("ProjectStore", () => {
  it("creates a project folder with metadata, nodes, chat logs, and exports", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({
      name: "库存管理系统",
      customerName: "示例客户",
      authorName: "示例团队",
      now: "2026-06-14T10:00:00.000Z",
    });

    const loaded = await store.getProject(project.id);
    const nodes = await store.getProjectNodes(project.id);

    expect(loaded?.name).toBe("库存管理系统");
    expect(nodes).toHaveLength(12);
    expect(nodes[0].markdown).toContain("# 项目基本信息");
  });

  it("updates a single node without changing other node content", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    await store.updateProjectNode(project.id, "feature-design", {
      markdown: "# 功能模块设计\n\n## 已确认内容\n\n- 客户管理",
      status: "confirmed",
      assumptions: ["默认存在管理员角色"],
      openQuestions: ["是否需要客户分级？"],
      updatedAt: "2026-06-14T11:00:00.000Z",
    });

    const nodes = await store.getProjectNodes(project.id);
    expect(nodes.find((node) => node.id === "feature-design")?.status).toBe("confirmed");
    expect(nodes.find((node) => node.id === "basic-info")?.markdown).toContain("# 项目基本信息");
  });

  it("appends chat messages per node", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    await store.appendChatMessage(project.id, "feature-design", {
      id: "m-1",
      role: "user",
      content: "把客户管理拆细一点",
      createdAt: "2026-06-14T11:00:00.000Z",
    });

    const messages = await store.getChatMessages(project.id, "feature-design");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("把客户管理拆细一点");
  });
});
