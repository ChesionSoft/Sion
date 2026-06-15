import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./chat-panel";
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
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
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
              models: ["GPT-5.5", "GPT-5.4", "GPT-5.4-Mini"],
              defaultModel: "GPT-5.5",
              isDefault: true,
              createdAt: "2026-06-14T10:00:00.000Z",
              updatedAt: "2026-06-14T10:00:00.000Z",
            },
          ],
        }),
      );
    }

    if (url.includes("/files")) {
      return new Response(JSON.stringify({ files: [] }));
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

describe("ChatPanel", () => {
  it("renders a session selector and new session button", async () => {
    render(<ChatPanel activeNode={activeNode} projectId="p-1" />);

    expect(await screen.findByLabelText("会话")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "新会话" })).toBeInTheDocument();
    expect(screen.getByText("6月14日 23:30 · 2 条")).toBeInTheDocument();
  });

  it("renders the compact model menu with reasoning effort and nested models", async () => {
    const user = userEvent.setup();
    render(<ChatPanel activeNode={activeNode} projectId="p-1" />);

    const trigger = await screen.findByRole("button", { name: "模型 GPT-5.5，推理 中" });
    expect(trigger).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByText("推理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "低" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "高" })).toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "GPT-5.5" }));
    expect(screen.getByText("模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GPT-5.4" })).toBeInTheDocument();
  });
});
