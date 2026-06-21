import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "@/lib/project/store";
import type { ExternalSource, NodeMarkdownPatch } from "@/lib/project/types";
import { POST } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

// Mock judgeNodeFacts so we control its results without real LLM calls
vi.mock("@/lib/project/node-fact-judge", () => ({
  judgeNodeFacts: vi.fn(),
}));

// Mock URL reader so we control read results without real network calls
vi.mock("@/lib/project/url-reader", () => ({
  readPublicUrls: vi.fn(async () => [] as unknown[]),
  UrlReadError: class UrlReadError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = "UrlReadError";
    }
  },
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

    // Strict event ordering: token* -> markdown_check_start -> markdown_unchanged -> done
    expect(types.indexOf("markdown_check_start")).toBeGreaterThan(0);
    expect(types.indexOf("markdown_check_start")).toBeLessThan(types.indexOf("markdown_unchanged"));
    expect(types.indexOf("markdown_unchanged")).toBeLessThan(types.indexOf("done"));
    expect(types.filter((t) => t === "done")).toHaveLength(1);
    expect(types.indexOf("done")).toBe(types.length - 1);

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

    // Strict event ordering: token* -> markdown_check_start -> markdown_start -> markdown_patch_preview -> done
    expect(types.indexOf("markdown_check_start")).toBeGreaterThan(0);
    expect(types.indexOf("markdown_check_start")).toBeLessThan(types.indexOf("markdown_start"));
    expect(types.indexOf("markdown_start")).toBeLessThan(types.indexOf("markdown_patch_preview"));
    // There could be multiple patch_preview events; ensure at least one comes before done
    const firstPatchIdx = types.indexOf("markdown_patch_preview");
    expect(firstPatchIdx).toBeGreaterThanOrEqual(0);
    expect(firstPatchIdx).toBeLessThan(types.indexOf("done"));
    expect(types.filter((t) => t === "done")).toHaveLength(1);
    expect(types.indexOf("done")).toBe(types.length - 1);

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

    // Strict event ordering: token* -> markdown_check_start -> markdown_unchanged(with warning) -> done
    expect(types.indexOf("markdown_check_start")).toBeGreaterThan(0);
    expect(types.indexOf("markdown_check_start")).toBeLessThan(types.indexOf("markdown_unchanged"));
    expect(types.indexOf("markdown_unchanged")).toBeLessThan(types.indexOf("done"));
    expect(types.filter((t) => t === "done")).toHaveLength(1);
    expect(types.indexOf("done")).toBe(types.length - 1);

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

  it("handles abort during streaming: no patch preview, no node write", async () => {
    const requestAbortController = new AbortController();
    const encoder = new TextEncoder();

    // Override fetch with a stream that hangs after 2 chunks, reacting to abort signal
    globalThis.fetch = vi.fn().mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;

      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先判断节点目标。"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"已更新"}}]}\n\n'));
        },
        pull(controller) {
          return new Promise<void>((resolve) => {
            if (signal?.aborted) {
              controller.error(new DOMException("Aborted", "AbortError"));
              resolve();
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                controller.error(new DOMException("Aborted", "AbortError"));
                resolve();
              },
              { once: true },
            );
          });
        },
      });

      return { ok: true, body };
    });

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "优化功能设计",
          providerId: "mp-1",
          model: "test-model",
        }),
        signal: requestAbortController.signal,
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    expect(response.status).toBe(200);

    // Read SSE events, abort after seeing at least one token
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
      if (events.some((e) => e.type === "token")) {
        requestAbortController.abort();
      }
    }

    // No patch preview — interrupt happened before judge
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).not.toContain("markdown_patch_preview");
    // No done event — client disconnected mid-stream
    expect(eventTypes).not.toContain("done");
    // We did see the streamed tokens before abort
    expect(eventTypes).toContain("reasoning");
    expect(eventTypes).toContain("token");

    // Node disk revision unchanged — no node write
    const store = new ProjectStore();
    const rev = await getNodeRevision(store, "test-project", "feature-design");
    expect(rev).toBe(0);
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

  it("reads URLs from the user message and emits url_read_start/result with search disabled", async () => {
    const { readPublicUrls } = await import("@/lib/project/url-reader");
    const source: ExternalSource = {
      id: "src-1",
      kind: "provided_url",
      url: "https://example.com/",
      title: "Example",
      domain: "example.com",
      snippet: "片段",
      retrievedAt: "2026-06-21T00:00:00.000Z",
    };
    vi.mocked(readPublicUrls).mockResolvedValueOnce([
      { ok: true, requestedUrl: "https://example.com/", source, content: "正文" },
    ]);

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "看下 https://example.com/ 这个文档",
          providerId: "mp-1",
          model: "test-model",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);

    expect(types).toContain("url_read_start");
    expect(types).toContain("url_read_result");
    expect(types).toContain("token");
    expect(types).toContain("done");
    // Chat completions + no search enabled → no web_search_unavailable, no source events from search
    expect(types).not.toContain("web_search_unavailable");

    const startEvent = events.find((e) => e.type === "url_read_start") as { urls: string[] };
    expect(startEvent.urls).toEqual(["https://example.com/"]);

    const resultEvent = events.find((e) => e.type === "url_read_result") as {
      url: string;
      ok: boolean;
      source?: ExternalSource;
    };
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.source?.url).toBe("https://example.com/");

    // External context is appended after user message — check fetch body includes UNTRUSTED EXTERNAL MATERIAL
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const userContent = body.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userContent).toContain("UNTRUSTED EXTERNAL MATERIAL");
    expect(userContent).toContain("https://example.com/");
  });

  it("emits url_read_result failure without aborting the chat", async () => {
    const { readPublicUrls } = await import("@/lib/project/url-reader");
    vi.mocked(readPublicUrls).mockResolvedValueOnce([
      { ok: false, requestedUrl: "https://bad.test/", error: "不允许访问非公网地址", code: "blocked_address" },
    ]);

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "读一下 https://bad.test/",
          providerId: "mp-1",
          model: "test-model",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);

    expect(types).toContain("url_read_start");
    const resultEvent = events.find((e) => e.type === "url_read_result") as {
      url: string;
      ok: boolean;
      error?: string;
    };
    expect(resultEvent.ok).toBe(false);
    expect(resultEvent.error).toBe("不允许访问非公网地址");
    expect(types).toContain("token");
    expect(types).toContain("done");
  });

  it("emits web_search_unavailable for chat_completions providers when the session switch is on", async () => {
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await store.updateSessionWebSearch("test-project", "feature-design", session.id, true);

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "查一下客户管理的最佳实践",
          providerId: "mp-1",
          model: "test-model",
          sessionId: session.id,
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);
    expect(types).toContain("web_search_unavailable");
    expect(types).toContain("token");
    expect(types).toContain("done");

    // The chat completions request body must NOT include tools
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { tools?: unknown };
    expect(body.tools).toBeUndefined();
  });

  it("does not inject a hosted web_search tool for openai_responses even when the session switch is on", async () => {
    const settingsDir = path.join(tmpDir, "settings");
    await writeFile(
      path.join(settingsDir, "model-providers.json"),
      JSON.stringify([
        {
          id: "mp-resp",
          name: "OpenAI Responses",
          apiBaseUrl: "https://api.openai.com",
          apiKey: "sk-test",
          protocol: "openai_responses",
          models: [{ name: "gpt-5", isDefault: true }],
          isDefault: false,
          createdAt: "2026-06-14T10:00:00.000Z",
          updatedAt: "2026-06-14T10:00:00.000Z",
        },
      ], null, 2),
      "utf8",
    );

    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await store.updateSessionWebSearch("test-project", "feature-design", session.id, true);

    const encoder = new TextEncoder();
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"答案"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"r","output":[{"id":"i","type":"message","content":[{"type":"output_text","text":"答案"}]}]}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: sseBody });

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "查一下 gpt-5 的最新用法",
          providerId: "mp-resp",
          model: "gpt-5",
          sessionId: session.id,
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);
    expect(types).toContain("token");

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
    // Hosted web_search is retired; protocol never injects it.
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body.tools ?? [])).not.toContain('"web_search"');
  });

  it("does not add web_search tools for openai_responses when the session switch is off", async () => {
    const settingsDir = path.join(tmpDir, "settings");
    await writeFile(
      path.join(settingsDir, "model-providers.json"),
      JSON.stringify([
        {
          id: "mp-resp",
          name: "OpenAI Responses",
          apiBaseUrl: "https://api.openai.com",
          apiKey: "sk-test",
          protocol: "openai_responses",
          models: [{ name: "gpt-5", isDefault: true }],
          isDefault: false,
          createdAt: "2026-06-14T10:00:00.000Z",
          updatedAt: "2026-06-14T10:00:00.000Z",
        },
      ], null, 2),
      "utf8",
    );

    const encoder = new TextEncoder();
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"答案"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"r","output":[{"id":"i","type":"message","content":[{"type":"output_text","text":"答案"}]}]}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: sseBody });

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "你好",
          providerId: "mp-resp",
          model: "gpt-5",
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );
    await readSseEvents(response);

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
    expect(body.tools).toBeUndefined();
  });

  it("persists assistant sources from URL reads and adapter", async () => {
    const { readPublicUrls } = await import("@/lib/project/url-reader");
    const source: ExternalSource = {
      id: "src-1",
      kind: "provided_url",
      url: "https://example.com/",
      title: "Example",
      domain: "example.com",
      snippet: "片段",
      retrievedAt: "2026-06-21T00:00:00.000Z",
    };
    vi.mocked(readPublicUrls).mockResolvedValueOnce([
      { ok: true, requestedUrl: "https://example.com/", source, content: "正文" },
    ]);

    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "看 https://example.com/ 并总结",
          providerId: "mp-1",
          model: "test-model",
          sessionId: session.id,
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );
    await readSseEvents(response);

    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.sources).toBeDefined();
    expect(assistant?.sources?.map((s) => s.url)).toContain("https://example.com/");
  });

  it("abort stops URL reads and does not append unseen sources", async () => {
    const { readPublicUrls } = await import("@/lib/project/url-reader");
    const ac = new AbortController();

    // URL read resolves only after abort fires
    vi.mocked(readPublicUrls).mockImplementationOnce(async () => {
      return new Promise((resolve) => {
        ac.signal.addEventListener("abort", () => {
          resolve([]);
        });
      });
    });

    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await POST(
      new Request(
        "http://localhost/api/projects/test-project/chat",
        {
          method: "POST",
          body: JSON.stringify({
            nodeId: "feature-design",
            message: "查 https://example.com/",
            providerId: "mp-1",
            model: "test-model",
            sessionId: session.id,
          }),
          signal: ac.signal,
        },
      ),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    // Start reading, then abort before URLs resolve
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(value).toBeDefined();
    ac.abort();
    // Drain to completion
    while (true) {
      const { done } = await reader.read().catch(() => ({ done: true } as ReadableStreamReadResult<Uint8Array>));
      if (done) break;
    }

    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    const assistant = messages.find((m) => m.role === "assistant");
    // No assistant message persisted (URL read never resolved, model never called)
    expect(assistant).toBeUndefined();
  });
});