import { useState } from "react";

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

  return (
    <section className={`conversation-reasoning ${active ? "is-active" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="conversation-turn-activity-dot" aria-hidden="true" />
        <strong>{label}</strong>
        <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {open ? (
        <div className="conversation-reasoning-content">
          {content || "模型暂未提供公开思考内容"}
        </div>
      ) : null}
    </section>
  );
}
