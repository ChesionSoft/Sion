import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TokenUsageDetails } from "./token-usage-details";
import type { TurnTokenUsage } from "@/lib/project/types";

function makeUsage(source: TurnTokenUsage["source"], callCount = 1): TurnTokenUsage {
  return {
    turnId: "t-1",
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
    source,
    callCount,
    calls: [],
  };
}

describe("TokenUsageDetails", () => {
  it("shows the total, breakdown, and source label inline (exact)", () => {
    render(<TokenUsageDetails usage={makeUsage("exact")} />);
    expect(screen.getByText(/20/)).toBeInTheDocument();
    expect(screen.getByText("精确")).toBeInTheDocument();
    expect(screen.getByText(/输入.*12/)).toBeInTheDocument();
    expect(screen.getByText(/输出.*8/)).toBeInTheDocument();
  });

  it("labels estimated usage as 估算", () => {
    render(<TokenUsageDetails usage={makeUsage("estimated")} />);
    expect(screen.getByText("估算")).toBeInTheDocument();
  });

  it("labels mixed usage as 含估算", () => {
    render(<TokenUsageDetails usage={makeUsage("mixed", 2)} />);
    expect(screen.getByText("含估算")).toBeInTheDocument();
    expect(screen.getByText(/2 次调用/)).toBeInTheDocument();
  });

  it("renders nothing for null usage by default", () => {
    const { container } = render(<TokenUsageDetails usage={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders 暂无统计 for null usage only when explicitly requested", () => {
    render(<TokenUsageDetails usage={null} showEmpty />);
    expect(screen.getByText("暂无统计")).toBeInTheDocument();
  });
});