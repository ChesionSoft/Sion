import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "@/lib/project/store";
import type { ExternalSource, ModelCallUsage, NodeMarkdownPatch } from "@/lib/project/types";
import type { WebOrchestratorEvent } from "@/lib/project/web-tool-orchestrator";
import { POST } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

// A synthetic answer usage record the mocked orchestrator reports.
const ANSWER_USAGE: ModelCallUsage = {
  id: "c-answer",
  category: "answer",
  providerId: "mp-1",
  model: "test-model",
  source: "exact",
  status: "completed",
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
};

// A synthetic fact_judge usage record the mocked judge reports.
const JUDGE_USAGE: ModelCallUsage = {
  id: "c-judge",
  category: "fact_judge",
  providerId: "mp-1",
  model: "test-model",
  source: "exact",
  status: "completed",
  inputTokens: 8,
  outputTokens: 2,
  totalTokens: 10,
};

// Mock judgeNodeFacts so we control its results without real LLM calls.
vi.mock("@/lib/project/node-fact-judge", () => ({
  judgeNodeFacts: vi.fn(),
}));

// Mock the browser web service so no Playwright/network is touched.
vi.mock("@/lib/project/browser-web-service", () => ({
  createBrowserWebService: vi.fn(() => ({
    search: vi.fn(async () => ({ ok: true, results: [] })),
    fetch: vi.fn(async (input: { url: string }) => ({ ok: true, url: input.url, content: "x" })),
  })),
}));

// Mock the Playwright loader so no real playwright-core runtime is imported.
vi.mock("@/lib/project/playwright-loader", () => ({
  loadPlaywright: vi.fn(async () => ({ chromium: {} })),
}));

// Capture the orchestrator input and yield a configurable event sequence.
let orchestratorInput: Record<string, unknown> | null = null;
let orchestratorEvents: WebOrchestratorEvent[] = [
  { type: "reasoning", delta: "先判断节点目标。" },
  { type: "content", delta: "已更新功能设计。" },
];
// Whether the mocked orchestrator reports a synthetic answer usage record.
let orchestratorReportsUsage = true;

vi.mock("@/lib/project/web-tool-orchestrator", () => ({
  runWebOrchestrator: vi.fn(async function* (input: Record<string, unknown>): AsyncGenerator<WebOrchestratorEvent> {
    orchestratorInput = input;
    if (orchestratorReportsUsage && typeof input.onUsage === "function") {
      input.onUsage(ANSWER_USAGE);
    }
    for (const e of orchestratorEvents) yield e;
  }),
}));

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-chat-test-"));
  process.cwd = () => tmpDir;

  const agentsSrc = path.join(originalCwd(), "agents");
  await cp(agentsSrc, path.join(tmpDir, "agents"), { recursive: true });

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
  await writeFile(path.join(projectsDir, "project.json"), JSON.stringify(project, null, 2), "utf8");

  const nodeIds = [
    "basic-info", "goals", "roles-permissions", "business-flow",
    "feature-design", "page-interaction", "data-structure", "api-design",
    "architecture-deployment", "development-tasks", "risks-open-questions", "final-export",
  ];
  for (const nid of nodeIds) {
    const node = { id: nid, status: "draft", markdown: `# ${nid}\n\n测试内容`, revision: 0, updatedAt: "2026-06-14T10:00:00.000Z" };
    await writeFile(path.join(projectsDir, "nodes", `${nid}.json`), JSON.stringify(node, null, 2), "utf8");
    await writeFile(path.join(projectsDir, "chat", `${nid}.json`), "[]", "utf8");
  }

  const settingsDir = path.join(tmpDir, "settings");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, "model-providers.json"),
    JSON.stringify([
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
    ], null, 2),
    "utf8",
  );

  orchestratorInput = null;
  orchestratorEvents = [
    { type: "reasoning", delta: "先判断节点目标。" },
    { type: "content", delta: "已更新功能设计。" },
  ];
  orchestratorReportsUsage = true;

  const { judgeNodeFacts } = await import("@/lib/project/node-fact-judge");
  vi.mocked(judgeNodeFacts).mockReset();
  vi.mocked(judgeNodeFacts).mockImplementation(async (input: Record<string, unknown>) => {
    if (typeof input.onUsage === "function") input.onUsage(JUDGE_USAGE);
    return { ok: true, decision: { changes: [] } };
  });
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

