import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import { runWebOrchestrator, type WebOrchestratorEvent, type StreamTurnArgs } from "./web-tool-orchestrator";
import type { BrowserWebSearchResult, BrowserWebService, WebFetchResult } from "./browser-web-service";
import type { ModelTurnEvent } from "./model-tools";
import type { ModelCallUsage, SearchEngineId, SearchResult } from "./types";

function makeBrowserService(opts: {
  search?: (query: string) => BrowserWebSearchResult;
  fetch?: (url: string) => WebFetchResult;
} = {}): BrowserWebService {
  return {
    search: vi.fn(async (input: { query: string }) =>
      opts.search ? opts.search(input.query) : { ok: true, results: [] },
    ),
    fetch: vi.fn(async (input: { url: string }) =>
      opts.fetch ? opts.fetch(input.url) : { ok: true, url: input.url, content: "page content" },
    ),
  } as unknown as BrowserWebService;
}

/** Returns a streamTurn that emits the given scripts in order, one per call. */
function scriptedStreamTurn(scripts: ((args: StreamTurnArgs) => ModelTurnEvent[])[]) {
  let i = 0;
  return vi.fn(async function* (args: StreamTurnArgs): AsyncGenerator<ModelTurnEvent> {
    const script = scripts[i++] ?? [];
    for (const e of script(args)) yield e;
  });
}

function toolCall(id: string, name: string, args: string): ModelTurnEvent {
  return { type: "tool_call", call: { id, name, argumentsJson: args } };
}

async function collect(gen: AsyncGenerator<WebOrchestratorEvent>): Promise<WebOrchestratorEvent[]> {
  const out: WebOrchestratorEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Returns a fetch Response that streams SSE chunks (for the default turn path). */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
  } as unknown as Response;
}

const baseInput = {
  apiBaseUrl: "https://api.example.com",
  apiKey: "k",
  model: "m",
  protocol: "chat_completions" as const,
  systemPrompt: "sys",
  userMessage: "查找 X",
  directUrls: [] as string[],
  searchEnabled: true,
  engine: "google" as SearchEngineId,
  projectId: "p",
  sessionId: "s",
};

