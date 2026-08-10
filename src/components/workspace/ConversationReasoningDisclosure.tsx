import { useState } from "react";
import { SafeMarkdown } from "./SafeMarkdown";

export function ConversationReasoningDisclosure({
  active,
  content,
}: {
  active: boolean;
  content?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!active && !content) return null;
  const label = active ? "Agent 正在思考" : "思考内容";
  const characterCount = [...(content ?? "")].length;
  const displayContent = content || "模型暂未提供公开思考内容";

  return (
    <section className={`conversation-reasoning ${active ? "is-active" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="conversation-turn-activity-dot" aria-hidden="true" />
        <strong>{label}</strong>
        {characterCount > 0 ? (
          <span className="conversation-reasoning-count">
            · {characterCount.toLocaleString("zh-CN")} 字
          </span>
        ) : null}
        <svg
          className={`conversation-reasoning-chevron${open ? " is-open" : ""}`}
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div className="conversation-reasoning-content">
          <SafeMarkdown markdown={displayContent} variant="reasoning" />
        </div>
      ) : null}
    </section>
  );
}
