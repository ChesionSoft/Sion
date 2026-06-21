import { render, screen, waitFor } from "@testing-library/react";
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
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"reasoning","content":"先理解节点上下文。"}\n\n'));
            controller.enqueue(encoder.encode('data: {"type":"token","content":"这是最终回复。"}\n\n'));
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
                `data: ${JSON.stringify({
                  type: "done",
                  sessionId: "s-1",
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

    expect(await screen.findByText("思考过程")).toBeInTheDocument();
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

  it("renders URL read status, web_search_unavailable notice, and deduped source links", async () => {
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
                encoder.encode(`data: ${JSON.stringify({ type: "web_search_unavailable" })}\n\n`),
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

    expect(await screen.findByText("当前模型不支持原生联网，已继续普通对话")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Example/ })).toHaveLength(1);
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });
});
