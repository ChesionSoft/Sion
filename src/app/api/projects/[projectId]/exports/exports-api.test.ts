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

const DEFAULT_BLUEPRINT_REVISION = {
  ops: [{ op: "update", sectionId: "executive-summary", fields: { rationale: "修订后的理由" } }],
};
const DEFAULT_DRAFT_REVISION = {
  ops: [{ op: "replace", heading: "执行摘要", body: "修订后的正文。" }],
};

vi.mock("@/lib/project/model-chat", () => ({
  streamModelChat: vi.fn(async function* ({
    messages,
  }: {
    messages: { role: string; content: string }[];
  }): AsyncGenerator<ModelStreamPart> {
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    if (sys.includes("蓝图的修订编辑")) {
      yield { type: "content", content: "```json\n" + JSON.stringify(DEFAULT_BLUEPRINT_REVISION) + "\n```" };
    } else if (sys.includes("正文的修订编辑")) {
      yield { type: "content", content: "```json\n" + JSON.stringify(DEFAULT_DRAFT_REVISION) + "\n```" };
    } else if (sys.includes("JSON 对象")) {
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

async function setupBlueprint(): Promise<string> {
  const res = await postOp("blueprint");
  return (await res.json()).digest as string;
}

async function setupApprovedBlueprintAndDraft(): Promise<{ bpDigest: string; draftDigest: string }> {
  const bpDigest = await setupBlueprint();
  await postOp("approve_blueprint", { artifactDigest: bpDigest });
  const draftRes = await postOp("draft");
  const draftDigest = (await draftRes.json()).digest as string;
  return { bpDigest, draftDigest };
}

async function mockModelOnce(content: string): Promise<void> {
  const { streamModelChat } = await import("@/lib/project/model-chat");
  vi.mocked(streamModelChat).mockImplementationOnce(
    async function* (): AsyncGenerator<ModelStreamPart> {
      yield { type: "content", content };
    },
  );
}

describe("POST edit_blueprint / edit_draft", () => {
  it("edits a blueprint with valid line-format markdown and clears approvals/draft state", async () => {
    const originalDigest = await setupBlueprint();
    const edited = [
      "# 正式 PRD 导出蓝图",
      "",
      "## 执行摘要",
      "- id: executive-summary",
      "- inclusion: confirmed-summary",
      "- presentation: paragraphs",
      "- source: basic-info",
      "- headings: 背景",
      "- rationale: 编辑后的理由",
    ].join("\n");
    const res = await postOp("edit_blueprint", { markdown: edited });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage.blueprintDigest).toBeTruthy();
    expect(body.stage.blueprintDigest).not.toBe(originalDigest);
    expect(body.stage.blueprintApprovedDigest).toBeUndefined();
    expect(body.stage.draftDigest).toBeUndefined();
    const md = await readFile(
      path.join(tmpDir, "projects", "test-project", "exports", "export-blueprint.md"),
      "utf8",
    );
    expect(md).toContain("编辑后的理由");
  });

  it("returns 422 when the edited blueprint has a section missing id", async () => {
    await setupBlueprint();
    const bad = [
      "# 蓝图",
      "",
      "## 执行摘要",
      "- inclusion: omit",
      "- presentation: paragraphs",
      "- source: -",
      "- headings: -",
      "- rationale: r",
    ].join("\n");
    const res = await postOp("edit_blueprint", { markdown: bad });
    expect(res.status).toBe(422);
  });

  it("returns 409 when no blueprint exists", async () => {
    const res = await postOp("edit_blueprint", {
      markdown: [
        "# 蓝图",
        "",
        "## 执行摘要",
        "- id: x",
        "- inclusion: omit",
        "- presentation: paragraphs",
        "- source: -",
        "- headings: -",
        "- rationale: r",
      ].join("\n"),
    });
    expect(res.status).toBe(409);
  });

  it("edits a draft and clears QA/approval", async () => {
    const { draftDigest } = await setupApprovedBlueprintAndDraft();
    const res = await postOp("edit_draft", { markdown: "## 执行摘要\n\n编辑后的正文。" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage.draftDigest).toBeTruthy();
    expect(body.stage.draftDigest).not.toBe(draftDigest);
    expect(body.stage.draftApprovedDigest).toBeUndefined();
    expect(body.stage.qaStatus).toBeUndefined();
    const md = await readFile(
      path.join(tmpDir, "projects", "test-project", "exports", "formal-prd-draft.md"),
      "utf8",
    );
    expect(md).toContain("编辑后的正文。");
  });

  it("returns 422 when the edited draft contains 待确认", async () => {
    await setupApprovedBlueprintAndDraft();
    const res = await postOp("edit_draft", { markdown: "## 执行摘要\n\n待确认：补充内容。" });
    expect(res.status).toBe(422);
  });

  it("returns 409 when the draft's blueprint is no longer approved", async () => {
    await setupApprovedBlueprintAndDraft();
    const statePath = path.join(tmpDir, "projects", "test-project", "exports", "formal-prd-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.blueprintApprovedDigest = "no-longer-matching";
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
    const res = await postOp("edit_draft", { markdown: "## 执行摘要\n\n正文。" });
    expect(res.status).toBe(409);
  });
});

describe("POST revise_blueprint / revise_draft", () => {
  it("applies a blueprint revision patch from the model", async () => {
    const bpDigest = await setupBlueprint();
    const res = await postOp("revise_blueprint", {
      instruction: "更新执行摘要理由",
      artifactDigest: bpDigest,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage.blueprintDigest).not.toBe(bpDigest);
    expect(Array.isArray(body.applied)).toBe(true);
    expect(body.applied.some((r: { status: string }) => r.status === "applied")).toBe(true);
  });

  it("applies a draft revision patch and reports a skipped missing heading", async () => {
    const { draftDigest } = await setupApprovedBlueprintAndDraft();
    await mockModelOnce(
      "```json\n" +
        JSON.stringify({
          ops: [
            { op: "replace", heading: "不存在", body: "x" },
            { op: "replace", heading: "执行摘要", body: "修订后的正文。" },
          ],
        }) +
        "\n```",
    );
    const res = await postOp("revise_draft", { instruction: "修订正文", artifactDigest: draftDigest });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toHaveLength(2);
    expect(body.applied.filter((r: { status: string }) => r.status === "skipped")).toHaveLength(1);
    expect(body.applied.filter((r: { status: string }) => r.status === "applied")).toHaveLength(1);
    const md = await readFile(
      path.join(tmpDir, "projects", "test-project", "exports", "formal-prd-draft.md"),
      "utf8",
    );
    expect(md).toContain("修订后的正文。");
  });

  it("returns 409 for a stale supplied digest (blueprint)", async () => {
    await setupBlueprint();
    const res = await postOp("revise_blueprint", { instruction: "x", artifactDigest: "stale" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when the blueprint changes while a revision is waiting on the model", async () => {
    const digest = await setupBlueprint();
    const { streamModelChat } = await import("@/lib/project/model-chat");
    let signalStarted!: () => void;
    let releaseModel!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    vi.mocked(streamModelChat).mockImplementationOnce(async function* (): AsyncGenerator<ModelStreamPart> {
      signalStarted();
      await released;
      yield {
        type: "content",
        content: "```json\n" + JSON.stringify(DEFAULT_BLUEPRINT_REVISION) + "\n```",
      };
    });

    const pendingRevision = postOp("revise_blueprint", { instruction: "更新理由", artifactDigest: digest });
    await started;
    const edit = await postOp("edit_blueprint", {
      markdown: [
        "# 正式 PRD 导出蓝图",
        "",
        "## 执行摘要",
        "- id: executive-summary",
        "- inclusion: confirmed-summary",
        "- presentation: paragraphs",
        "- source: basic-info",
        "- headings: 背景",
        "- rationale: 同时编辑后的理由",
      ].join("\n"),
    });
    expect(edit.status).toBe(200);
    releaseModel();

    expect((await pendingRevision).status).toBe(409);
  });

  it("returns 409 when the draft is absent", async () => {
    const bpDigest = await setupBlueprint();
    await postOp("approve_blueprint", { artifactDigest: bpDigest });
    const res = await postOp("revise_draft", { instruction: "x", artifactDigest: "any" });
    expect(res.status).toBe(409);
  });

  it("returns 502 when the model returns malformed JSON", async () => {
    const bpDigest = await setupBlueprint();
    await mockModelOnce("这不是 JSON");
    const res = await postOp("revise_blueprint", { instruction: "x", artifactDigest: bpDigest });
    expect(res.status).toBe(502);
  });

  it("returns 422 when every draft patch op is skipped", async () => {
    const { draftDigest } = await setupApprovedBlueprintAndDraft();
    await mockModelOnce(
      "```json\n" + JSON.stringify({ ops: [{ op: "replace", heading: "不存在", body: "x" }] }) + "\n```",
    );
    const res = await postOp("revise_draft", { instruction: "x", artifactDigest: draftDigest });
    expect(res.status).toBe(422);
  });

  it("returns 422 and leaves the draft unchanged when a patch introduces TBD", async () => {
    const { draftDigest } = await setupApprovedBlueprintAndDraft();
    const draftPath = path.join(tmpDir, "projects", "test-project", "exports", "formal-prd-draft.md");
    const before = await readFile(draftPath, "utf8");
    await mockModelOnce(
      "```json\n" +
        JSON.stringify({ ops: [{ op: "replace", heading: "执行摘要", body: "此处内容 TBD。" }] }) +
        "\n```",
    );
    const res = await postOp("revise_draft", { instruction: "x", artifactDigest: draftDigest });
    expect(res.status).toBe(422);
    const after = await readFile(draftPath, "utf8");
    expect(after).toBe(before);
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
