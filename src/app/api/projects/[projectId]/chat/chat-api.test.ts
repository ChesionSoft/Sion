import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      models: ["test-model"],
      defaultModel: "test-model",
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

  // Mock fetch for LLM call
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "已更新功能设计。" } }],
    }),
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
    const data = (await response.json()) as {
      messages: Array<{ role: string; content: string }>;
      assistantContent: string;
    };
    expect(data.assistantContent).toBe("已更新功能设计。");
    expect(data.messages).toHaveLength(2);
  });
});
