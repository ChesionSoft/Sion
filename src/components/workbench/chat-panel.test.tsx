import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel, createStreamingTextBuffer } from "./chat-panel";
import type { MarkdownGenerationState } from "./markdown-generation-types";
import type { ModelProvider, ProjectNode } from "@/lib/project/types";

const activeNode: ProjectNode = {
  id: "feature-design",
  status: "draft",
  markdown: "# 功能模块设计",
  revision: 0,
  updatedAt: "2026-06-14T10:00:00.000Z",
};

const defaultProviders: ModelProvider[] = [
  {
    id: "mp-1",
    name: "OpenAI",
    apiBaseUrl: "https://api.example.com",
    apiKey: "secret",
    protocol: "chat_completions",
    models: [
      { name: "GPT-5.5", isDefault: true },
      { name: "GPT-5.4" },
      { name: "GPT-5.4-Mini" },
    ],
    isDefault: true,
    createdAt: "2026-06-14T10:00:00.000Z",
    updatedAt: "2026-06-14T10:00:00.000Z",
  },
];

function createMockSharedContext() {
  const ctx = {
    activeSessionId: "s-1",
    setActiveSessionId: vi.fn(),
    providerId: "mp-1",
    setProviderId: vi.fn(),
    model: "GPT-5.5",
    setModel: vi.fn(),
    reasoningEffort: "medium" as const,
    setReasoningEffort: vi.fn(),
    providers: defaultProviders,
    setProviders: vi.fn(),
  };
  return ctx;
}

beforeEach(() => {
  vi.useRealTimers();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/api/settings/model-providers")) {
      return new Response(
        JSON.stringify({ providers: defaultProviders }),
      );
    }

    if (url.includes("/files")) {
      return new Response(
        JSON.stringify({
          files: [
            {
              id: "f-1",
              originalName: "需求文档.md",
              storedName: "req.md",
              extension: ".md",
              mimeType: "text/markdown",
              byteSize: 1024,
              uploadedAt: "2026-06-14T10:00:00.000Z",
              status: "available",
              characterCount: 500,
            },
            {
              id: "f-2",
              originalName: "数据.csv",
              storedName: "data.csv",
              extension: ".csv",
              mimeType: "text/csv",
              byteSize: 2048,
              uploadedAt: "2026-06-14T10:00:00.000Z",
              status: "available",
              characterCount: 1200,
            },
          ],
        }),
      );
    }

    if (url.includes("/chat") && init?.method === "POST") {
      const encoder = new TextEncoder();
      const assistantMessage = {
        id: "server-assistant",
        role: "assistant",
        content: "这是最终回复。",
        reasoningContent: "先理解节点上下文。",
        createdAt: "2026-06-14T15:31:00.000Z",
        turnId: "t-1",
        reasoningDurationMs: 800,
        usage: {
          turnId: "t-1",
          inputTokens: 18,
          outputTokens: 7,
          totalTokens: 25,
          source: "exact",
          callCount: 2,
          calls: [
            { id: "c-1", category: "answer", providerId: "mp-1", model: "GPT-5.5", source: "exact", status: "completed", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            { id: "c-2", category: "fact_judge", providerId: "mp-1", model: "GPT-5.5", source: "exact", status: "completed", inputTokens: 8, outputTokens: 2, totalTokens: 10 },
          ],
        },
      };
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "activity", stage: "thinking", summary: "正在分析需求", at: "x" })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "activity", stage: "generating_answer", summary: "正在生成回复", at: "x" })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode('data: {"type":"reasoning","content":"先理解节点上下文。"}\n\n'));
            controller.enqueue(encoder.encode('data: {"type":"token","content":"这是最终回复。"}\n\n'));
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "activity",
                  stage: "updating_document",
                  summary: "正在检查交付稿更新",
                  at: "x",
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "markdown_check_start",
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "markdown_start",
                  mode: "increment",
                  baseRevision: 0,
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "markdown_patch_preview",
                  patch: {
                    category: "confirmed_fact",
                    targetSectionKey: "confirmed",
                    patchKind: "append_bullet",
                    markdown: "第一批信息",
                    evidence: { source: "assistant", quote: "from chat" },
                  },
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "markdown_patch_preview",
                  patch: {
                    category: "confirmed_fact",
                    targetSectionKey: "confirmed",
                    patchKind: "append_bullet",
                    markdown: "第二批信息",
                    evidence: { source: "assistant", quote: "from chat" },
                  },
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "activity", stage: "completed", summary: "已完成", at: "x" })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "done",
                  sessionId: "s-1",
                  assistantMessage,
                })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }

    if (url.includes("/chat/sessions/s-1") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { webSearchEnabled?: boolean };
      return new Response(
        JSON.stringify({
          session: {
            id: "s-1",
            nodeId: "feature-design",
            name: "6月14日 23:30",
            messageCount: 2,
            webSearchEnabled: body.webSearchEnabled === true,
            createdAt: "2026-06-14T15:30:00.000Z",
            updatedAt: "2026-06-14T15:31:00.000Z",
          },
        }),
      );
    }

    if (url.includes("/chat/sessions/s-1")) {
      return new Response(JSON.stringify({ messages: [] }));
    }

    if (url.includes("/chat/sessions")) {
      return new Response(
        JSON.stringify({
          sessions: [
            {
              id: "s-1",
              nodeId: "feature-design",
              name: "6月14日 23:30",
              messageCount: 2,
              webSearchEnabled: false,
              createdAt: "2026-06-14T15:30:00.000Z",
              updatedAt: "2026-06-14T15:31:00.000Z",
            },
          ],
        }),
      );
    }

    return new Response(JSON.stringify({}));
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createStreamingTextBuffer", () => {
  it("decouples incoming chunks from visible output and drains smoothly", async () => {
    vi.useFakeTimers();
    const updates: Array<{ content: string; reasoningContent: string }> = [];
    const buffer = createStreamingTextBuffer((state) => updates.push(state), {
      intervalMs: 20,
      minChunkSize: 2,
      maxChunkSize: 4,
    });

    buffer.push("content", "一二三四五六七八九十");

    expect(updates).toEqual([]);

    await vi.advanceTimersByTimeAsync(20);
    expect(updates[0].content.length).toBeLessThan("一二三四五六七八九十".length);

    const idle = buffer.waitUntilIdle();
    await vi.advanceTimersByTimeAsync(200);
    await idle;

    expect(updates.at(-1)).toEqual({
      content: "一二三四五六七八九十",
      reasoningContent: "",
    });
  });
});

