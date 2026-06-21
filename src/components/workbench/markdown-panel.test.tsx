import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPanel } from "./markdown-panel";
import type { MarkdownGenerationState } from "./markdown-generation-types";
import type { ModelProvider, ProjectNode, ReasoningEffort } from "@/lib/project/types";

const localNode: ProjectNode = {
  id: "basic-info",
  status: "draft",
  markdown: "# 1. 项目基本信息\n\n## 已确认内容\n\nKnown item.\n\n## 设计假设\n\n## 待确认问题\n",
  revision: 0,
  updatedAt: "2026-06-14T10:00:00.000Z",
};

const defaultSharedContext = {
  activeSessionId: "s-1",
  providerId: "mp-1",
  model: "GPT-5.5",
  reasoningEffort: "medium" as ReasoningEffort,
  providers: [] as ModelProvider[],
};

function renderPanel(overrides: {
  node?: ProjectNode;
  genState?: MarkdownGenerationState;
} = {}) {
  const node = overrides.node ?? localNode;
  const genState = overrides.genState ?? { phase: "idle" as const };
  const onChange = vi.fn();
  const onSavedNode = vi.fn();
  const setGenState = vi.fn();

  const utils = render(
    <MarkdownPanel
      node={node}
      onChange={onChange}
      onSavedNode={onSavedNode}
      projectId="p-1"
      genState={genState}
      setGenState={setGenState}
      sharedContext={defaultSharedContext}
    />,
  );

  return { ...utils, onChange, onSavedNode, setGenState };
}

