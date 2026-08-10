import { SafeMarkdown } from "./SafeMarkdown";

export type ConversationStreamingResponseProps = {
  content: string;
};

/** Live assistant output driven purely by the real `agent-token` event
 * cadence — no simulated typewriter timing and no extra network call. The
 * visible copy is not in an `aria-live` region (so the full accumulated reply
 * is not re-announced each token); a constant `role="status"` line conveys
 * that streaming is happening exactly once, and a caret marks the position. */
export function ConversationStreamingResponse({ content }: ConversationStreamingResponseProps) {
  return (
    <div className="conversation-streaming" data-streaming="true">
      <div className="conversation-streaming-copy">
        <SafeMarkdown markdown={content} variant="chat" />
      </div>
      <span className="conversation-streaming-caret" aria-hidden="true" />
      <span className="conversation-streaming-status" role="status" aria-live="polite">
        Sion 正在生成回复
      </span>
    </div>
  );
}