function baseRequest(overrides: Record<string, unknown> = {}, signal?: AbortSignal) {
  return new Request("http://localhost/api/projects/test-project/chat", {
    method: "POST",
    body: JSON.stringify({
      nodeId: "feature-design",
      message: "请优化功能模块设计",
      providerId: "mp-1",
      model: "test-model",
      ...overrides,
    }),
    ...(signal ? { signal } : {}),
  });
}

describe("chat API routing", () => {
  it("rejects when providerId is missing", async () => {
    const response = await POST(baseRequest({ providerId: undefined }), { params: Promise.resolve({ projectId: "test-project" }) });
    expect(response.status).toBe(400);
  });

  it("rejects when model is missing", async () => {
    const response = await POST(baseRequest({ model: undefined }), { params: Promise.resolve({ projectId: "test-project" }) });
    expect(response.status).toBe(400);
  });

  it("returns 404 for an invalid chat session", async () => {
    const response = await POST(baseRequest({ sessionId: "missing-session" }), { params: Promise.resolve({ projectId: "test-project" }) });
    expect(response.status).toBe(404);
  });

  it("passes the model toolCalling flag to the orchestrator (tool-capable)", async () => {
    const settingsDir = path.join(tmpDir, "settings");
    await writeFile(
      path.join(settingsDir, "model-providers.json"),
      JSON.stringify([
        { id: "mp-1", name: "T", apiBaseUrl: "https://api.test.com/v1", apiKey: "sk", protocol: "chat_completions", models: [{ name: "test-model", isDefault: true, toolCalling: true }], isDefault: true, createdAt: "x", updatedAt: "x" },
      ], null, 2),
      "utf8",
    );
    await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    expect(orchestratorInput?.toolCalling).toBe(true);
  });

  it("passes toolCalling=false for a fallback model", async () => {
    await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    expect(orchestratorInput?.toolCalling).toBe(false);
  });

  it("passes searchEnabled from the persisted session setting", async () => {
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await store.updateSessionWebSearch("test-project", "feature-design", session.id, true);
    await readSseEvents(await POST(baseRequest({ sessionId: session.id }), { params: Promise.resolve({ projectId: "test-project" }) }));
    expect(orchestratorInput?.searchEnabled).toBe(true);
  });

  it("passes searchEnabled=false by default", async () => {
    await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    expect(orchestratorInput?.searchEnabled).toBe(false);
  });

  it("extracts direct URLs from the user message and passes them to the orchestrator", async () => {
    await readSseEvents(
      await POST(baseRequest({ message: "看下 https://example.com/a 和 https://example.com/b" }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );
    expect(orchestratorInput?.directUrls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("adds link-read guidance to the system prompt when the message contains a URL", async () => {
    // Without this, models that pattern-match on the raw link reply
    // "I can't access links" even though the fetched content is provided.
    await readSseEvents(
      await POST(baseRequest({ message: "测试 https://example.com/a 你能访问吗" }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );
    const sys = orchestratorInput?.systemPrompt as string;
    expect(sys).toContain("链接读取说明");
    expect(sys).toMatch(/不要.*无法访问|不要.*没有联网|不要.*联网功能/);
  });

  it("does not add link-read guidance when the message has no URL", async () => {
    await readSseEvents(
      await POST(baseRequest({ message: "请优化功能模块设计" }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );
    const sys = orchestratorInput?.systemPrompt as string;
    expect(sys).not.toContain("链接读取说明");
  });

  it("passes the configured search engine", async () => {
    await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    expect(orchestratorInput?.engine).toBe("google"); // default preference
  });

  it("passes prior session messages as history and keeps the current message as userMessage", async () => {
    // Regression: the model only saw the system prompt + the latest message,
    // so it forgot earlier Q&A and re-asked already-answered questions.
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await store.appendChatMessage(
      "test-project",
      "feature-design",
      { id: "u1", role: "user", content: "之前问的", createdAt: "2026-06-14T11:01:00.000Z" },
      session.id,
    );
    await store.appendChatMessage(
      "test-project",
      "feature-design",
      { id: "a1", role: "assistant", content: "之前答的", createdAt: "2026-06-14T11:02:00.000Z" },
      session.id,
    );

    await readSseEvents(
      await POST(
        baseRequest({ sessionId: session.id, message: "新的问题" }),
        { params: Promise.resolve({ projectId: "test-project" }) },
      ),
    );

    const history = orchestratorInput?.history as { type: string; role: string; content: string }[] | undefined;
    expect(history).toBeDefined();
    expect(history?.map((m) => [m.role, m.content])).toEqual([
      ["user", "之前问的"],
      ["assistant", "之前答的"],
    ]);
    // The current message is delivered via userMessage, not duplicated in history.
    expect(orchestratorInput?.userMessage).toBe("新的问题");
    expect(history?.some((m) => m.content === "新的问题")).toBe(false);
  });

  it("skips empty assistant turns when building history", async () => {
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await store.appendChatMessage(
      "test-project",
      "feature-design",
      { id: "u1", role: "user", content: "之前问的", createdAt: "2026-06-14T11:01:00.000Z" },
      session.id,
    );
    // A failed turn persisted with empty content must not appear in history.
    await store.appendChatMessage(
      "test-project",
      "feature-design",
      { id: "a1", role: "assistant", content: "", createdAt: "2026-06-14T11:02:00.000Z" },
      session.id,
    );

    await readSseEvents(
      await POST(
        baseRequest({ sessionId: session.id, message: "继续" }),
        { params: Promise.resolve({ projectId: "test-project" }) },
      ),
    );

    const history = orchestratorInput?.history as { role: string; content: string }[] | undefined;
    expect(history?.map((m) => [m.role, m.content])).toEqual([["user", "之前问的"]]);
  });
});

describe("chat API SSE and persistence", () => {
  it("maps orchestrator content/reasoning to token/reasoning and persists the assistant message", async () => {
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    const events = await readSseEvents(
      await POST(baseRequest({ sessionId: session.id }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );
    const reasoning = events.filter((e) => e.type === "reasoning").map((e) => e.content).join("");
    const tokens = events.filter((e) => e.type === "token").map((e) => e.content).join("");
    expect(reasoning).toBe("先判断节点目标。");
    expect(tokens).toBe("已更新功能设计。");
    expect(events.some((e) => e.type === "done")).toBe(true);

    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("已更新功能设计。");
    expect(assistant?.reasoningContent).toBe("先判断节点目标。");
  });

  it("emits markdown_check_start -> markdown_unchanged -> done when judge returns no changes", async () => {
    const events = await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    const types = events.map((e) => e.type);
    expect(types).toContain("markdown_check_start");
    expect(types).toContain("markdown_unchanged");
    expect(types).toContain("done");
    expect(types.indexOf("markdown_check_start")).toBeLessThan(types.indexOf("markdown_unchanged"));
    expect(types.indexOf("markdown_unchanged")).toBeLessThan(types.indexOf("done"));
    const store = new ProjectStore();
    expect(await getNodeRevision(store, "test-project", "feature-design")).toBe(0);
  });

  it("emits markdown_start and markdown_patch_preview when judge returns changes", async () => {
    const changesPatch: NodeMarkdownPatch = {
      category: "confirmed_fact",
      targetSectionKey: "confirmed",
      patchKind: "append_bullet",
      markdown: "- 客户管理功能包含 CRUD",
      evidence: { source: "user", quote: "客户管理" },
    };
    const { judgeNodeFacts } = await import("@/lib/project/node-fact-judge");
    vi.mocked(judgeNodeFacts).mockResolvedValueOnce({ ok: true, decision: { changes: [changesPatch] } });
    const events = await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    const types = events.map((e) => e.type);
    expect(types).toContain("markdown_start");
    expect(types).toContain("markdown_patch_preview");
    const preview = events.find((e) => e.type === "markdown_patch_preview") as { patch: NodeMarkdownPatch };
    expect(preview.patch).toEqual(changesPatch);
  });

  it("emits markdown_unchanged with warning on judge failure", async () => {
    const { judgeNodeFacts } = await import("@/lib/project/node-fact-judge");
    vi.mocked(judgeNodeFacts).mockResolvedValueOnce({ ok: false, error: "judge failed" });
    const events = await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    const unchanged = events.find((e) => e.type === "markdown_unchanged") as { warning?: string };
    expect(unchanged.warning).toBe("judge failed");
  });

  it("persists only the sources emitted by the orchestrator (deduped)", async () => {
    const source: ExternalSource = {
      id: "src-1", kind: "web_search", url: "https://example.com/page",
      title: "Ex", domain: "example.com", snippet: "s", retrievedAt: "2026-06-21T00:00:00.000Z",
    };
    orchestratorEvents = [
      { type: "source", source },
      { type: "source", source }, // duplicate
      { type: "content", delta: "答案" },
    ];
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await readSseEvents(await POST(baseRequest({ sessionId: session.id }), { params: Promise.resolve({ projectId: "test-project" }) }));
    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.sources).toHaveLength(1);
    expect(assistant?.sources?.[0].url).toBe("https://example.com/page");
  });

  it("does not infer a search notice from chat_completions protocol", async () => {
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await store.updateSessionWebSearch("test-project", "feature-design", session.id, true);
    const events = await readSseEvents(await POST(baseRequest({ sessionId: session.id }), { params: Promise.resolve({ projectId: "test-project" }) }));
    expect(events.map((e) => e.type)).not.toContain("notice");
  });

  it("does not infer a search notice from openai_responses protocol", async () => {
    const settingsDir = path.join(tmpDir, "settings");
    await writeFile(
      path.join(settingsDir, "model-providers.json"),
      JSON.stringify([
        { id: "mp-resp", name: "R", apiBaseUrl: "https://api.openai.com", apiKey: "sk", protocol: "openai_responses", models: [{ name: "gpt-5", isDefault: true, toolCalling: true }], isDefault: true, createdAt: "x", updatedAt: "x" },
      ], null, 2),
      "utf8",
    );
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await store.updateSessionWebSearch("test-project", "feature-design", session.id, true);
    const events = await readSseEvents(
      await POST(baseRequest({ providerId: "mp-resp", model: "gpt-5", sessionId: session.id }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );
    expect(events.map((e) => e.type)).not.toContain("notice");
    expect(events.map((e) => e.type)).toContain("token");
  });

  it("maps browser_verification_required without a challenge URL", async () => {
    orchestratorEvents = [
      { type: "browser_verification_required", verificationId: "v-1", engine: "google" },
      { type: "content", delta: "答案" },
    ];
    const events = await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    const verif = events.find((e) => e.type === "browser_verification_required") as Record<string, unknown>;
    expect(verif).toBeDefined();
    expect(verif.verificationId).toBe("v-1");
    expect(JSON.stringify(verif)).not.toContain("challengeUrl");
  });

  it("continues with an ordinary answer when all web operations fail", async () => {
    orchestratorEvents = [
      { type: "web_search_start", query: "x" },
      { type: "web_search_result", query: "x", ok: false, code: "browser_unavailable", message: "down" },
      { type: "notice", message: "搜索失败" },
      { type: "content", delta: "尽力回答" },
    ];
    const events = await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    const types = events.map((e) => e.type);
    expect(types).toContain("token");
    expect(types).toContain("done");
    expect(events.filter((e) => e.type === "source")).toHaveLength(0);
  });

  it("maps web_search/web_fetch events to SSE", async () => {
    orchestratorEvents = [
      { type: "web_search_start", query: "q" },
      { type: "web_search_result", query: "q", ok: true, results: [{ title: "t", url: "https://e.com/1", rank: 1 }] },
      { type: "web_fetch_start", url: "https://e.com/1" },
      { type: "web_fetch_result", url: "https://e.com/1", ok: true, content: "body" },
      { type: "source", source: { id: "s", kind: "web_search", url: "https://e.com/1", title: "t", domain: "e.com", snippet: "b", retrievedAt: "x" } },
      { type: "content", delta: "答案" },
    ];
    const events = await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    const types = events.map((e) => e.type);
    expect(types).toContain("web_search_start");
    expect(types).toContain("web_search_result");
    expect(types).toContain("web_fetch_start");
    expect(types).toContain("web_fetch_result");
    expect(types).toContain("source");
  });

  it("sanitizes orchestrator errors and does not leak raw messages", async () => {
    const { runWebOrchestrator } = await import("@/lib/project/web-tool-orchestrator");
    vi.mocked(runWebOrchestrator).mockImplementationOnce(async function* () {
      throw new Error("boom at /Users/secret");
    });
    const events = await readSseEvents(await POST(baseRequest(), { params: Promise.resolve({ projectId: "test-project" }) }));
    const err = events.find((e) => e.type === "error") as { error?: string };
    expect(err).toBeDefined();
    expect(err.error).not.toContain("/Users/secret");
  });

  it("handles abort: no done event, no node write", async () => {
    const ac = new AbortController();
    const { runWebOrchestrator } = await import("@/lib/project/web-tool-orchestrator");
    vi.mocked(runWebOrchestrator).mockImplementationOnce(async function* (input: Record<string, unknown>) {
      orchestratorInput = input;
      yield { type: "content", delta: "部分" };
      // Wait for abort, then stop yielding.
      const signal = input.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const response = await POST(baseRequest({}, ac.signal), { params: Promise.resolve({ projectId: "test-project" }) });
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
        if (trimmed.startsWith("data: ")) events.push(JSON.parse(trimmed.slice(6)) as Record<string, unknown>);
      }
      if (events.some((e) => e.type === "token")) ac.abort();
    }
    expect(events.map((e) => e.type)).not.toContain("done");
    const store = new ProjectStore();
    expect(await getNodeRevision(store, "test-project", "feature-design")).toBe(0);
  });
});

describe("chat API activity and authoritative final message", () => {
  it("streams ordered activity stages and a done event with the persisted assistant message", async () => {
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    const events = await readSseEvents(
      await POST(baseRequest({ sessionId: session.id }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );

    const stages = events.filter((e) => e.type === "activity").map((e) => (e as { stage: string }).stage);
    expect(stages).toEqual(expect.arrayContaining(["thinking", "generating_answer", "updating_document", "completed"]));
    expect(stages.indexOf("thinking")).toBeLessThan(stages.indexOf("generating_answer"));
    expect(stages.indexOf("generating_answer")).toBeLessThan(stages.indexOf("updating_document"));

    const done = events.find((e) => e.type === "done") as { sessionId: string; assistantMessage: { turnId: string; usage: { callCount: number } } };
    expect(done).toBeDefined();
    expect(done.sessionId).toBe(session.id);
    expect(done.assistantMessage.turnId).toEqual(expect.any(String));
    expect(done.assistantMessage.usage.callCount).toBe(2);

    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.turnId).toBe(done.assistantMessage.turnId);
    expect(assistant?.usage?.callCount).toBe(2);
    expect(assistant?.reasoningDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits a reading_files activity when files are selected", async () => {
    const { FileStore } = await import("@/lib/project/files");
    const fileStore = new FileStore();
    const record = await fileStore.uploadFile("test-project", {
      name: "note.txt",
      buffer: Buffer.from("笔记内容", "utf8"),
    });
    const events = await readSseEvents(
      await POST(baseRequest({ fileIds: [record.id] }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );
    const stages = events.filter((e) => e.type === "activity").map((e) => (e as { stage: string }).stage);
    expect(stages).toContain("reading_files");
  });

  it("emits a searching_web activity when web search is enabled", async () => {
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    await store.updateSessionWebSearch("test-project", "feature-design", session.id, true);
    const events = await readSseEvents(
      await POST(baseRequest({ sessionId: session.id }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );
    const stages = events.filter((e) => e.type === "activity").map((e) => (e as { stage: string }).stage);
    expect(stages).toContain("searching_web");
  });

  it("does not include unsupported selected files in the model prompt", async () => {
    const { FileStore } = await import("@/lib/project/files");
    const fileStore = new FileStore();
    const unsupported = await fileStore.uploadFile("test-project", {
      name: "legacy.doc",
      buffer: Buffer.from("do not send this", "utf8"),
      mimeType: "application/msword",
    });

    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-23T10:00:00.000Z");
    const events = await readSseEvents(
      await POST(
        baseRequest({ sessionId: session.id, fileIds: [unsupported.id] }),
        { params: Promise.resolve({ projectId: "test-project" }) },
      ),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(JSON.stringify(orchestratorInput)).not.toContain("do not send this");
  });

  it("on a non-abort error, persists partial content and returns it with a failed activity and error", async () => {
    const { runWebOrchestrator } = await import("@/lib/project/web-tool-orchestrator");
    vi.mocked(runWebOrchestrator).mockImplementationOnce(async function* () {
      yield { type: "content", delta: "部分回复" };
      throw new Error("boom at /Users/secret");
    });
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    const events = await readSseEvents(
      await POST(baseRequest({ sessionId: session.id }), { params: Promise.resolve({ projectId: "test-project" }) }),
    );

    const stages = events.filter((e) => e.type === "activity").map((e) => (e as { stage: string }).stage);
    expect(stages).toContain("failed");
    const err = events.find((e) => e.type === "error") as { error: string; assistantMessage?: { content: string } };
    expect(err).toBeDefined();
    expect(err.error).not.toContain("/Users/secret");
    expect(err.assistantMessage).toBeDefined();
    expect(err.assistantMessage?.content).toBe("部分回复");

    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("部分回复");
  });

  it("aborted: persists partial content without a done event", async () => {
    const ac = new AbortController();
    const { runWebOrchestrator } = await import("@/lib/project/web-tool-orchestrator");
    vi.mocked(runWebOrchestrator).mockImplementationOnce(async function* (input: Record<string, unknown>) {
      orchestratorInput = input;
      yield { type: "content", delta: "部分" };
      const signal = input.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const store = new ProjectStore();
    const session = await store.createSession("test-project", "feature-design", "2026-06-14T11:00:00.000Z");
    const response = await POST(baseRequest({ sessionId: session.id }, ac.signal), { params: Promise.resolve({ projectId: "test-project" }) });
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
        if (trimmed.startsWith("data: ")) events.push(JSON.parse(trimmed.slice(6)) as Record<string, unknown>);
      }
      if (events.some((e) => e.type === "token")) ac.abort();
    }
    expect(events.map((e) => e.type)).not.toContain("done");
    expect(events.map((e) => e.type)).not.toContain("error");
    const messages = await store.getChatMessages("test-project", "feature-design", session.id);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("部分");
  });
});
