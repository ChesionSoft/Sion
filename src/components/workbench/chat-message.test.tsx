import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMessageView } from "./chat-message";
import type { ChatMessage, ExternalSource, TurnTokenUsage } from "@/lib/project/types";

const baseAssistant: ChatMessage = {
  id: "a-1",
  role: "assistant",
  content: "# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |",
  createdAt: "2026-06-22T00:00:00.000Z",
};

const source: ExternalSource = {
  id: "src-1",
  kind: "web_search",
  url: "https://example.com/x",
  title: "Example",
  domain: "example.com",
  snippet: "片段",
  retrievedAt: "2026-06-22T00:00:00.000Z",
};

const usage: TurnTokenUsage = {
  turnId: "t-1",
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  source: "exact",
  callCount: 1,
  calls: [],
};

describe("ChatMessageView", () => {
  it("renders user messages as right-aligned plain text", () => {
    render(<ChatMessageView message={{ id: "u-1", role: "user", content: "你好", createdAt: "x" }} />);
    const root = document.querySelector('[data-role="user"]') as HTMLElement;
    expect(root).toBeInTheDocument();
    expect(screen.getByText("你好")).toBeInTheDocument();
  });

  it("renders assistant content as Markdown (headings and tables)", () => {
    render(<ChatMessageView message={baseAssistant} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("keeps reasoning in a closed details element by default", () => {
    render(
      <ChatMessageView
        message={{ ...baseAssistant, reasoningContent: "先分析需求。" }}
      />,
    );
    const details = document.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(false);
  });

  it("shows the active reasoning summary and duration while collapsed", () => {
    render(
      <ChatMessageView
        message={{ ...baseAssistant, reasoningContent: "思考中…" }}
        activity={{ stage: "generating_answer", summary: "正在生成回复", elapsedSeconds: 3 }}
      />,
    );
    expect(screen.getByText("正在生成回复 · 3 秒")).toBeInTheDocument();
    const details = document.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it("shows 已思考 N 秒 for historical reasoning from reasoningDurationMs", () => {
    render(
      <ChatMessageView
        message={{ ...baseAssistant, reasoningContent: "先分析。", reasoningDurationMs: 12000 }}
      />,
    );
    expect(screen.getByText(/已思考 12 秒/)).toBeInTheDocument();
  });

  it("shows source links and usage below the content", () => {
    render(
      <ChatMessageView
        message={{ ...baseAssistant, sources: [source], usage }}
      />,
    );
    expect(screen.getByRole("link", { name: /Example/ })).toBeInTheDocument();
    expect(screen.getByText("精确")).toBeInTheDocument();
  });
});