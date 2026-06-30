import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "@/lib/project/store";
import { POST } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

async function setupProjectFixture() {
  // Set up a project with nodes
  const projectsDir = path.join(tmpDir, "projects", "test-project");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(projectsDir, "nodes"), { recursive: true });
  await mkdir(path.join(projectsDir, "chat", "basic-info"), { recursive: true });
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
    // Create chat dir and session index
    await mkdir(path.join(projectsDir, "chat", nid), { recursive: true });
    await writeFile(path.join(projectsDir, "chat", nid, "index.json"), JSON.stringify([{
      id: "sess-1",
      nodeId: nid,
      name: "测试会话",
      messageCount: 0,
      createdAt: "2026-06-14T10:00:00.000Z",
      updatedAt: "2026-06-14T10:00:00.000Z",
    }]), "utf8");
    await writeFile(path.join(projectsDir, "chat", nid, "sess-1.json"), JSON.stringify([]), "utf8");
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
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-rewrite-api-"));
  process.cwd = () => tmpDir;

  // Copy agents directory
  const agentsSrc = path.join(originalCwd(), "agents");
  await cp(agentsSrc, path.join(tmpDir, "agents"), { recursive: true });
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("rewrite API", () => {
  it("returns 404 when the project does not exist", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/missing/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", model: "m", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "missing", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "项目不存在" });
  });

  it("returns 404 for an unknown node id", async () => {
    await setupProjectFixture();
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/unknown/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", model: "m", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "unknown" }) },
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when providerId is missing", async () => {
    await setupProjectFixture();
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", model: "m", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when model is missing", async () => {
    await setupProjectFixture();
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when expectedRevision is missing", async () => {
    await setupProjectFixture();
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", model: "m" }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when sessionId is missing", async () => {
    await setupProjectFixture();
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ providerId: "mp-1", model: "test-model", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(400);
  });

  it("uses only the requested node session as rewrite chat context", async () => {
    await setupProjectFixture();
    const store = new ProjectStore();
    const selected = await store.createSession("test-project", "basic-info", "2026-06-14T11:00:00.000Z");
    const other = await store.createSession("test-project", "basic-info", "2026-06-14T12:00:00.000Z");
    await store.appendChatMessage("test-project", "basic-info", {
      id: "selected-message",
      role: "user",
      content: "只属于选中会话的结论",
      createdAt: "2026-06-14T11:01:00.000Z",
    }, selected.id);
    await store.appendChatMessage("test-project", "basic-info", {
      id: "other-message",
      role: "user",
      content: "不应进入提示词的其他会话",
      createdAt: "2026-06-14T12:01:00.000Z",
    }, other.id);

    const validContent = [
      "# 项目基本信息",
      "## 已确认内容",
      "内容",
      "## 基础信息表",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 名称 | 测试 |",
      "## 项目边界",
      "内容",
      "## 设计假设",
      "- 暂无。",
      "## 待确认问题",
      "- 暂无。",
    ].join("\n\n");
    let llmRequestBody = "";
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init?: RequestInit) => {
      llmRequestBody = String(init?.body ?? "");
      const encoder = new TextEncoder();
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: validContent } }] })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      };
    }) as unknown as typeof fetch;

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({
          sessionId: selected.id,
          providerId: "mp-1",
          model: "test-model",
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    await response.text();

    expect(llmRequestBody).toContain("只属于选中会话的结论");
    expect(llmRequestBody).not.toContain("不应进入提示词的其他会话");
  });

  it("returns 400 when provider does not exist", async () => {
    await setupProjectFixture();
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "nonexistent", model: "m", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(400);
  });

  it("emits markdown_conflict via SSE when revision is stale", async () => {
    await setupProjectFixture();
    // Bump the node's revision to 1
    const store = new ProjectStore();
    await store.updateProjectNode("test-project", "basic-info", { markdown: "# basic-info\n\nupdated" });

    // Mock LLM to return valid markdown
    const validContent = [
      "# 项目基本信息",
      "",
      "## 已确认内容",
      "",
      "确认内容已更新",
      "",
      "## 基础信息表",
      "",
      "| 字段 | 值 |",
      "|------|-----|",
      "| 名称 | 测试 |",
      "",
      "## 项目边界",
      "",
      "无边界限制",
      "",
      "## 设计假设",
      "",
      "- 假设1",
      "",
      "## 待确认问题",
      "",
      "- 问题1",
    ].join("\n");

    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const escaped = validContent.replace(/"/g, '\\"').replace(/\n/g, "\\n");
          controller.enqueue(
            encoder.encode(`data: {"choices":[{"delta":{"content":"${escaped}"}}]}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    })) as unknown as typeof fetch;

    // Request with stale expectedRevision 0 — no upfront 409, route generates then CAS fails
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", model: "test-model", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allData += decoder.decode(value, { stream: true });
    }

    const events = allData
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));

    const conflictEvent = events.find(
      (e: Record<string, unknown>) => e.type === "markdown_conflict",
    ) as Record<string, unknown> | undefined;
    expect(conflictEvent).toBeDefined();
    const latestNode = conflictEvent!.latestNode as Record<string, unknown>;
    expect(latestNode.revision).toBe(1);
    expect(conflictEvent!.candidateMarkdown).toBe(validContent);

    // No markdown_done since CAS failed
    const doneEvent = events.find((e: Record<string, unknown>) => e.type === "markdown_done");
    expect(doneEvent).toBeUndefined();

    // Disk is unchanged — node still has bumped content at revision 1
    const raw = await readFile(
      path.join(tmpDir, "projects", "test-project", "nodes", "basic-info.json"),
      "utf8",
    );
    const nodeAfter = JSON.parse(raw);
    expect(nodeAfter.revision).toBe(1);
    expect(nodeAfter.markdown).toBe("# basic-info\n\nupdated");
  });

  it("streams SSE events on successful rewrite", async () => {
    await setupProjectFixture();

    // Mock fetch to return valid SSE for the rewrite prompt
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          // Return valid basic-info markdown
          const content = [
            "# 项目基本信息",
            "",
            "## 已确认内容",
            "",
            "确认内容已更新",
            "",
            "## 基础信息表",
            "",
            "| 字段 | 值 |",
            "|------|-----|",
            "| 名称 | 测试 |",
            "",
            "## 项目边界",
            "",
            "无边界限制",
            "",
            "## 设计假设",
            "",
            "- 假设1",
            "",
            "## 待确认问题",
            "",
            "- 问题1",
          ].join("\n");

          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${content.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"}}]}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    } as unknown as Response);

    // Mock both fetch calls: the rewrite LLM call, and no other calls
    globalThis.fetch = fetchMock;

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", model: "test-model", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allData += decoder.decode(value, { stream: true });
    }

    // Check the SSE line content
    const lines = allData.trim().split("\n");
    const events = lines
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));

    const firstEvent = events[0];
    expect(firstEvent).toMatchObject({ type: "markdown_start", mode: "rewrite", baseRevision: expect.any(Number) });

    const lastEvent = events[events.length - 1];
    expect(lastEvent).toMatchObject({ type: "markdown_done" });
    expect(lastEvent.updatedNode).toBeDefined();
    expect(lastEvent.updatedNode.revision).toBe(1);
    expect(lastEvent.updatedNode.status).toBe("generated");
    expect(lastEvent.updatedNode.markdown).toContain("# 项目基本信息");
    expect(lastEvent.updatedNode.markdown).toContain("## 已确认内容");

    // Should have at least one token event
    const tokenEvents = events.filter((e: Record<string, unknown>) => e.type === "markdown_token");
    expect(tokenEvents.length).toBeGreaterThan(0);
  });

  it("emits markdown_error on validation failure and does NOT write disk", async () => {
    await setupProjectFixture();

    // Mock LLM to return markdown MISSING required section "## 项目边界"
    const invalidContent = [
      "# 项目基本信息",
      "",
      "## 基础信息表",
      "",
      "| 字段 | 值 |",
      "|------|-----|",
      "| 名称 | 测试 |",
      // Missing "## 项目边界" section — required by schema
    ].join("\n");

    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const escaped = invalidContent.replace(/"/g, '\\"').replace(/\n/g, "\\n");
          controller.enqueue(
            encoder.encode(`data: {"choices":[{"delta":{"content":"${escaped}"}}]}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    })) as unknown as typeof fetch;

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", model: "test-model", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allData += decoder.decode(value, { stream: true });
    }

    const events = allData
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));

    const errorEvent = events.find(
      (e: Record<string, unknown>) => e.type === "markdown_error",
    ) as Record<string, unknown> | undefined;
    expect(errorEvent).toBeDefined();
    expect(typeof errorEvent!.error).toBe("string");

    // No markdown_done since validation failed
    const doneEvent = events.find((e: Record<string, unknown>) => e.type === "markdown_done");
    expect(doneEvent).toBeUndefined();

    // Disk unchanged — revision stays 0
    const raw = await readFile(
      path.join(tmpDir, "projects", "test-project", "nodes", "basic-info.json"),
      "utf8",
    );
    const nodeAfter = JSON.parse(raw);
    expect(nodeAfter.revision).toBe(0);
    expect(nodeAfter.markdown).toBe("# basic-info\n\n测试内容");
  });

  it("emits markdown_error on LLM error and does NOT write disk", async () => {
    await setupProjectFixture();

    // Mock fetch to return non-200
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", model: "test-model", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allData += decoder.decode(value, { stream: true });
    }

    const events = allData
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));

    const errorEvent = events.find(
      (e: Record<string, unknown>) => e.type === "markdown_error",
    ) as Record<string, unknown> | undefined;
    expect(errorEvent).toBeDefined();
    expect(typeof errorEvent!.error).toBe("string");

    // Disk unchanged
    const raw = await readFile(
      path.join(tmpDir, "projects", "test-project", "nodes", "basic-info.json"),
      "utf8",
    );
    const nodeAfter = JSON.parse(raw);
    expect(nodeAfter.revision).toBe(0);
    expect(nodeAfter.markdown).toBe("# basic-info\n\n测试内容");
  });

  it("handles abort without writing to disk", async () => {
    await setupProjectFixture();

    // Create a promise that resolves when the fetch body stream controller is available
    let bodyController: ReadableStreamDefaultController | null = null;
    let bodyControllerReady: () => void;
    const bodyControllerReadyPromise = new Promise<void>((resolve) => {
      bodyControllerReady = resolve;
    });

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            bodyController = controller;
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(`data: {"choices":[{"delta":{"content":"hello"}}]}\n\n`),
            );
            bodyControllerReady();
            // Never close — we abort the request to end the stream
          },
        }),
      };
    }) as unknown as typeof fetch;

    const abortController = new AbortController();

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-1", providerId: "mp-1", model: "test-model", expectedRevision: 0 }),
        signal: abortController.signal,
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );

    expect(response.status).toBe(200);

    // Wait for the body stream to be set up and one token to be sent
    await bodyControllerReadyPromise;
    await new Promise((r) => setTimeout(r, 10));

    // Abort the request — route will close its SSE controller early
    abortController.abort();

    // Close the hanging body stream so the reader resolves
    bodyController!.close();

    // Read SSE events from the response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allData += decoder.decode(value, { stream: true });
    }

    // No markdown_done event (route closes early on abort)
    const events = allData
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const doneEvent = events.find((e: Record<string, unknown>) => e.type === "markdown_done");
    expect(doneEvent).toBeUndefined();

    // Disk unchanged
    const raw = await readFile(
      path.join(tmpDir, "projects", "test-project", "nodes", "basic-info.json"),
      "utf8",
    );
    const nodeAfter = JSON.parse(raw);
    expect(nodeAfter.revision).toBe(0);
    expect(nodeAfter.markdown).toBe("# basic-info\n\n测试内容");
  });
});
