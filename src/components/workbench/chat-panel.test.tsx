import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel, createStreamingTextBuffer } from "./chat-panel";
import type { ProjectNode } from "@/lib/project/types";

const activeNode: ProjectNode = {
  id: "feature-design",
  status: "draft",
  markdown: "# 功能模块设计",
  assumptions: [],
  openQuestions: [],
  updatedAt: "2026-06-14T10:00:00.000Z",
};

beforeEach(() => {
  vi.useRealTimers();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/api/settings/model-providers")) {
      return new Response(
        JSON.stringify({
          providers: [
            {
              id: "mp-1",
              name: "OpenAI",
              apiBaseUrl: "https://api.example.com",
              apiKey: "secret",
              models: [
                { name: "GPT-5.5", isDefault: true },
                { name: "GPT-5.4" },
                { name: "GPT-5.4-Mini" },
              ],
              isDefault: true,
              createdAt: "2026-06-14T10:00:00.000Z",
              updatedAt: "2026-06-14T10:00:00.000Z",
            },
          ],
        }),
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
            controller.enqueue(encoder.encode('data: {"type":"done","sessionId":"s-1"}\n\n'));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
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
    render(<ChatPanel activeNode={activeNode} projectId="p-1" />);

    const sessionTrigger = await screen.findByRole("button", { name: /6月14日/ });
    expect(sessionTrigger).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "新会话" })).toBeInTheDocument();
    expect(sessionTrigger.textContent?.replace(/\s+/g, " ").trim()).toMatch(
      /6月14日 23:30\s*·?\s*2 条/
    );
  });

  it("renders the compact model menu with reasoning effort and nested models", async () => {
    const user = userEvent.setup();
    render(<ChatPanel activeNode={activeNode} projectId="p-1" />);

    const trigger = await screen.findByRole("button", { name: /模型 GPT-5.5/ });
    expect(trigger).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByText("推理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "低" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "高" })).toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "GPT-5.5" }));
    expect(screen.getByText("模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GPT-5.4" })).toBeInTheDocument();
  });

  it("renders send button and file attachment button in toolbar", async () => {
    render(<ChatPanel activeNode={activeNode} projectId="p-1" />);

    expect(await screen.findByRole("button", { name: /发送/ })).toBeInTheDocument();
    expect(screen.getByTitle("添加文件附件")).toBeInTheDocument();
  });

  it("anchors file and model popovers to their toolbar controls", async () => {
    render(<ChatPanel activeNode={activeNode} projectId="p-1" />);

    const fileButton = screen.getByTitle("添加文件附件");
    const modelButton = await screen.findByRole("button", { name: /模型 GPT-5.5/ });

    expect(fileButton.parentElement).toHaveClass("relative");
    expect(modelButton.parentElement).toHaveClass("relative");
  });

  it("auto-scrolls the chat viewport as streamed content arrives", async () => {
    const user = userEvent.setup();
    const { container } = render(<ChatPanel activeNode={activeNode} projectId="p-1" />);

    await screen.findByRole("button", { name: /发送/ });
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 320 });
    viewport!.scrollTop = 0;

    await user.type(screen.getByPlaceholderText(/和当前节点 Agent 讨论/), "请继续");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    await screen.findByText("这是最终回复。");

    await waitFor(() => {
      expect(viewport!.scrollTop).toBe(320);
    });
  });

  it("renders streamed reasoning separately from final assistant output", async () => {
    const user = userEvent.setup();
    render(<ChatPanel activeNode={activeNode} projectId="p-1" />);

    await screen.findByRole("button", { name: /发送/ });
    await user.type(screen.getByPlaceholderText(/和当前节点 Agent 讨论/), "请分析");
    await user.click(screen.getByRole("button", { name: /发送/ }));

    expect(await screen.findByText("思考过程")).toBeInTheDocument();
    expect(await screen.findByText("先理解节点上下文。")).toBeInTheDocument();
    expect(await screen.findByText("这是最终回复。")).toBeInTheDocument();
  });
});
