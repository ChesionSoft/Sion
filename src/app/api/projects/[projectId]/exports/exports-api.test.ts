import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelStreamPart } from "@/lib/project/model-chat";
import { GET, POST } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

const BLUEPRINT_OBJECT = {
  title: "正式 PRD 导出蓝图",
  sections: [
    {
      id: "executive-summary",
      title: "执行摘要",
      inclusion: "confirmed-summary",
      presentation: "paragraphs",
      sourceNodeIds: ["basic-info"],
      sourceHeadings: ["背景"],
      rationale: "向外部说明已确认的建设目标",
    },
  ],
};

const DRAFT_MD = "## 执行摘要\n\n已确认背景内容。";

vi.mock("@/lib/project/model-chat", () => ({
  streamModelChat: vi.fn(async function* ({
    messages,
  }: {
    messages: { role: string; content: string }[];
  }): AsyncGenerator<ModelStreamPart> {
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    if (sys.includes("JSON 对象")) {
      yield { type: "content", content: "```json\n" + JSON.stringify(BLUEPRINT_OBJECT) + "\n```" };
    } else if (sys.includes("撰稿编辑")) {
      yield { type: "content", content: DRAFT_MD };
    } else {
      yield { type: "content", content: "" };
    }
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
        markdown: "# 项目基本信息\n\n## 背景\n\n原始正文。",
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

const params = { params: Promise.resolve({ projectId: "test-project" }) };

function postOp(operation: string, overrides: Record<string, unknown> = {}) {
  return POST(
    new Request("http://localhost/api/projects/test-project/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "mp-1",
        model: "test-model",
        reasoningEffort: "medium",
        operation,
        ...overrides,
      }),
    }),
    params,
  );
}

describe("POST /api/projects/[projectId]/exports (staged)", () => {
  it("writes a reviewable blueprint before it writes a formal draft", async () => {
    const res = await postOp("blueprint");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.digest).toBeTruthy();
    expect(body.stage.blueprintDigest).toBeTruthy();
    const md = await readFile(
      path.join(tmpDir, "projects", "test-project", "exports", "export-blueprint.md"),
      "utf8",
    );
    expect(md).toContain("导出蓝图");
    expect(md).toContain("执行摘要");
  });

  it("refuses finalization until the exact blueprint and draft are approved", async () => {
    const res = await postOp("finalize");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ error: expect.stringContaining("先确认") }));
  });

  it("refuses draft generation until the blueprint is approved", async () => {
    const res = await postOp("draft");
    expect(res.status).toBe(409);
  });

  it("approves the blueprint with a matching digest and enables draft generation", async () => {
    const bp = await postOp("blueprint");
    const digest = (await bp.json()).digest;
    const approve = await postOp("approve_blueprint", { artifactDigest: digest });
    expect(approve.status).toBe(200);
    const draft = await postOp("draft");
    expect(draft.status).toBe(200);
    const md = await readFile(
      path.join(tmpDir, "projects", "test-project", "exports", "formal-prd-draft.md"),
      "utf8",
    );
    expect(md).toContain("已确认背景内容");
  });

  it("rejects approve_blueprint with a stale digest", async () => {
    const approve = await postOp("approve_blueprint", { artifactDigest: "stale" });
    expect(approve.status).toBe(409);
  });

  it("returns 400 for an unknown operation", async () => {
    const res = await postOp("bogus");
    expect(res.status).toBe(400);
  });

  it("returns 400 when blueprint is requested without a model", async () => {
    const res = await postOp("blueprint", { providerId: undefined, model: undefined });
    expect(res.status).toBe(400);
  });

  it("returns 502 when the blueprint model throws", async () => {
    const { streamModelChat } = await import("@/lib/project/model-chat");
    vi.mocked(streamModelChat).mockImplementationOnce(
      async function* (): AsyncGenerator<ModelStreamPart> {
        throw new Error("upstream");
      },
    );
    const res = await postOp("blueprint");
    expect(res.status).toBe(502);
  });
});

describe("GET /api/projects/[projectId]/exports", () => {
  it("lists existing export files and the current stage", async () => {
    await writeFile(
      path.join(tmpDir, "projects", "test-project", "exports", "PROJECT_DESIGN.md"),
      "# 设计",
      "utf8",
    );
    const res = await GET(new Request("http://localhost/api/projects/test-project/exports"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.map((f: { filename: string }) => f.filename)).toEqual(["PROJECT_DESIGN.md"]);
    expect(body.files[0].size).toBe(Buffer.byteLength("# 设计", "utf8"));
    expect(body.stage).toBeDefined();
  });

  it("returns an empty files array and a default stage when nothing is exported yet", async () => {
    const res = await GET(new Request("http://localhost/api/projects/test-project/exports"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toEqual([]);
    expect(body.stage).toEqual({ updatedAt: "" });
  });

  it("returns 404 for a missing project", async () => {
    const res = await GET(new Request("http://localhost/api/projects/nope/exports"), {
      params: Promise.resolve({ projectId: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});