import { render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActivity } from "./agent-activity";

describe("AgentActivity", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the summary, elapsed seconds, and the stage data attribute", () => {
    vi.useFakeTimers();
    const startedAt = 1_000_000;
    vi.setSystemTime(startedAt);
    render(<AgentActivity stage="thinking" summary="正在分析需求" startedAt={startedAt} />);

    expect(screen.getByText(/正在分析需求/)).toBeInTheDocument();
    const root = document.querySelector(".agent-activity") as HTMLElement;
    expect(root.getAttribute("data-stage")).toBe("thinking");

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByText("正在分析需求 · 8 秒")).toBeInTheDocument();
  });

  it("shows the completed label and a completed data-stage", () => {
    render(<AgentActivity stage="completed" summary="回复已生成" startedAt={null} />);
    const root = document.querySelector(".agent-activity") as HTMLElement;
    expect(root.getAttribute("data-stage")).toBe("completed");
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("omits elapsed time when startedAt is null", () => {
    render(<AgentActivity stage="thinking" summary="正在分析需求" startedAt={null} />);
    expect(screen.getByText("正在分析需求")).toBeInTheDocument();
    expect(screen.queryByText(/秒/)).toBeNull();
  });

  it("renders an accessible live region", () => {
    render(<AgentActivity stage="thinking" summary="正在分析需求" startedAt={null} />);
    const root = document.querySelector(".agent-activity") as HTMLElement;
    expect(root.getAttribute("aria-live")).toBe("polite");
  });

  it("renders a folded reasoning panel when reasoning is provided and the stage is active", () => {
    render(
      <AgentActivity
        stage="generating_answer"
        summary="正在生成回复"
        startedAt={null}
        reasoning="思考一下"
      />,
    );

    // The panel is folded by default but its summary and body are present.
    expect(screen.getByText(/思考过程 · 4 字/)).toBeInTheDocument();
    expect(screen.getByText("思考一下")).toBeInTheDocument();
    const details = document.querySelector("details.agent-reasoning") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
  });

  it("hides the reasoning panel when the stage is idle", () => {
    render(
      <AgentActivity stage="idle" summary="等待输入" startedAt={null} reasoning="思考一下" />,
    );
    expect(screen.queryByText(/思考过程/)).toBeNull();
  });

  it("hides the reasoning panel when reasoning is empty", () => {
    render(<AgentActivity stage="generating_answer" summary="正在生成回复" startedAt={null} />);
    expect(screen.queryByText(/思考过程/)).toBeNull();
  });
});