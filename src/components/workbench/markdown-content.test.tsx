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
});