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
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="md-code-block">
      <div className="md-code-head">
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
