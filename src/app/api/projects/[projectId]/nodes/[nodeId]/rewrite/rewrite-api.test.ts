import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await mkdir(path.join(projectsDir, "chat", "basic-info", "sess-1"), { recursive: true });
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
    await writeFile(
      path.join(projectsDir, "chat", nid, "sessions.json"),
      JSON.stringify([]),
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
        body: JSON.stringify({ providerId: "mp-1", model: "m", expectedRevision: 0 }),
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
        body: JSON.stringify({ providerId: "mp-1", model: "m", expectedRevision: 0 }),
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
        body: JSON.stringify({ model: "m", expectedRevision: 0 }),
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
        body: JSON.stringify({ providerId: "mp-1", expectedRevision: 0 }),
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
        body: JSON.stringify({ providerId: "mp-1", model: "m" }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when provider does not exist", async () => {
    await setupProjectFixture();
    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ providerId: "nonexistent", model: "m", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 409 when revision is already stale", async () => {
    await setupProjectFixture();
    // Bump revision by PATCH-ing first
    const store = new ProjectStore();
    await store.updateProjectNode("test-project", "basic-info", { markdown: "# 项目基本信息\n\nupdated" });

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/nodes/basic-info/rewrite", {
        method: "POST",
        body: JSON.stringify({ providerId: "mp-1", model: "m", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "test-project", nodeId: "basic-info" }) },
    );
    expect(response.status).toBe(409);
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
        body: JSON.stringify({ providerId: "mp-1", model: "test-model", expectedRevision: 0 }),
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
    expect(lastEvent.updatedNode.status).toBe("draft");
    expect(lastEvent.updatedNode.markdown).toContain("# 项目基本信息");
    expect(lastEvent.updatedNode.markdown).toContain("## 已确认内容");

    // Should have at least one token event
    const tokenEvents = events.filter((e: Record<string, unknown>) => e.type === "markdown_token");
    expect(tokenEvents.length).toBeGreaterThan(0);
  });
});