describe("ChatPanel", () => {
  it("renders a session selector and new session button", async () => {
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    const sessionTrigger = await screen.findByRole("button", { name: /6月14日/ });
    expect(sessionTrigger).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "新会话" })).toBeInTheDocument();
    expect(sessionTrigger.textContent?.replace(/\s+/g, " ").trim()).toMatch(
      /6月14日 23:30\s*·?\s*2 条/
    );
  });

  it("renders the compact model menu with reasoning effort and nested models", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    const trigger = await screen.findByRole("button", { name: /模型 GPT-5.5/ });
    expect(trigger).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByText("推理强度")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "低" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "高" })).toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "GPT-5.5" }));
    expect(screen.getByText("选择模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GPT-5.4" })).toBeInTheDocument();
  });

  it("renders send button and file attachment button in toolbar", async () => {
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    expect(await screen.findByRole("button", { name: /发送/ })).toBeInTheDocument();
    expect(screen.getByTitle("添加文件附件")).toBeInTheDocument();
  });

  it("anchors file and model popovers to their toolbar controls", async () => {
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    const fileButton = screen.getByTitle("添加文件附件");
    const modelButton = await screen.findByRole("button", { name: /模型 GPT-5.5/ });

    expect(fileButton.parentElement).toHaveClass("relative");
    expect(modelButton.parentElement).toHaveClass("relative");
  });

  it("auto-scrolls the chat viewport as streamed content arrives", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const { container } = render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await screen.findByRole("button", { name: /发送/ });
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 320 });
    viewport!.scrollTop = 0;

    await user.type(screen.getByPlaceholderText(/补充需求、追问边界/), "请继续");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await screen.findByText("这是最终回复。");

    await waitFor(() => {
      expect(viewport!.scrollTop).toBe(320);
    });
  });

  it("renders streamed reasoning separately from final assistant output", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充需求、追问边界/), "请分析");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    // After the turn, reasoning lives in a closed disclosure (historical
    // "已思考 N 秒") and the final answer renders separately as Markdown.
    expect(await screen.findByText(/已思考/)).toBeInTheDocument();
    expect(await screen.findByText("先理解节点上下文。")).toBeInTheDocument();
    expect(await screen.findByText("这是最终回复。")).toBeInTheDocument();
  });

  it("publishes the complete patch batch only after the SSE done event", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "add patches");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    // Wait for the stream to process
    await screen.findByText("这是最终回复。");

    // Check that onGenStateChange was called with checking
    await waitFor(() => {
      expect(onGenStateChange).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "checking" }),
      );
    });

    // The animation receives one complete batch. Publishing an empty batch at
    // markdown_start races with patch events that arrive in later network chunks.
    await waitFor(() => {
      expect(onGenStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "previewing_increment",
          baseRevision: 0,
          patches: [
            expect.objectContaining({ markdown: "第一批信息" }),
            expect.objectContaining({ markdown: "第二批信息" }),
          ],
        }),
      );
    });
  });

  it("does NOT call onGenStateChange with idle or error after done event", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "test done");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await screen.findByText("这是最终回复。");

    // After done, genState should still be previewing_increment (not idle, not cleared)
    const checkingCallIndex = onGenStateChange.mock.calls.findIndex(
      (call: unknown[]) => {
        const state = call[0] as MarkdownGenerationState;
        return state.phase === "checking";
      },
    );

    if (checkingCallIndex >= 0) {
      const idleCallsAfterChecking = onGenStateChange.mock.calls
        .slice(checkingCallIndex)
        .filter(
          (call: unknown[]) => {
            const state = call[0] as MarkdownGenerationState;
            return state.phase === "idle";
          },
        );
      // There should be no idle calls (no markdown_unchanged event in mock)
      expect(idleCallsAfterChecking).toHaveLength(0);
    }
  });

  it("reflects and toggles the persisted session web search preference", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    const webButton = await screen.findByRole("button", { name: "联网搜索：关闭" });
    expect(webButton).toHaveAttribute("aria-pressed", "false");

    await user.click(webButton);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/chat/sessions/s-1"),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ nodeId: "feature-design", webSearchEnabled: true }),
        }),
      );
    });

    expect(await screen.findByRole("button", { name: "联网搜索：开启" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("rolls back the toggle when the PATCH fails", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/chat/sessions/s-1") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "会话不存在" }), { status: 404 });
      }
      return (original as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>)(input, init);
    }) as typeof fetch;

    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    const webButton = await screen.findByRole("button", { name: "联网搜索：关闭" });
    await user.click(webButton);

    expect(await screen.findByRole("button", { name: "联网搜索：关闭" })).toBeInTheDocument();
  });

  it("rolls back the toggle when the PATCH request rejects", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/chat/sessions/s-1") && init?.method === "PATCH") {
        throw new Error("network down");
      }
      return (original as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>)(input, init);
    }) as typeof fetch;

    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "联网搜索：关闭" }));

    expect(await screen.findByRole("button", { name: "联网搜索：关闭" })).toBeInTheDocument();
    expect(screen.getByText("切换联网搜索失败")).toBeInTheDocument();
  });

  it("renders URL read status, notice, and deduped source links", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/settings/model-providers")) {
        return new Response(JSON.stringify({ providers: defaultProviders }));
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({ files: [] }));
      }
      if (url.includes("/chat/sessions/s-1") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { webSearchEnabled?: boolean };
        return new Response(
          JSON.stringify({
            session: {
              id: "s-1",
              nodeId: "feature-design",
              name: "6月14日 23:30",
              messageCount: 2,
              webSearchEnabled: body.webSearchEnabled === true,
              createdAt: "2026-06-14T15:30:00.000Z",
              updatedAt: "2026-06-14T15:31:00.000Z",
            },
          }),
        );
      }
      if (url.includes("/chat/sessions/s-1")) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes("/chat/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "s-1",
                nodeId: "feature-design",
                name: "6月14日 23:30",
                messageCount: 2,
                webSearchEnabled: true,
                createdAt: "2026-06-14T15:30:00.000Z",
                updatedAt: "2026-06-14T15:31:00.000Z",
              },
            ],
          }),
        );
      }
      if (url.includes("/chat") && init?.method === "POST") {
        const encoder = new TextEncoder();
        const source = {
          id: "src-1",
          kind: "provided_url",
          url: "https://example.com/",
          title: "Example",
          domain: "example.com",
          snippet: "片段",
          retrievedAt: "2026-06-21T00:00:00.000Z",
        };
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "url_read_start", urls: ["https://example.com/"] })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "url_read_result", url: "https://example.com/", ok: true, source })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "notice", message: "搜索暂不可用，已继续普通对话" })}\n\n`),
              );
              // Duplicate source event from the adapter — must dedupe to one link
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "source", source })}\n\n`),
              );
              controller.enqueue(
                encoder.encode('data: {"type":"token","content":"已总结。"}\n\n'),
              );
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "done", sessionId: "s-1" })}\n\n`),
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "看 https://example.com/ 并总结");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    expect(await screen.findByText("搜索暂不可用，已继续普通对话")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Example/ })).toHaveLength(1);
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("surfaces web_fetch progress and failure notices from the orchestrator", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/settings/model-providers")) {
        return new Response(JSON.stringify({ providers: defaultProviders }));
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({ files: [] }));
      }
      if (url.includes("/chat/sessions/s-1")) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes("/chat/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "s-1",
                nodeId: "feature-design",
                name: "6月14日 23:30",
                messageCount: 2,
                webSearchEnabled: false,
                createdAt: "2026-06-14T15:30:00.000Z",
                updatedAt: "2026-06-14T15:31:00.000Z",
              },
            ],
          }),
        );
      }
      if (url.includes("/chat") && init?.method === "POST") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "web_fetch_start", url: "https://site.test/a" })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "web_fetch_result",
                    url: "https://site.test/a",
                    ok: false,
                    code: "browser_unavailable",
                    message: "抓取失败",
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode('data: {"type":"token","content":"已继续对话。"}\n\n'),
              );
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "done", sessionId: "s-1" })}\n\n`),
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "看 https://site.test/a 并总结");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    expect(await screen.findByText(/链接读取失败.*抓取失败/)).toBeInTheDocument();
  });

  it("allows interrupting generation even when the input is empty", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/settings/model-providers")) {
        return new Response(JSON.stringify({ providers: defaultProviders }));
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({ files: [] }));
      }
      if (url.includes("/chat/sessions/s-1")) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes("/chat/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "s-1",
                nodeId: "feature-design",
                name: "6月14日 23:30",
                messageCount: 2,
                webSearchEnabled: false,
                createdAt: "2026-06-14T15:30:00.000Z",
                updatedAt: "2026-06-14T15:31:00.000Z",
              },
            ],
          }),
        );
      }
      if (url.includes("/chat") && init?.method === "POST") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
              controller.enqueue(encoder.encode('data: {"type":"token","content":"生成中"}\n\n'));
              // Intentionally do NOT close — keep sending=true so the interrupt
              // button can be asserted mid-generation.
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    const input = screen.getByPlaceholderText(/补充/) as HTMLTextAreaElement;
    await screen.findByRole("button", { name: /发送/ });
    await user.type(input, "请总结");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    // During generation the button becomes 中断 and must stay clickable.
    const interruptButton = await screen.findByRole("button", { name: /中断/ });
    expect(interruptButton).toBeEnabled();

    // Clearing the input mid-generation must NOT disable the interrupt button.
    await user.clear(input);
    expect(screen.getByRole("button", { name: /中断/ })).toBeEnabled();

    (streamController as ReadableStreamDefaultController<Uint8Array> | null)?.close();
  });

  it("shows a delivery-draft status notice while the agent updates the draft", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/settings/model-providers")) {
        return new Response(JSON.stringify({ providers: defaultProviders }));
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({ files: [] }));
      }
      if (url.includes("/chat/sessions/s-1")) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes("/chat/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "s-1",
                nodeId: "feature-design",
                name: "6月14日 23:30",
                messageCount: 2,
                webSearchEnabled: false,
                createdAt: "2026-06-14T15:30:00.000Z",
                updatedAt: "2026-06-14T15:31:00.000Z",
              },
            ],
          }),
        );
      }
      if (url.includes("/chat") && init?.method === "POST") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
              controller.enqueue(encoder.encode('data: {"type":"token","content":"回答中"}\n\n'));
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "activity", stage: "updating_document", summary: "正在检查交付稿更新", at: "x" })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode('data: {"type":"markdown_check_start"}\n\n'),
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "补充一点");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    // The updating_document activity stage is shown by the activity indicator
    // (replacing the old draft-notice strip).
    await waitFor(() => {
      expect(document.querySelector('.agent-activity[data-stage="updating_document"]')).not.toBeNull();
    });

    (streamController as ReadableStreamDefaultController<Uint8Array> | null)?.close();
  });

  it("opens scoped browser verification with only sessionId and retries as a new turn", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const postBodies: unknown[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/settings/model-providers")) {
        return new Response(JSON.stringify({ providers: defaultProviders }));
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({ files: [] }));
      }
      if (url.includes("/chat/sessions/s-1")) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes("/chat/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "s-1",
                nodeId: "feature-design",
                name: "6月14日 23:30",
                messageCount: 2,
                webSearchEnabled: true,
                createdAt: "2026-06-14T15:30:00.000Z",
                updatedAt: "2026-06-14T15:31:00.000Z",
              },
            ],
          }),
        );
      }
      if (url.includes("/chat/verifications/v-1") && init?.method === "POST") {
        postBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true }));
      }
      if (url.endsWith("/chat") && init?.method === "POST") {
        postBodies.push(JSON.parse(String(init.body)));
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  "data: " +
                    JSON.stringify({ type: "browser_verification_required", verificationId: "v-1", engine: "google" }) +
                    "\n\n",
                ),
              );
              controller.enqueue(encoder.encode('data: {"type":"token","content":"需要验证。"}\n\n'));
              controller.enqueue(encoder.encode("data: " + JSON.stringify({ type: "done", sessionId: "s-1" }) + "\n\n"));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    render(
      <ChatPanel
        activeNode={activeNode}
        projectId="p-1"
        sharedContext={ctx}
        onGenStateChange={onGenStateChange}
      />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "请搜索需要验证的内容");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await user.click(await screen.findByRole("button", { name: "打开浏览器验证" }));

    expect(postBodies).toContainEqual({ sessionId: "s-1" });
    expect(JSON.stringify(postBodies)).not.toContain("challenge");
    expect(JSON.stringify(postBodies)).not.toContain("url");

    await screen.findByText("需要验证。");
    await screen.findByRole("button", { name: /发送/ });
    await user.click(screen.getByRole("button", { name: "验证后重试" }));

    const chatPosts = postBodies.filter(
      (body): body is { message: string } =>
        typeof body === "object" && body !== null && "message" in body,
    );
    expect(chatPosts).toHaveLength(2);
    expect(chatPosts[1].message).toBe("请搜索需要验证的内容");
  });

  // Build a fetch mock whose POST stream is held open by a controller so the
  // test can emit events progressively and assert mid-stream state.
  function createHeldStreamMock(events: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/settings/model-providers")) {
        return new Response(JSON.stringify({ providers: defaultProviders }));
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({ files: [] }));
      }
      if (url.includes("/chat/sessions/s-1") && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            session: { id: "s-1", nodeId: "feature-design", name: "n", messageCount: 2, webSearchEnabled: false, createdAt: "x", updatedAt: "x" },
          }),
        );
      }
      if (url.includes("/chat/sessions/s-1")) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes("/chat/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [{ id: "s-1", nodeId: "feature-design", name: "6月14日 23:30", messageCount: 2, webSearchEnabled: false, createdAt: "x", updatedAt: "x" }],
          }),
        );
      }
      if (url.includes("/chat") && init?.method === "POST") {
        return new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
              events(controller);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;
    return {
      fetchMock,
      getController: () => streamController,
    };
  }

  it("shows the live activity stage in the closed reasoning header while tokens stream", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const { fetchMock, getController } = createHeldStreamMock((controller) => {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "activity", stage: "generating_answer", summary: "正在生成回复", at: "x" })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode('data: {"type":"reasoning","content":"思考中"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"token","content":"回答"}\n\n'));
      // Intentionally do NOT close — keep the stream mid-generation.
    });
    globalThis.fetch = fetchMock;

    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "请继续");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(document.querySelector('.agent-activity[data-stage="generating_answer"]')).not.toBeNull();
    });
    // The reasoning disclosure stays closed while streaming.
    const details = document.querySelector(".chat-reasoning") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);

    (getController() as ReadableStreamDefaultController<Uint8Array> | null)?.close();
  });

  it("changes the visible stage as search and document-update events arrive", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const { fetchMock, getController } = createHeldStreamMock((controller) => {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "activity", stage: "searching_web", summary: "正在检索外部资料", at: "x" })}\n\n`,
        ),
      );
    });
    globalThis.fetch = fetchMock;

    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "搜一下");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(document.querySelector('.agent-activity[data-stage="searching_web"]')).not.toBeNull();
    });

    // Emit a later document-update stage.
    const controller = getController() as ReadableStreamDefaultController<Uint8Array> | null;
    const encoder = new TextEncoder();
    controller?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: "activity", stage: "updating_document", summary: "正在检查交付稿更新", at: "x" })}\n\n`,
      ),
    );
    await waitFor(() => {
      expect(document.querySelector('.agent-activity[data-stage="updating_document"]')).not.toBeNull();
    });

    controller?.close();
  });

  it("replaces the optimistic assistant message with the server message on done", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "hi");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    // After done, the authoritative server message carries per-turn usage.
    await waitFor(() => {
      const assistant = document.querySelector('[data-role="assistant"]') as HTMLElement | null;
      expect(assistant).not.toBeNull();
      expect(within(assistant!).getByText(/共 25 token/)).toBeInTheDocument();
    });
  });

  it("lets the user expand single-turn usage to see the source label", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "hi");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    const assistant = await waitFor(() => {
      const el = document.querySelector('[data-role="assistant"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    const trigger = within(assistant).getByText(/共 25 token/);
    await user.click(trigger);
    expect(await within(assistant).findByText("精确")).toBeInTheDocument();
  });

  it("shows session usage totaling all loaded assistant messages", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "hi");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      const sessionUsage = screen.getByTestId("session-usage");
      expect(within(sessionUsage).getByText(/共 25 token/)).toBeInTheDocument();
    });
  });

  it("pressing stop marks the turn interrupted and clears the active animation", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const { fetchMock, getController } = createHeldStreamMock((controller) => {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "activity", stage: "generating_answer", summary: "正在生成回复", at: "x" })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode('data: {"type":"token","content":"部分"}\n\n'));
    });
    globalThis.fetch = fetchMock;

    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "请继续");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(document.querySelector('.agent-activity[data-stage="generating_answer"]')).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /中断/ }));

    await waitFor(() => {
      expect(document.querySelector('.agent-activity[data-stage="interrupted"]')).not.toBeNull();
    });

    (getController() as ReadableStreamDefaultController<Uint8Array> | null)?.close();
  });

  it("falls back to 处理中 for an unknown activity stage without crashing", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const { fetchMock, getController } = createHeldStreamMock((controller) => {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "activity", stage: "weird_stage", summary: "未知阶段", at: "x" })}\n\n`,
        ),
      );
    });
    globalThis.fetch = fetchMock;

    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "hi");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    expect(await screen.findByText("处理中")).toBeInTheDocument();

    (getController() as ReadableStreamDefaultController<Uint8Array> | null)?.close();
  });

  it("keeps failed activity when the server returns an SSE error and closes normally", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/settings/model-providers")) {
        return new Response(JSON.stringify({ providers: defaultProviders }));
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({ files: [] }));
      }
      if (url.includes("/chat/sessions/s-1")) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes("/chat/sessions")) {
        return new Response(JSON.stringify({
          sessions: [{
            id: "s-1",
            nodeId: "feature-design",
            name: "6月14日 23:30",
            messageCount: 0,
            webSearchEnabled: false,
            createdAt: "2026-06-14T15:30:00.000Z",
            updatedAt: "2026-06-14T15:30:00.000Z",
          }],
        }));
      }
      if (url.includes("/chat") && init?.method === "POST") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "activity", stage: "failed", summary: "生成失败", at: "x" })}\n\n`),
              );
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "error", error: "模型请求失败" })}\n\n`),
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "hi");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    expect(await screen.findByText("模型请求失败")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('.agent-activity[data-stage="failed"]')).not.toBeNull();
    });
    expect(document.querySelector('.agent-activity[data-stage="completed"]')).toBeNull();
  });

  it("clears activity when the stream closes without done or error", async () => {
    const user = userEvent.setup();
    const ctx = createMockSharedContext();
    const onGenStateChange = vi.fn();
    const { fetchMock } = createHeldStreamMock((controller) => {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "activity", stage: "generating_answer", summary: "正在生成回复", at: "x" })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode('data: {"type":"token","content":"部分"}\n\n'));
      controller.close();
    });
    globalThis.fetch = fetchMock;

    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={ctx} onGenStateChange={onGenStateChange} />,
    );

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/补充/), "hi");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(document.querySelector(".agent-activity")).toBeNull();
    });
    expect(document.querySelector('.agent-activity[data-stage="completed"]')).toBeNull();
    expect(document.querySelector('[data-role="assistant"]')).toHaveTextContent("部分");
  });

  it("only offers readable project files in the attachment picker", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/model-providers")) {
        return new Response(JSON.stringify({ providers: defaultProviders }));
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({
          files: [
            {
              id: "ok",
              originalName: "需求.pdf",
              storedName: "ok.pdf",
              extension: ".pdf",
              mimeType: "application/pdf",
              byteSize: 1000,
              uploadedAt: "2026-06-23T10:00:00.000Z",
              status: "available",
              kind: "pdf",
              extractionStatus: "available",
              textPath: "ok.txt",
              characterCount: 500,
            },
            {
              id: "bad",
              originalName: "扫描件.pdf",
              storedName: "bad.pdf",
              extension: ".pdf",
              mimeType: "application/pdf",
              byteSize: 1000,
              uploadedAt: "2026-06-23T10:00:00.000Z",
              status: "read_failed",
              kind: "pdf",
              extractionStatus: "failed",
              extractionError: "PDF 未包含可提取文本",
            },
          ],
        }));
      }
      if (url.includes("/chat/sessions/s-1")) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes("/chat/sessions")) {
        return new Response(JSON.stringify({
          sessions: [{ id: "s-1", nodeId: "feature-design", name: "6月23日 10:00", messageCount: 0, webSearchEnabled: false, createdAt: "2026-06-23T10:00:00.000Z", updatedAt: "2026-06-23T10:00:00.000Z" }],
        }));
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }) as unknown as typeof fetch);

    const sharedContext = createMockSharedContext();
    render(
      <ChatPanel activeNode={activeNode} projectId="p-1" sharedContext={sharedContext} onGenStateChange={() => {}} />,
    );
    await user.click(await screen.findByTitle("添加文件附件"));

    expect(screen.getByText("需求.pdf")).toBeInTheDocument();
    expect(screen.queryByText("扫描件.pdf")).not.toBeInTheDocument();
  });
});
