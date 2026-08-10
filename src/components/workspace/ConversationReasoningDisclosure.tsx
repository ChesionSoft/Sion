import { useEffect, useRef, useState } from "react";
import type { TurnVisualPhase } from "../../conversation-turns.ts";
import { SafeMarkdown } from "./SafeMarkdown";
import { SionActivityOrb } from "./SionActivityOrb";

export function ConversationReasoningDisclosure({
  active,
  content,
  elapsedText = "",
  phase = "terminal",
}: {
  active: boolean;
  content?: string;
  elapsedText?: string;
  phase?: TurnVisualPhase;
}) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasContent = Boolean(content);

  useEffect(() => {
    if (!active || !hasContent) return;
    const element = contentRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [active, content, hasContent]);

  // Running with no public summary yet: show only the shimmer, never a
  // fabricated placeholder.
  if (active && !hasContent) {
    return (
      <div className="conversation-reasoning is-active is-shimmer" role="status" aria-label="Agent 正在思考">
        <SionActivityOrb phase="thinking" />
        <span className="conversation-reasoning-shimmer" aria-hidden="true">Thinking…</span>
      </div>
    );
  }
  // Old turns with no recorded reasoning stay entirely absent.
  if (!active && !hasContent) return null;

  // While active, public reasoning is open and appends in stream order.
  if (active) {
    return (
      <section className="conversation-reasoning is-active is-open">
        <div className="conversation-reasoning-head">
          <SionActivityOrb phase={phase === "output" ? "output" : "reasoning"} />
          <strong className="conversation-reasoning-live-label">Thinking…</strong>
        </div>
        <div className="conversation-reasoning-collapsible">
          <div className="conversation-reasoning-inner">
            <div ref={contentRef} className="conversation-reasoning-content is-following">
              <SafeMarkdown markdown={content ?? ""} variant="reasoning" />
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Terminal: collapsed to an accessible summary with elapsed duration.
  const label = elapsedText ? `思考了 ${elapsedText}` : "思考内容";
  const characterCount = [...(content ?? "")].length;
  return (
    <section className={`conversation-reasoning${open ? " is-open" : ""}`}>
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
      <div className={`conversation-reasoning-collapsible${open ? " is-open" : " is-collapsed"}`}>
        <div className="conversation-reasoning-inner">
          <div className="conversation-reasoning-content">
            <SafeMarkdown markdown={content ?? ""} variant="reasoning" />
          </div>
        </div>
      </div>
    </section>
  );
}
