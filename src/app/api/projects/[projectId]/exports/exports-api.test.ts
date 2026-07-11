import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelStreamPart } from "@/lib/project/model-chat";
import { POST } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

vi.mock("@/lib/project/model-chat", () => ({
  streamModelChat: vi.fn(async function* (): AsyncGenerator<ModelStreamPart> {
    yield { type: "content", content: "## 项目概述\n\n综合前言。\n\n## 1. 项目基本信息\n\n综合正文。" };
  }),
}));

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-export-api-"));
  process.cwd = () => tmpDir;

  await cp(path.join(originalCwd(), "agents"), path.join(tmpDir, "agents"), { recursive: true });

  const projectsDir = path.join(tmpDir, "projects", "test-project");
  await mkdir(path.join(projectsDir, "nodes"), { recursive: true });
  await mkdir(path.join(projectsDir, "exports"), { recursive: true });

  const project = {
    id: "test-project",
    name: "测试项目",
    customerName: "客户",
    authorName: "团队",
    version: "v0.1",
    createdAt: "2026-06-14T10:00:00.000Z",
    updatedAt: "2026-06-14T10:00:00.000Z",
  };
  await writeFile(path.join(projectsDir, "project.json"), JSON.stringify(project, null, 2), "utf8");
  await writeFile(
    path.join(projectsDir, "nodes", "basic-info.json"),
    JSON.stringify(
      {
        id: "basic-info",
        status: "confirmed",
        markdown: "# 项目基本信息\n\n原始正文。",
        revision: 1,
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );

  const settingsDir = path.join(tmpDir, "settings");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, "model-providers.json"),
    JSON.stringify(
      [
        {
          id: "mp-1",
          name: "TestProvider",
          apiBaseUrl: "https://api.test.com/v1",
          apiKey: "sk-test",
          protocol: "chat_completions",
          models: [{ name: "test-model", isDefault: true, toolCalling: false }],
          isDefault: true,
          createdAt: "2026-06-14T10:00:00.000Z",
          updatedAt: "2026-06-14T10:00:00.000Z",
        },
      ],
      null,
      2,
    ),
    "utf8",
  );

  vi.mocked(await import("@/lib/project/model-chat")).streamModelChat.mockClear();
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

function baseRequest(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/projects/test-project/exports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "mp-1",
      model: "test-model",
      reasoningEffort: "medium",
      ...overrides,
    }),
  });
}

describe("POST /api/projects/[projectId]/exports", () => {
  it("synthesizes via streamModelChat and writes files with master content", async () => {
    const { streamModelChat } = await import("@/lib/project/model-chat");
    const res = await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) });
    expect(res.status).toBe(200);
    expect(vi.mocked(streamModelChat)).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.files.map((f: { filename: string }) => f.filename)).toEqual([
      "PROJECT_DESIGN.md",
      "项目开发设计文档.docx",
      "SPEC.md",
      "TASKS.md",
      "AGENTS.md",
    ]);
    const md = await readFile(
      path.join(tmpDir, "projects", "test-project", "exports", "PROJECT_DESIGN.md"),
      "utf8",
    );
    expect(md).toContain("综合前言");
    expect(md).not.toContain("原始正文");
  });

  it("returns 400 when providerId is missing", async () => {
    const res = await POST(baseRequest({ providerId: undefined }), {
      params: Promise.resolve({ projectId: "test-project" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 502 when synthesis throws", async () => {
    const { streamModelChat } = await import("@/lib/project/model-chat");
    vi.mocked(streamModelChat).mockImplementationOnce(
      async function* (): AsyncGenerator<ModelStreamPart> {
        throw new Error("upstream");
      },
    );
    const res = await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) });
    expect(res.status).toBe(502);
  });
});
