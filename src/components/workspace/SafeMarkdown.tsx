import { Component, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  blockedMarkdownUrl,
  markdownImageLabel,
} from "../../markdown-policy.ts";

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
            pre: ({ children }) => (
              <div className="safe-markdown-code-scroll">
                <pre>{children}</pre>
              </div>
            ),
          }}
        >
          {markdown}
        </Markdown>
      </div>
    </MarkdownErrorBoundary>
  );
}
