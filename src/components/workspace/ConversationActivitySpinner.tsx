import type { CSSProperties } from "react";

/** AIcss Orbs C2, deliberately rendered only for the one current activity. */
export function ConversationActivitySpinner() {
  return (
    <span className="conversation-activity-spinner" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <i
          key={index}
          style={{ "--c2-delay": `${-((7 - index) / 8) * 2000}ms` } as CSSProperties}
        />
      ))}
    </span>
  );
}
