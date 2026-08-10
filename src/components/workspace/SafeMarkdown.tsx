import { Component, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  blockedMarkdownUrl,
  markdownImageLabel,
} from "../../markdown-policy.ts";
import { isFencedCodeComplete } from "../../conversation-turns.ts";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

type SafeMarkdownVariant = "document" | "chat" | "reasoning";

export type SafeMarkdownProps = {
  markdown: string;
  variant: SafeMarkdownVariant;
};

type MarkdownErrorBoundaryProps = {
  children: ReactNode;
  markdown: string;
};

type MarkdownErrorBoundaryState = {
  failed: boolean;
};

class MarkdownErrorBoundary extends Component<
  MarkdownErrorBoundaryProps,
  MarkdownErrorBoundaryState
> {
  state: MarkdownErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): MarkdownErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="safe-markdown-fallback">
          {this.props.markdown}
        </div>
      );
    }
    return this.props.children;
  }
}

export function SafeMarkdown({ markdown, variant }: SafeMarkdownProps) {
  // While a fenced code block is still open in a streaming reply, keep the
  // partial content as stable plain text; only once every fence closes does
  // the Markdown code-block component render. Prevents a runaway, layout-
  // jumping code block from an unclosed fence.
  if (variant === "chat" && !isFencedCodeComplete(markdown)) {
    return (
      <MarkdownErrorBoundary markdown={markdown}>
        <div className="safe-markdown is-chat is-fence-open">
          <pre className="safe-markdown-fence-open">{markdown}</pre>
        </div>
      </MarkdownErrorBoundary>
    );
  }
  return (
    <MarkdownErrorBoundary markdown={markdown}>
      <div className={`safe-markdown is-${variant}`}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          urlTransform={blockedMarkdownUrl}
          components={{
            a: ({ children }) => (
              <span className="markdown-link-text">{children}</span>
            ),
            img: ({ alt }) => (
              <span className="markdown-image-placeholder">
                {markdownImageLabel(alt)}
              </span>
            ),
            table: ({ children }) => (
              <div className="safe-markdown-table-scroll">
                <table>{children}</table>
              </div>
            ),
            pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
          }}
        >
          {markdown}
        </Markdown>
      </div>
    </MarkdownErrorBoundary>
  );
}
