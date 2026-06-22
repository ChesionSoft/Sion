"use client";

import { Component, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

type MarkdownVariant = "chat" | "document";

type MarkdownContentProps = {
  markdown: string;
  variant: MarkdownVariant;
};

/**
 * Shared, safe GFM renderer for chat messages and the delivery document
 * preview. Raw HTML is NOT enabled (no rehype-raw): react-markdown's default
 * behavior escapes raw markup, which is the safety boundary that keeps
 * pasted <script>/<iframe> from ever executing. Links open in a new tab with
 * safe rel attributes; tables and code blocks scroll locally instead of
 * blowing out the layout.
 */
export function MarkdownContent({ markdown, variant }: MarkdownContentProps) {
  return (
    <MarkdownErrorBoundary markdown={markdown}>
      <div className={cn("markdown-content", variant === "document" ? "markdown-document" : "markdown-chat")}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href = "", children }) => (
              <a href={href} rel="noreferrer noopener" target="_blank">
                {children}
              </a>
            ),
            table: ({ children }) => (
              <div className="markdown-table-scroll">
                <table>{children}</table>
              </div>
            ),
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
}

/**
 * Extract the rendered code text from a <pre><code> subtree so the copy
 * button copies exactly what the user sees, regardless of language tag.
 */
function extractCodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractCodeText).join("");
  // React element / portal: read children. Avoid depending on element props
  // typing by reading defensively.
  const props = (node as { props?: { children?: ReactNode } }).props;
  return props ? extractCodeText(props.children) : "";
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    // Strip the trailing newlines that come from the code fence, not the code.
    const text = extractCodeText(children).replace(/\n+$/, "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (e.g. non-secure context) — silently ignore
    }
  };

  return (
    <div className="markdown-code-block">
      <button type="button" onClick={copy} className="markdown-code-copy" aria-label="复制代码">
        {copied ? "已复制" : "复制代码"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

type ErrorBoundaryState = { failed: boolean };

/**
 * Class-based boundary (React still requires getDerivedStateFromError for
 * error boundaries). On any renderer failure it shows the original Markdown as
 * plain preformatted text — never removing the message and never using
 * dangerouslySetInnerHTML.
 */
export class MarkdownErrorBoundary extends Component<
  { markdown: string; children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <div className="whitespace-pre-wrap">{this.props.markdown}</div>;
    }
    return this.props.children;
  }
}