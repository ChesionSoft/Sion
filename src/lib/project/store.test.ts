import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./store";
import { ProjectIdError } from "./paths";

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

  it("creates and lists named chat sessions per node", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");
    const sessions = await store.listSessions(project.id, "feature-design");

    expect(session).toMatchObject({
      nodeId: "feature-design",
      messageCount: 0,
      createdAt: "2026-06-14T11:00:00.000Z",
      updatedAt: "2026-06-14T11:00:00.000Z",
    });
    expect(session.name).toContain("6月14日");
    expect(sessions.map((item) => item.id)).toEqual([session.id]);
  });

  it("appends messages to a selected chat session", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    await store.appendChatMessage(
      project.id,
      "feature-design",
      {
        id: "m-1",
        role: "user",
        content: "把客户管理拆细一点",
        createdAt: "2026-06-14T11:01:00.000Z",
      },
      session.id,
    );

    const messages = await store.getChatMessages(project.id, "feature-design", session.id);
    const sessions = await store.listSessions(project.id, "feature-design");

    expect(messages).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: session.id,
      messageCount: 1,
      updatedAt: "2026-06-14T11:01:00.000Z",
    });
  });

  it("keeps only the latest 10 chat sessions per node", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    for (let index = 0; index < 11; index += 1) {
      await store.createSession(project.id, "feature-design", `2026-06-14T11:${String(index).padStart(2, "0")}:00.000Z`);
    }

    const sessions = await store.listSessions(project.id, "feature-design");
    expect(sessions).toHaveLength(10);
    expect(sessions.at(-1)?.createdAt).toBe("2026-06-14T11:01:00.000Z");
  });

  it("deletes a chat session by id", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    await store.deleteSession(project.id, session.id);

    await expect(store.getChatMessages(project.id, "feature-design", session.id)).rejects.toThrow("会话不存在");
    expect(await store.listSessions(project.id, "feature-design")).toEqual([]);
  });

  it("migrates legacy flat chat files into the first session", async () => {
    const projectId = "legacy-project";
    const projectDir = path.join(rootDir, projectId);
    await mkdir(path.join(projectDir, "chat"), { recursive: true });
    await writeFile(
      path.join(projectDir, "chat", "feature-design.json"),
      JSON.stringify([
        {
          id: "m-1",
          role: "user",
          content: "旧会话消息",
          createdAt: "2026-06-14T11:00:00.000Z",
        },
      ]),
      "utf8",
    );
    const store = new ProjectStore(rootDir);

    const sessions = await store.listSessions(projectId, "feature-design");
    const messages = await store.getChatMessages(projectId, "feature-design", sessions[0].id);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      nodeId: "feature-design",
      messageCount: 1,
    });
    expect(messages[0].content).toBe("旧会话消息");
  });

  it("rejects path-traversal project ids before any filesystem access", async () => {
    const store = new ProjectStore(rootDir);
    await expect(store.getProjectNodes("../escape")).rejects.toThrow(ProjectIdError);
    await expect(store.getProjectNodes("..")).rejects.toThrow(ProjectIdError);
    await expect(
      store.updateProjectNode("../escape", "feature-design", { markdown: "# x" }),
    ).rejects.toThrow(ProjectIdError);
  });

  it("does not resurrect deleted sessions from the legacy file", async () => {
    const projectId = "legacy-project";
    const projectDir = path.join(rootDir, projectId);
    await mkdir(path.join(projectDir, "chat"), { recursive: true });
    await writeFile(
      path.join(projectDir, "chat", "feature-design.json"),
      JSON.stringify([
        { id: "m-1", role: "user", content: "旧会话消息", createdAt: "2026-06-14T11:00:00.000Z" },
      ]),
      "utf8",
    );
    const store = new ProjectStore(rootDir);

    const first = await store.listSessions(projectId, "feature-design");
    expect(first).toHaveLength(1);

    await store.deleteSession(projectId, first[0].id);

    const second = await store.listSessions(projectId, "feature-design");
    expect(second).toEqual([]);
  });

  it("returns readable nodes even if one node file is missing", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    await rm(path.join(rootDir, project.id, "nodes", "feature-design.json"));

    const nodes = await store.getProjectNodes(project.id);
    expect(nodes).toHaveLength(11);
    expect(nodes.find((node) => node.id === "feature-design")).toBeUndefined();
  });

  it("migrates legacy node JSON with assumptions/openQuestions arrays and no revision", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    // Write legacy JSON with old array fields and no revision
    const legacyNode = {
      id: "feature-design",
      status: "generated",
      markdown: "# 功能模块设计\n\n## 已确认内容\n\n- 入库管理",
      assumptions: ["默认使用后台管理系统"],
      openQuestions: ["是否需要扫码入库？"],
      updatedAt: "2026-06-14T10:00:00.000Z",
    };
    await writeFile(
      path.join(rootDir, project.id, "nodes", "feature-design.json"),
      JSON.stringify(legacyNode, null, 2),
      "utf8",
    );

    const nodes = await store.getProjectNodes(project.id);
    const migrated = nodes.find((node) => node.id === "feature-design")!;

    // revision should be normalized to 0
    expect(migrated.revision).toBe(0);

    // Legacy assumptions should be merged into markdown
    expect(migrated.markdown).toContain("默认使用后台管理系统");

    // Legacy open questions should be merged into markdown
    expect(migrated.markdown).toContain("是否需要扫码入库？");

    // Node object should NOT have the old array fields
    expect((migrated as Record<string, unknown>).assumptions).toBeUndefined();
    expect((migrated as Record<string, unknown>).openQuestions).toBeUndefined();
  });
});