describe("MarkdownPanel", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders node id and markdown content", () => {
    renderPanel();
    expect(screen.getByText("basic-info")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Known item/)).toBeInTheDocument();
  });

  it("renders edit, preview, and agent tabs", () => {
    renderPanel();
    expect(screen.getByRole("tab", { name: "编辑 Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "预览交付稿" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Agent 规则" })).toBeInTheDocument();
  });

  it("reloads agent rules when the active node changes while the agent tab is open", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/agents/basic-info")) {
        return new Response(
          JSON.stringify({
            setting: { mode: "default" },
            defaultContent: "basic-info default rules",
            customContent: null,
          }),
        );
      }
      if (url.includes("/agents/goals")) {
        return new Response(
          JSON.stringify({
            setting: { mode: "default" },
            defaultContent: "goals default rules",
            customContent: null,
          }),
        );
      }
      return new Response(JSON.stringify({}));
    });

    const goalsNode: ProjectNode = {
      ...localNode,
      id: "goals",
      markdown: "# 2. 项目目标",
    };

    const { rerender } = renderPanel();
    await user.click(screen.getByRole("tab", { name: "Agent 规则" }));

    expect(await screen.findByText("basic-info default rules")).toBeInTheDocument();

    rerender(
      <MarkdownPanel
        node={goalsNode}
        onChange={vi.fn()}
        onSavedNode={vi.fn()}
        projectId="p-1"
        genState={{ phase: "idle" }}
        setGenState={vi.fn()}
        sharedContext={defaultSharedContext}
      />,
    );

    expect(await screen.findByText("goals default rules")).toBeInTheDocument();
    expect(screen.queryByText("basic-info default rules")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/projects/p-1/agents/goals");
  });

  it("save sends expectedRevision with the PATCH body", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ node: { ...localNode, revision: 1 } })),
    );
    renderPanel();

    await screen.findByDisplayValue(/Known item/);
    await user.click(screen.getByRole("button", { name: /保存当前节点交付稿/ }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/nodes/basic-info"),
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"expectedRevision":0'),
        }),
      );
    });
  });

  it("save 409 leads to conflict state", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          latestNode: { ...localNode, markdown: "# Conflict version", revision: 3 },
        }),
        { status: 409 },
      ),
    );
    const { setGenState } = renderPanel();

    await screen.findByDisplayValue(/Known item/);
    await user.click(screen.getByRole("button", { name: /保存当前节点交付稿/ }));

    await waitFor(() => {
      expect(setGenState).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "conflict" }),
      );
    });
  });

  it("checking phase shows feedback and locks editing actions", () => {
    renderPanel({ genState: { phase: "checking" } });
    expect(screen.getByText("正在判断是否需要更新交付稿...")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Known item/)).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: /保存当前节点交付稿/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "按规则重写交付稿" })).toBeDisabled();
  });

  it("shows animation status during previewing_increment", () => {
    renderPanel({
      genState: { phase: "previewing_increment", patches: [], baseRevision: 0 },
    });
    expect(screen.getByText("正在修改交付稿…")).toBeInTheDocument();
  });

  it("shows submitting status during submitting_increment", () => {
    renderPanel({ genState: { phase: "submitting_increment" } });
    expect(screen.getByText("正在提交增量写入...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "中断写入" })).not.toBeInTheDocument();
  });

  it("shows rewrite status during previewing_rewrite", () => {
    renderPanel({ genState: { phase: "previewing_rewrite", candidate: "" } });
    expect(screen.getByText("按规则重写中...")).toBeInTheDocument();
  });

  it("increment animation completes and calls patch endpoint", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const patches = [
      {
        category: "confirmed_fact" as const,
        targetSectionKey: "confirmed" as const,
        patchKind: "append_bullet" as const,
        markdown: "New info",
        evidence: { source: "assistant" as const, quote: "test" },
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          node: {
            ...localNode,
            markdown: "# 1. 项目基本信息\n\n## 已确认内容\n\nKnown item.\n\n- New info\n\n## 设计假设\n\n## 待确认问题\n",
            revision: 1,
          },
        }),
      ),
    );

    const { onSavedNode } = renderPanel({
      genState: { phase: "previewing_increment", patches, baseRevision: 0 },
    });

    // Advance timers by 2 seconds - enough for the 40ms interval to fire many times
    await vi.advanceTimersByTimeAsync(5000);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/patch"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"expectedRevision":0'),
        }),
      );
    });

    await waitFor(() => {
      expect(onSavedNode).toHaveBeenCalled();
    });
  });

  it("interrupt during animation stops and does NOT call patch endpoint", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });

    const patches = [
      {
        category: "confirmed_fact" as const,
        targetSectionKey: "confirmed" as const,
        patchKind: "append_bullet" as const,
        markdown: "Do not apply",
        evidence: { source: "assistant" as const, quote: "test" },
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ node: { ...localNode, revision: 1 } })),
    );

    const { setGenState } = renderPanel({
      genState: { phase: "previewing_increment", patches, baseRevision: 0 },
    });

    // Click interrupt immediately (before animation completes)
    await user.click(screen.getByRole("button", { name: "中断写入" }));

    await waitFor(() => {
      expect(setGenState).toHaveBeenCalledWith({ phase: "idle" });
    });

    // Since animation was interrupted, patch endpoint should NOT be called
    const patchCalls = vi.mocked(fetch).mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("/patch"),
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("rewrite flows: SSE tokens arrive and markdown_done causes sync", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: RequestInfo) => {
      if (String(url).includes("/rewrite")) {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"type":"markdown_token","content":"# Rewritten"}\n\n'));
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "markdown_done",
                    updatedNode: {
                      id: "basic-info",
                      status: "generated",
                      markdown: "# Rewritten",
                      revision: 1,
                      updatedAt: "2026-06-14T11:00:00.000Z",
                    },
                  })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({}));
    });

    const user = userEvent.setup();
    const { setGenState, onSavedNode } = renderPanel();

    await user.click(screen.getByRole("button", { name: /按规则重写交付稿/ }));

    await waitFor(() => {
      expect(setGenState).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "previewing_rewrite" }),
      );
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/rewrite"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    await waitFor(() => {
      expect(onSavedNode).toHaveBeenCalled();
    });
  });

  it("rewrite conflict shows candidate and syncs latestNode", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "markdown_conflict",
                  latestNode: { ...localNode, markdown: "# Conflict", revision: 5 },
                  candidateMarkdown: "# Candidate draft",
                })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });

    const user = userEvent.setup();
    const { setGenState, onSavedNode } = renderPanel();

    await user.click(screen.getByRole("button", { name: /按规则重写交付稿/ }));

    await waitFor(() => {
      expect(setGenState).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "conflict", candidate: "# Candidate draft" }),
      );
    });

    expect(onSavedNode).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 5 }),
    );
  });
});