describe("runWebOrchestrator/tool-capable path", () => {
  it("runs search then fetch then a final answer", async () => {
    const browserService = makeBrowserService({
      search: () => ({
        ok: true,
        results: [{ title: "R1", url: "https://example.com/page", rank: 1 }],
      }),
      fetch: () => ({ ok: true, url: "https://example.com/page", content: "page body" }),
    });
    const streamTurn = scriptedStreamTurn([
      () => [toolCall("c1", "web_search", JSON.stringify({ query: "X" }))],
      () => [toolCall("c2", "web_fetch", JSON.stringify({ url: "https://example.com/page" }))],
      () => [{ type: "content", delta: "最终答案" }],
    ]);

    const events = await collect(
      runWebOrchestrator({ ...baseInput, toolCalling: true, browserService, streamTurn }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("web_search_start");
    expect(types).toContain("web_search_result");
    expect(types).toContain("web_fetch_start");
    expect(types).toContain("web_fetch_result");
    expect(types).toContain("source");
    expect(types).toContain("content");
    const content = events.filter((e) => e.type === "content").map((e) => (e as { delta: string }).delta).join("");
    expect(content).toBe("最终答案");
  });

  it("emits content before a tool call in the same round", async () => {
    const browserService = makeBrowserService();
    const streamTurn = scriptedStreamTurn([
      () => [{ type: "content", delta: "先想想" }, toolCall("c1", "web_search", '{"query":"X"}')],
      () => [{ type: "content", delta: "答案" }],
    ]);
    const events = await collect(
      runWebOrchestrator({ ...baseInput, toolCalling: true, browserService, streamTurn }),
    );
    const order = events.map((e) => e.type);
    const contentIdx = order.indexOf("content");
    const searchIdx = order.indexOf("web_search_start");
    expect(contentIdx).toBeLessThan(searchIdx);
  });

  it("returns an error tool result and a notice for an unknown tool", async () => {
    const browserService = makeBrowserService();
    const streamTurn = scriptedStreamTurn([
      () => [toolCall("c1", "delete_db", "{}")],
      () => [{ type: "content", delta: "答案" }],
    ]);
    const events = await collect(
      runWebOrchestrator({ ...baseInput, toolCalling: true, browserService, streamTurn }),
    );
    expect(events.some((e) => e.type === "notice")).toBe(true);
    expect(events.some((e) => e.type === "content")).toBe(true);
  });

  it("does not refetch a duplicate URL", async () => {
    const fetchMock = vi.fn(async (input: { url: string }) => ({
      ok: true,
      url: input.url,
      content: "body",
    }));
    const browserService = {
      search: vi.fn(async () => ({ ok: true, results: [] as SearchResult[] })),
      fetch: fetchMock,
    } as unknown as BrowserWebService;
    const streamTurn = scriptedStreamTurn([
      () => [toolCall("c1", "web_fetch", JSON.stringify({ url: "https://example.com/x" }))],
      () => [toolCall("c2", "web_fetch", JSON.stringify({ url: "https://example.com/x" }))],
      () => [{ type: "content", delta: "答案" }],
    ]);
    await collect(
      runWebOrchestrator({ ...baseInput, toolCalling: true, browserService, streamTurn }),
    );
    // Second duplicate fetch is rejected by the budget before reaching the service.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a verification_required search result as an event", async () => {
    const browserService = makeBrowserService({
      search: () => ({ ok: false, code: "verification_required", message: "需要验证", verificationId: "v-1" }),
    });
    const streamTurn = scriptedStreamTurn([
      () => [toolCall("c1", "web_search", '{"query":"X"}')],
      () => [{ type: "content", delta: "答案" }],
    ]);
    const events = await collect(
      runWebOrchestrator({ ...baseInput, toolCalling: true, browserService, streamTurn }),
    );
    const verif = events.find((e) => e.type === "browser_verification_required");
    expect(verif).toBeDefined();
  });

  it("denies a third tool round and finishes with a no-tools call", async () => {
    const browserService = makeBrowserService();
    let calls = 0;
    const streamTurn = vi.fn(async function* (args: StreamTurnArgs): AsyncGenerator<ModelTurnEvent> {
      calls += 1;
      if (args.tools && calls <= 3) {
        yield toolCall(`c${calls}`, "web_search", '{"query":"X"}');
      } else {
        yield { type: "content", delta: "答案" };
      }
    });
    await collect(
      runWebOrchestrator({ ...baseInput, toolCalling: true, browserService, streamTurn }),
    );
    // 2 tool rounds + 1 final no-tools call = 3 streamTurn calls.
    expect(calls).toBe(3);
  });

  it("continues with a normal answer when all web operations fail", async () => {
    const browserService = makeBrowserService({
      search: () => ({ ok: false, code: "browser_unavailable", message: "down" }),
    });
    const streamTurn = scriptedStreamTurn([
      () => [toolCall("c1", "web_search", '{"query":"X"}')],
      () => [{ type: "content", delta: "尽力回答" }],
    ]);
    const events = await collect(
      runWebOrchestrator({ ...baseInput, toolCalling: true, browserService, streamTurn }),
    );
    expect(events.some((e) => e.type === "content")).toBe(true);
    expect(events.filter((e) => e.type === "source")).toHaveLength(0);
  });
});

describe("runWebOrchestrator/fallback path", () => {
  it("uses the planner, fetches the top three pages, then answers", async () => {
    const browserService = makeBrowserService({
      search: () => ({
        ok: true,
        results: [
          { title: "a", url: "https://a.com/1", rank: 1 },
          { title: "b", url: "https://b.com/2", rank: 2 },
        ],
      }),
      fetch: (url) => ({ ok: true, url, content: `body-${url}` }),
    });
    const callText = vi.fn(async () => '{"queries":["q1","q2"]}');
    const streamTurn = scriptedStreamTurn([() => [{ type: "content", delta: "答案" }]]);

    const events = await collect(
      runWebOrchestrator({
        ...baseInput,
        toolCalling: false,
        browserService,
        callText,
        streamTurn,
      }),
    );
    // two searches (one per query)
    expect(browserService.search).toHaveBeenCalledTimes(2);
    const fetchEvents = events.filter((e) => e.type === "web_fetch_start");
    expect(fetchEvents.length).toBeLessThanOrEqual(3);
    expect(events.some((e) => e.type === "content")).toBe(true);
  });

  it("skips the planner when search is off", async () => {
    const browserService = makeBrowserService();
    const callText = vi.fn(async () => '{"queries":["q"]}');
    const streamTurn = scriptedStreamTurn([() => [{ type: "content", delta: "答案" }]]);
    await collect(
      runWebOrchestrator({
        ...baseInput,
        searchEnabled: false,
        toolCalling: false,
        browserService,
        callText,
        streamTurn,
      }),
    );
    expect(callText).not.toHaveBeenCalled();
    expect(browserService.search).not.toHaveBeenCalled();
  });

  it("answers normally when all searches fail", async () => {
    const browserService = makeBrowserService({
      search: () => ({ ok: false, code: "browser_unavailable", message: "down" }),
    });
    const callText = vi.fn(async () => '{"queries":["q"]}');
    const streamTurn = scriptedStreamTurn([() => [{ type: "content", delta: "答案" }]]);
    const events = await collect(
      runWebOrchestrator({ ...baseInput, toolCalling: false, browserService, callText, streamTurn }),
    );
    expect(events.some((e) => e.type === "content")).toBe(true);
    expect(events.filter((e) => e.type === "source")).toHaveLength(0);
  });
});

describe("runWebOrchestrator/direct URLs", () => {
  it("fetches direct URLs with search off and does not consume search budget", async () => {
    const browserService = makeBrowserService({
      fetch: (url) => ({ ok: true, url, content: "direct body" }),
    });
    const streamTurn = scriptedStreamTurn([() => [{ type: "content", delta: "答案" }]]);

    const events = await collect(
      runWebOrchestrator({
        ...baseInput,
        searchEnabled: false,
        toolCalling: false,
        directUrls: ["https://example.com/a", "https://example.com/b"],
        browserService,
        streamTurn,
      }),
    );
    expect(browserService.fetch).toHaveBeenCalledTimes(2);
    expect(browserService.search).not.toHaveBeenCalled();
    const sources = events.filter((e) => e.type === "source");
    expect(sources).toHaveLength(2);
  });

  it("only emits sources for successfully fetched direct URLs", async () => {
    const browserService = makeBrowserService({
      fetch: (url) =>
        url === "https://example.com/bad"
          ? { ok: false, code: "blocked_address", message: "blocked" }
          : { ok: true, url, content: "ok" },
    });
    const streamTurn = scriptedStreamTurn([() => [{ type: "content", delta: "答案" }]]);
    const events = await collect(
      runWebOrchestrator({
        ...baseInput,
        searchEnabled: false,
        toolCalling: false,
        directUrls: ["https://example.com/good", "https://example.com/bad"],
        browserService,
        streamTurn,
      }),
    );
    const sources = events.filter((e) => e.type === "source");
    expect(sources).toHaveLength(1);
  });

  it("dedupes direct URLs and shares the three-page fetch budget", async () => {
    const fetchMock = vi.fn(async (input: { url: string }) => ({
      ok: true,
      url: input.url,
      content: "x",
    }));
    const browserService = { search: vi.fn(), fetch: fetchMock } as unknown as BrowserWebService;
    const streamTurn = scriptedStreamTurn([() => [{ type: "content", delta: "答案" }]]);
    await collect(
      runWebOrchestrator({
        ...baseInput,
        searchEnabled: false,
        toolCalling: false,
        directUrls: [
          "https://example.com/a",
          "https://example.com/a", // duplicate
          "https://example.com/b",
          "https://example.com/c",
          "https://example.com/d", // beyond 3-page budget
        ],
        browserService,
        streamTurn,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3); // a, b, c; d skipped by budget
  });

  it("labels fetched direct-URL content as the page content of that link", async () => {
    // Regression: models that pattern-match on the raw link in the user
    // message reply "I can't access links" and ignore the fetched text below.
    // The user message sent to the model must explicitly tie the fetched
    // content to the link so the model answers from it instead of refusing.
    const browserService = makeBrowserService({
      fetch: (url) => ({ ok: true, url, content: "合同演示文档正文" }),
    });
    const captured: { conversation?: StreamTurnArgs["conversation"] } = {};
    const streamTurn = vi.fn(async function* (args: StreamTurnArgs): AsyncGenerator<ModelTurnEvent> {
      captured.conversation = args.conversation;
      yield { type: "content", delta: "答案" };
    });

    await collect(
      runWebOrchestrator({
        ...baseInput,
        searchEnabled: false,
        toolCalling: false,
        userMessage: "测试，https://project.hsxlian.com/index.html 你能访问这个网站吗",
        directUrls: ["https://project.hsxlian.com/index.html"],
        browserService,
        streamTurn,
      }),
    );

    const userMessages = (captured.conversation ?? []).filter(
      (m) => m.type === "message" && m.role === "user",
    ) as { content: string }[];
    // The user message to the answer model is the first one; it must carry the
    // fetched content, the link, and an explicit marker connecting the two.
    const answerUserContent = userMessages[0]?.content ?? "";
    expect(answerUserContent).toContain("https://project.hsxlian.com/index.html");
    expect(answerUserContent).toContain("合同演示文档正文");
    expect(answerUserContent).toMatch(/链接|网页内容|抓取/);
  });

  it("injects a model-facing note when a direct-URL fetch fails", async () => {
    // When the link can't be read, the model must be told (in the conversation)
    // so it reports the failure honestly instead of claiming "no web access".
    const browserService = makeBrowserService({
      fetch: () => ({ ok: false, code: "blocked_address", message: "抓取失败" }),
    });
    const captured: { conversation?: StreamTurnArgs["conversation"] } = {};
    const streamTurn = vi.fn(async function* (args: StreamTurnArgs): AsyncGenerator<ModelTurnEvent> {
      captured.conversation = args.conversation;
      yield { type: "content", delta: "答案" };
    });

    await collect(
      runWebOrchestrator({
        ...baseInput,
        searchEnabled: false,
        toolCalling: false,
        userMessage: "https://example.com/down 你能访问吗",
        directUrls: ["https://example.com/down"],
        browserService,
        streamTurn,
      }),
    );

    const userMessages = (captured.conversation ?? []).filter(
      (m) => m.type === "message" && m.role === "user",
    ) as { content: string }[];
    const note = userMessages.find((m) => m.content.includes("https://example.com/down"));
    expect(note).toBeDefined();
    // Must tell the model the link could NOT be read, not just stay silent.
    expect(note!.content).toMatch(/未能|无法|失败|读不到|读不了|不可用/);
  });
});

describe("runWebOrchestrator/history", () => {
  it("inserts prior turns between the system prompt and the new user message", async () => {
    // Regression: without history the model forgets earlier Q&A in the session
    // and re-asks clarifying questions whose answers lived in chat, not markdown.
    const browserService = makeBrowserService();
    const captured: { conversation?: StreamTurnArgs["conversation"] } = {};
    const streamTurn = vi.fn(async function* (args: StreamTurnArgs): AsyncGenerator<ModelTurnEvent> {
      captured.conversation = args.conversation;
      yield { type: "content", delta: "答案" };
    });

    await collect(
      runWebOrchestrator({
        ...baseInput,
        searchEnabled: false,
        toolCalling: false,
        history: [
          { type: "message", role: "user", content: "之前问的" },
          { type: "message", role: "assistant", content: "之前答的" },
        ],
        browserService,
        streamTurn,
      }),
    );

    const msgs = (captured.conversation ?? []).filter((m) => m.type === "message") as {
      type: string;
      role: string;
      content: string;
    }[];
    expect(msgs[0]).toEqual({ type: "message", role: "system", content: "sys" });
    expect(msgs[1]).toEqual({ type: "message", role: "user", content: "之前问的" });
    expect(msgs[2]).toEqual({ type: "message", role: "assistant", content: "之前答的" });
    // The new user message stays last and carries the latest input.
    expect(msgs[msgs.length - 1].role).toBe("user");
    expect(msgs[msgs.length - 1].content).toContain("查找 X");
  });

  it("drops non-message history items so tool calls never leak into a fresh turn", async () => {
    const browserService = makeBrowserService();
    const captured: { conversation?: StreamTurnArgs["conversation"] } = {};
    const streamTurn = vi.fn(async function* (args: StreamTurnArgs): AsyncGenerator<ModelTurnEvent> {
      captured.conversation = args.conversation;
      yield { type: "content", delta: "答案" };
    });

    await collect(
      runWebOrchestrator({
        ...baseInput,
        searchEnabled: false,
        toolCalling: false,
        history: [
          { type: "message", role: "user", content: "之前问的" },
          { type: "tool_call", call: { id: "c", name: "web_search", argumentsJson: "{}" } },
        ],
        browserService,
        streamTurn,
      }),
    );

    const toolItems = (captured.conversation ?? []).filter((m) => m.type !== "message");
    expect(toolItems).toHaveLength(0);
  });
});

describe("runWebOrchestrator/usage tracking", () => {
  it("categorizes the planning call as tool_planning and the final answer as answer", async () => {
    const calls: ModelCallUsage[] = [];
    const onUsage = (u: ModelCallUsage) => calls.push(u);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { stream?: boolean };
      if (body.stream) {
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      // Non-stream planning call (defaultCallText -> callModelChat).
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"queries":["q1"]}' } }] }),
        { status: 200 },
      );
    });
    const browserService = makeBrowserService({
      search: () => ({ ok: true, results: [{ title: "t", url: "https://example.com/p", rank: 1 }] }),
      fetch: (url) => ({ ok: true, url, content: "body" }),
    });

    await collect(
      runWebOrchestrator({
        ...baseInput,
        toolCalling: false,
        browserService,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        turnId: "t1",
        providerId: "p1",
        onUsage,
      }),
    );

    expect(calls.map((c) => c.category)).toEqual(["tool_planning", "answer"]);
  });
});