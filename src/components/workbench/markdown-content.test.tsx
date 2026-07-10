import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownContent, MarkdownErrorBoundary } from "./markdown-content";

describe("MarkdownContent", () => {
  it("renders GFM headings and tables and strips raw HTML", () => {
    render(
      <MarkdownContent
        markdown={"# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>"}
        variant="chat"
      />,
    );
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    // react-markdown's default (no rehype-raw) is the safety boundary: raw
    // <script> never becomes a real element.
    expect(document.querySelector("script")).toBeNull();
  });

  it("opens external links in a new tab with safe rel attributes", () => {
    render(<MarkdownContent markdown={"[外链](https://example.com/x)"} variant="chat" />);
    const link = screen.getByRole("link", { name: "外链" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("exposes a copy button on code blocks", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<MarkdownContent markdown={"```ts\nconst x = 1;\n```"} variant="chat" />);
    const button = screen.getByRole("button", { name: "复制" });
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith("const x = 1;");
  });

  it("falls back to plain text when the renderer throws", () => {
    // Silence React's console.error for the caught render error.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Throwing(): ReactNode {
      throw new Error("render boom");
    }
    render(
      <MarkdownErrorBoundary markdown="# 原始内容">
        <Throwing />
      </MarkdownErrorBoundary>,
    );
    expect(screen.getByText("# 原始内容")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    spy.mockRestore();
  });

  it("renders a delivery block as a collapsed 'written to doc' card", () => {
    const md =
      "已更新功能设计。\n```delivery\n" +
      JSON.stringify({
        changes: [{ sectionKey: "module_details", patchKind: "append_block", markdown: "客户管理功能包含 CRUD" }],
      }) +
      "\n```";
    render(<MarkdownContent markdown={md} variant="chat" />);
    expect(screen.getByText(/已写入交付稿/)).toBeInTheDocument();
    // Collapsed by default: the patch content is not shown.
    expect(screen.queryByText("客户管理功能包含 CRUD")).not.toBeInTheDocument();
    // A delivery block must NOT get the ordinary code-block copy button.
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("shows 'no updates this turn' for a complete but empty delivery block", () => {
    const md = "已答复。\n```delivery\n" + JSON.stringify({ changes: [] }) + "\n```";
    render(<MarkdownContent markdown={md} variant="chat" />);
    expect(screen.getByText(/本轮无需更新交付稿/)).toBeInTheDocument();
    expect(screen.queryByText(/正在整理/)).not.toBeInTheDocument();
  });

  it("shows the streaming placeholder for an incomplete delivery block", () => {
    // Unclosed fence with an unbalanced JSON object: still streaming.
    const md = "已答复。\n```delivery\n" + '{"changes":[{"sectionKey":"goals"';
    render(<MarkdownContent markdown={md} variant="chat" />);
    expect(screen.getByText(/正在整理写入交付稿的内容/)).toBeInTheDocument();
  });
});