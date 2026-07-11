import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNodeWriteLockCount, NodeRevisionConflictError, ProjectStore } from "./store";
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

  it("keeps only the latest 50 chat sessions per node", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    for (let index = 0; index < 51; index += 1) {
      await store.createSession(project.id, "feature-design", `2026-06-14T11:${String(index).padStart(2, "0")}:00.000Z`);
    }

    const sessions = await store.listSessions(project.id, "feature-design");
    expect(sessions).toHaveLength(50);
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

  it("writes successfully when expected revision matches and increments revision", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "Test", now: "2026-06-14T10:00:00.000Z" });

    const result = await store.updateProjectNodeIfRevision(project.id, "basic-info", 0, {
      markdown: "# Updated",
      status: "draft",
    });

    expect(result.revision).toBe(1);
    expect(result.markdown).toBe("# Updated");
    expect(result.status).toBe("draft");

    // Verify on disk
    const nodes = await store.getProjectNodes(project.id);
    const node = nodes.find((n) => n.id === "basic-info")!;
    expect(node.revision).toBe(1);
  });

  it("throws NodeRevisionConflictError with latestNode when revision is stale", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "Test", now: "2026-06-14T10:00:00.000Z" });

    // First write bumps revision to 1
    await store.updateProjectNodeIfRevision(project.id, "basic-info", 0, { markdown: "# v1" });

    // Try with stale revision 0
    let error: unknown;
    try {
      await store.updateProjectNodeIfRevision(project.id, "basic-info", 0, { markdown: "# v2 stale" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NodeRevisionConflictError);
    expect((error as NodeRevisionConflictError).latestNode.revision).toBe(1);
  });

  it("only one of two concurrent revision 0 writes succeeds", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "Test", now: "2026-06-14T10:00:00.000Z" });

    const results = await Promise.allSettled([
      store.updateProjectNodeIfRevision(project.id, "basic-info", 0, { markdown: "# A" }),
      store.updateProjectNodeIfRevision(project.id, "basic-info", 0, { markdown: "# B" }),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(NodeRevisionConflictError);
  });

  it("does not include expectedRevision in the written JSON", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "Test", now: "2026-06-14T10:00:00.000Z" });

    await store.updateProjectNodeIfRevision(project.id, "basic-info", 0, { markdown: "# Updated" });

    const raw = JSON.parse(
      await readFile(path.join(rootDir, project.id, "nodes", "basic-info.json"), "utf8"),
    );
    expect(raw.expectedRevision).toBeUndefined();
    expect(raw.revision).toBe(1);
  });

  it("preserves original node content and cleans up temp file when rename fails", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "Test", now: "2026-06-14T10:00:00.000Z" });

    const originalContent = await readFile(
      path.join(rootDir, project.id, "nodes", "basic-info.json"),
      "utf8",
    );

    const realFs = { readFile, writeFile, rename: undefined as never, unlink };
    const failingFs = {
      ...realFs,
      rename: vi.fn().mockRejectedValue(new Error("rename failed")),
    };
    const failingStore = new ProjectStore(rootDir, failingFs);

    await expect(
      failingStore.updateProjectNodeIfRevision(project.id, "basic-info", 0, { markdown: "# Should fail" }),
    ).rejects.toThrow("rename failed");

    // Original content unchanged
    const afterContent = await readFile(
      path.join(rootDir, project.id, "nodes", "basic-info.json"),
      "utf8",
    );
    expect(afterContent).toBe(originalContent);

    // No temp files remain
    const nodeFiles = await readdir(path.join(rootDir, project.id, "nodes"));
    expect(nodeFiles.filter((f) => f.startsWith("."))).toHaveLength(0);
  });

  it("cleans up the temp path when writing the temp file fails", async () => {
    const unlinkMock = vi.fn().mockResolvedValue(undefined);
    const store = new ProjectStore(rootDir, {
      readFile,
      writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
      rename: vi.fn(),
      unlink: unlinkMock,
    });
    const project = await new ProjectStore(rootDir).createProject({ name: "写失败清理" });

    await expect(
      store.updateProjectNodeIfRevision(project.id, "basic-info", 0, { markdown: "new" }),
    ).rejects.toThrow("disk full");

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(String(unlinkMock.mock.calls[0][0])).toMatch(/\.tmp$/);
  });

  it("returns lock count to 0 after 100 sequential writes to different node keys", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "Test", now: "2026-06-14T10:00:00.000Z" });

    const nodeIds: import("./types").WorkflowNodeId[] = [
      "basic-info", "goals", "roles-permissions", "business-flow",
      "feature-design", "page-interaction", "data-structure", "api-design",
      "architecture-deployment", "development-tasks", "risks-open-questions", "final-export",
    ];

    for (let i = 0; i < 100; i++) {
      const nodeId = nodeIds[i % nodeIds.length];
      await store.updateProjectNode(project.id, nodeId, { markdown: `# Write ${i}` });
    }

    expect(getNodeWriteLockCount()).toBe(0);
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

  it("defaults legacy sessions to web search disabled", async () => {
    const projectId = "legacy-session-project";
    const projectDir = path.join(rootDir, projectId);
    await mkdir(path.join(projectDir, "chat", "feature-design"), { recursive: true });
    await writeFile(
      path.join(projectDir, "chat", "feature-design", "index.json"),
      JSON.stringify([
        {
          id: "s-legacy",
          nodeId: "feature-design",
          name: "Legacy",
          messageCount: 0,
          createdAt: "2026-06-14T10:00:00.000Z",
          updatedAt: "2026-06-14T10:00:00.000Z",
        },
      ]),
    );
    await writeFile(
      path.join(projectDir, "chat", "feature-design", "s-legacy.json"),
      JSON.stringify([]),
    );

    const store = new ProjectStore(rootDir);
    const sessions = await store.listSessions(projectId, "feature-design");
    expect(sessions[0].webSearchEnabled).toBe(false);
  });

  it("defaults new sessions to web search disabled", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");
    expect(session.webSearchEnabled).toBe(false);
  });

  it("updates web search without changing message metadata", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    await store.appendChatMessage(project.id, "feature-design", {
      id: "m-1",
      role: "user",
      content: "问题",
      createdAt: "2026-06-14T11:01:00.000Z",
    }, session.id);

    const updated = await store.updateSessionWebSearch(project.id, "feature-design", session.id, true);
    expect(updated.webSearchEnabled).toBe(true);
    expect(updated.messageCount).toBe(1);
    expect(updated.updatedAt).toBe("2026-06-14T11:01:00.000Z");
  });

  it("persists assistant external sources", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const source = {
      id: "src-1",
      kind: "provided_url" as const,
      url: "https://example.com/",
      title: "Example",
      domain: "example.com",
      snippet: "片段",
      retrievedAt: "2026-06-14T11:01:00.000Z",
    };

    await store.appendChatMessage(project.id, "feature-design", {
      id: "a-1",
      role: "assistant",
      content: "参考结论",
      sources: [source],
      createdAt: "2026-06-14T11:01:00.000Z",
    }, session.id);

    const messages = await store.getChatMessages(project.id, "feature-design", session.id);
    expect(messages[0].sources).toEqual([source]);
  });

  it("persists and reloads assistant turn usage, turnId, and reasoningDurationMs", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const usage = {
      turnId: "turn-1",
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      source: "exact" as const,
      callCount: 1,
      calls: [
        {
          id: "c-1",
          category: "answer" as const,
          providerId: "mp-1",
          model: "test-model",
          source: "exact" as const,
          status: "completed" as const,
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
        },
      ],
    };

    const message = {
      id: "a-1",
      role: "assistant" as const,
      content: "已更新。",
      reasoningContent: "先分析。",
      createdAt: "2026-06-14T11:01:00.000Z",
      turnId: "turn-1",
      reasoningDurationMs: 1234,
      usage,
    };

    await store.appendChatMessage(project.id, "feature-design", message, session.id);

    const reloaded = await store.getChatMessages(project.id, "feature-design", session.id);
    expect(reloaded[0]).toEqual(message);
  });

  it("still loads legacy assistant messages without usage/turnId/reasoningDurationMs", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    await store.appendChatMessage(project.id, "feature-design", {
      id: "a-legacy",
      role: "assistant",
      content: "旧消息",
      createdAt: "2026-06-14T11:01:00.000Z",
    }, session.id);

    const messages = await store.getChatMessages(project.id, "feature-design", session.id);
    expect(messages[0].usage).toBeUndefined();
    expect(messages[0].turnId).toBeUndefined();
    expect(messages[0].reasoningDurationMs).toBeUndefined();
    expect(messages[0].content).toBe("旧消息");
  });

  it("getSession returns the matching session", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const fetched = await store.getSession(project.id, "feature-design", session.id);
    expect(fetched.id).toBe(session.id);
  });

  it("getSession rejects an unknown session id", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    await expect(store.getSession(project.id, "feature-design", "missing")).rejects.toThrow("会话不存在");
  });

  it("updateSessionWebSearch rejects an unknown session id", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    await expect(
      store.updateSessionWebSearch(project.id, "feature-design", "missing", true),
    ).rejects.toThrow("会话不存在");
  });

  describe("listExports", () => {
    it("returns existing export files with size/mtime and skips missing ones", async () => {
      const store = new ProjectStore(rootDir);
      const project = await store.createProject({
        name: "T",
        now: "2026-06-14T10:00:00.000Z",
      });
      await writeFile(store.exportPath(project.id, "PROJECT_DESIGN.md"), "hello world", "utf8");
      await writeFile(store.exportPath(project.id, "项目开发设计文档.docx"), "PK");

      const files = await store.listExports(project.id);

      expect(files.map((f) => f.filename)).toEqual(["PROJECT_DESIGN.md", "项目开发设计文档.docx"]);
      const md = files.find((f) => f.filename === "PROJECT_DESIGN.md")!;
      expect(md.size).toBe(11);
      expect(md.mtime).toBeGreaterThan(0);
      expect(files.find((f) => f.filename === "SPEC.md")).toBeUndefined();
    });

    it("returns an empty array when no exports exist", async () => {
      const store = new ProjectStore(rootDir);
      const project = await store.createProject({ name: "T", now: "2026-06-14T10:00:00.000Z" });
      const files = await store.listExports(project.id);
      expect(files).toEqual([]);
    });
  });
});
