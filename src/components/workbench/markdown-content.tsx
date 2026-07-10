"use client";

import { Component, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { parseDeliveryBlock } from "@/lib/project/delivery-block";

type MarkdownVariant = "chat" | "document";

type MarkdownContentProps = {
  markdown: string;
  variant: MarkdownVariant;
};

/**
 * Read the language tag and raw text out of the <code> element that is the
 * single child of a <pre>, so the `pre` override can route delivery blocks
 * to a card and leave everything else on the copy-button CodeBlock.
 */
function extractCodeMeta(node: ReactNode): { lang: string; text: string } {
  const child = Array.isArray(node) ? node[0] : node;
  const props = (child as { props?: { className?: string } } | null)?.props;
  const className = props?.className ?? "";
  const langMatch = /language-([\w-]+)/.exec(className);
  return { lang: langMatch ? langMatch[1] : "", text: extractCodeText(node) };
}

/**
 * Renders the assistant's ```delivery block as an expandable "written to
 * delivery doc" card. While the block is still streaming (unclosed fence),
 * parseDeliveryBlock returns no patches and the card shows a placeholder.
 */
function DeliveryCard({ raw }: { raw: string }) {
  const patches = useMemo(
    () => parseDeliveryBlock("```delivery\n" + raw + "\n```"),
    [raw],
  );
  const [open, setOpen] = useState(false);

  if (patches.length === 0) {
    return (
      <div className="my-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        正在整理写入交付稿的内容…
      </div>
    );
  }

  return (
    <div className="my-2 rounded-md border border-border bg-muted/30">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium hover:bg-muted/50"
        onClick={() => setOpen((o) => !o)}
      >
        <span>已写入交付稿（{patches.length} 条）</span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {patches.map((p, i) => (
            <div key={i} className="text-xs">
              <div className="mb-1 flex gap-2 text-muted-foreground">
                <span>{p.targetSectionKey}</span>
                <span>·</span>
                <span>
                  {p.patchKind === "append_table_row" ? "表格行" : p.patchKind === "append_bullet" ? "条目" : "段落"}
                </span>
              </div>
              <pre className="whitespace-pre-wrap break-words rounded bg-background px-2 py-1">{p.markdown}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
            pre: ({ children }) => {
              const meta = extractCodeMeta(children);
              if (meta.lang === "delivery") {
                return <DeliveryCard raw={meta.text} />;
              }
              return <CodeBlock>{children}</CodeBlock>;
            },
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
      toast.success("已复制到剪贴板");
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <div className="markdown-code-block">
      <Button
        aria-label="复制"
        className="markdown-code-copy"
        onClick={copy}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
      </Button>
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