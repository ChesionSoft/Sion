import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "@/lib/project/store";
import type { NodeMarkdownPatch } from "@/lib/project/types";
import { POST } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

// Mock judgeNodeFacts so we control its results without real LLM calls
vi.mock("@/lib/project/node-fact-judge", () => ({
  judgeNodeFacts: vi.fn(),
}));

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-chat-test-"));
  // Override cwd so stores use tmpDir
  process.cwd = () => tmpDir;

  // Copy agents directory for agent rule loading
  const agentsSrc = path.join(originalCwd(), "agents");
  await cp(agentsSrc, path.join(tmpDir, "agents"), { recursive: true });

  // Set up a project
  const projectsDir = path.join(tmpDir, "projects", "test-project");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(projectsDir, "nodes"), { recursive: true });
  await mkdir(path.join(projectsDir, "chat"), { recursive: true });
  await mkdir(path.join(projectsDir, "exports"), { recursive: true });

  const project = {
    id: "test-project",
    name: "测试项目",
    customerName: "",
    authorName: "",
    version: "V1.0",
    createdAt: "2026-06-14T10:00:00.000Z",
    updatedAt: "2026-06-14T10:00:00.000Z",
  };
  await writeFile(
    path.join(projectsDir, "project.json"),
    JSON.stringify(project, null, 2),
    "utf8",
  );

  const nodeIds = [
    "basic-info", "goals", "roles-permissions", "business-flow",
    "feature-design", "page-interaction", "data-structure", "api-design",
    "architecture-deployment", "development-tasks", "risks-open-questions", "final-export",
  ];
  for (const nid of nodeIds) {
    const node = {
      id: nid,
      status: "draft",
      markdown: `# ${nid}\n\n测试内容`,
      revision: 0,
      updatedAt: "2026-06-14T10:00:00.000Z",
    };
    await writeFile(
      path.join(projectsDir, "nodes", `${nid}.json`),
      JSON.stringify(node, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(projectsDir, "chat", `${nid}.json`),
      "[]",
      "utf8",
    );
  }

  // Set up model provider
  const settingsDir = path.join(tmpDir, "settings");
  await mkdir(settingsDir, { recursive: true });
  const providers = [
    {
      id: "mp-1",
      name: "TestProvider",
      apiBaseUrl: "https://api.test.com/v1",
      apiKey: "sk-test",
      models: [{ name: "test-model", isDefault: true }],
      isDefault: true,
      createdAt: "2026-06-14T10:00:00.000Z",
      updatedAt: "2026-06-14T10:00:00.000Z",
    },
  ];
  await writeFile(
    path.join(settingsDir, "model-providers.json"),
    JSON.stringify(providers, null, 2),
    "utf8",
  );

  // Mock fetch for LLM call — returns SSE stream
  const encoder = new TextEncoder();
  const sseBody = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先判断节点目标。"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"已更新功能设计。"}}]}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: sseBody,
  });

  // Reset judgeNodeFacts mock to default (no changes)
  const { judgeNodeFacts } = await import("@/lib/project/node-fact-judge");
  vi.mocked(judgeNodeFacts).mockReset();
  vi.mocked(judgeNodeFacts).mockResolvedValue({ ok: true, decision: { changes: [] } });
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

async function readSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      events.push(JSON.parse(trimmed.slice(6)) as Record<string, unknown>);
    }
  }

  return events;
}

async function getNodeRevision(store: ProjectStore, projectId: string, nodeId: string): Promise<number> {
  const nodes = await store.getProjectNodes(projectId);
  const node = nodes.find((n) => n.id === nodeId);
  return node?.revision ?? -1;
}

