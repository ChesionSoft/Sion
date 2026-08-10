import { useState, type ReactElement, type ReactNode } from "react";

function childText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childText).join("");
  const element = node as ReactElement<{ children?: ReactNode }>;
  return childText(element.props?.children);
}

function languageOf(children: ReactNode): string {
  if (children && typeof children === "object" && !Array.isArray(children) && "props" in children) {
    const className = (children as ReactElement<{ className?: string }>).props?.className ?? "";
    return className.replace(/^language-/, "");
  }
  return "";
}

export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = languageOf(children);
  const code = childText(children);
  const lines = code.split("\n");
  const copy = () => {
    const result = navigator.clipboard?.writeText(code);
    if (result) {
      result.then(() => setCopied(true)).catch(() => {});
    }
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <svg className="md-code-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M5.5 4.5 2 8l3.5 3.5m5-7L14 8l-3.5 3.5M9.5 3l-3 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="md-code-lang">{lang || "code"}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={copy}
          aria-label={copied ? "已复制" : "复制代码"}
        >
          {copied ? "✓ 已复制" : "复制"}
        </button>
      </div>
      <div className="md-code-body">
        {lines.map((line, index) => (
          <div className="md-code-row" key={index}>
            <span className="md-code-ln">{index + 1}</span>
            <code className="md-code-text">{line || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
