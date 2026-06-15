import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "@/lib/project/store";
import { POST } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

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
      assumptions: [],
      openQuestions: [],
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
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

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

  it("resolves provider credentials server-side and returns assistant response", async () => {
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

  it("appends messages to the provided chat session", async () => {
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

    // Verify messages were persisted
    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("已更新功能设计。");
    expect(messages[1].reasoningContent).toBe("先判断节点目标。");
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