describe("chat API", () => {
  it("rejects when providerId is missing", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "测试消息",
          model: "test-model",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("请先配置并选择大模型");
  });

  it("rejects when model is missing", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "测试消息",
          providerId: "mp-1",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("请选择模型");
  });

  it("resolves provider credentials server-side and returns assistant response with judge events", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "请优化功能模块设计",
          providerId: "mp-1",
          model: "test-model",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    // Read SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const reasoning: string[] = [];
    const tokens: string[] = [];
    let doneSessionId = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        try {
          const event = JSON.parse(payload) as { type: string; content?: string; sessionId?: string };
          if (event.type === "reasoning" && event.content) reasoning.push(event.content);
          if (event.type === "token" && event.content) tokens.push(event.content);
          if (event.type === "done" && event.sessionId) doneSessionId = event.sessionId;
        } catch { /* skip */ }
      }
    }

    expect(reasoning.join("")).toBe("先判断节点目标。");
    expect(tokens.join("")).toBe("已更新功能设计。");
    expect(doneSessionId).toBeTruthy();
    const [, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    const requestBody = JSON.parse(String(requestInit?.body)) as { reasoning_effort?: string };
    expect(requestBody.reasoning_effort).toBe("medium");
  });

  it("emits correct event sequence when judge returns no changes", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "消息",
          providerId: "mp-1",
          model: "test-model",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);

    // token -> markdown_check_start -> markdown_unchanged -> done
    expect(types).toContain("token");
    expect(types).toContain("markdown_check_start");
    expect(types).toContain("markdown_unchanged");
    expect(types).toContain("done");

    // No markdown_start or markdown_patch_preview
    expect(types).not.toContain("markdown_start");
    expect(types).not.toContain("markdown_patch_preview");

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(typeof doneEvent!.sessionId).toBe("string");
    // done must NOT carry updatedNode
    expect(doneEvent).not.toHaveProperty("updatedNode");

    const unchangedEvent = events.find((e) => e.type === "markdown_unchanged");
    expect(unchangedEvent).toBeDefined();
    expect(unchangedEvent!.warning).toBeUndefined();

    // Node must NOT be written (revision still 0)
    const store = new ProjectStore();
    const rev = await getNodeRevision(store, "test-project", "feature-design");
    expect(rev).toBe(0);
  });

  it("emits patch preview events when judge returns changes", async () => {
    const changesPatch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "confirmed",
      patchKind: "append_bullet",
      markdown: "- 客户管理功能包含 CRUD",
      evidence: { source: "user", quote: "客户管理" },
    };

    const { judgeNodeFacts } = await import("@/lib/project/node-fact-judge");
    vi.mocked(judgeNodeFacts).mockResolvedValueOnce({
      ok: true,
      decision: { changes: [changesPatch] },
    });

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "加入客户管理",
          providerId: "mp-1",
          model: "test-model",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);

    // token -> markdown_check_start -> markdown_start -> markdown_patch_preview -> done
    expect(types).toContain("token");
    expect(types).toContain("markdown_check_start");
    expect(types).toContain("markdown_start");
    expect(types).toContain("markdown_patch_preview");
    expect(types).toContain("done");

    const startEvent = events.find((e) => e.type === "markdown_start");
    expect(startEvent!.mode).toBe("increment");
    expect(startEvent!.baseRevision).toBe(0); // matches fixture node revision

    const previewEvent = events.find((e) => e.type === "markdown_patch_preview");
    expect(previewEvent!.patch).toEqual(changesPatch);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).not.toHaveProperty("updatedNode");

    // Node must NOT be written (chat route only previews)
    const store = new ProjectStore();
    const rev = await getNodeRevision(store, "test-project", "feature-design");
    expect(rev).toBe(0);
  });

  it("emits markdown_unchanged with warning on judge failure", async () => {
    const { judgeNodeFacts } = await import("@/lib/project/node-fact-judge");
    vi.mocked(judgeNodeFacts).mockResolvedValueOnce({
      ok: false,
      error: "judge failed",
    });

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "消息",
          providerId: "mp-1",
          model: "test-model",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);

    expect(types).toContain("token");
    expect(types).toContain("markdown_check_start");
    expect(types).toContain("markdown_unchanged");
    expect(types).toContain("done");
    expect(types).not.toContain("markdown_start");
    expect(types).not.toContain("markdown_patch_preview");

    const unchangedEvent = events.find((e) => e.type === "markdown_unchanged");
    expect(unchangedEvent!.warning).toBe("judge failed");

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).not.toHaveProperty("updatedNode");

    // Node not written
    const store = new ProjectStore();
    const rev = await getNodeRevision(store, "test-project", "feature-design");
    expect(rev).toBe(0);
  });

  it("appends messages to the provided chat session and does not write node", async () => {
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "继续优化功能模块设计",
          providerId: "mp-1",
          model: "test-model",
          sessionId: session.id,
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    expect(response.status).toBe(200);

    // Consume the stream
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Verify messages were persisted and node was NOT written
    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("已更新功能设计。");
    expect(messages[1].reasoningContent).toBe("先判断节点目标。");

    // Node revision must still be 0 (chat route does NOT write nodes)
    const nodes = await store.getProjectNodes("test-project");
    const node = nodes.find((n) => n.id === "feature-design");
    expect(node?.revision).toBe(0);
  });

  it("returns 404 for an invalid chat session", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "测试消息",
          providerId: "mp-1",
          model: "test-model",
          sessionId: "missing-session",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "会话不存在" });
  });
});