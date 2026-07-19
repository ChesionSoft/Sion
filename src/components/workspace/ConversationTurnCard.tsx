import type { ChatMessage, ConversationTurn } from "../../types";
import { turnCanRetryDelivery, turnHeadline } from "../../conversation-turns.ts";
import { ConversationReasoningDisclosure } from "./ConversationReasoningDisclosure";
import { SafeMarkdown } from "./SafeMarkdown";

export type ConversationTurnCardProps = {
  turn: ConversationTurn;
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
  liveReasoning?: string;
  markdownDirty: boolean;
  onRetryDelivery: (turnId: string) => void;
  onOpenRunDetail: (runId: string) => void;
};

export function ConversationTurnCard({
  turn,
  userMessage,
  assistantMessage,
  liveReasoning,
  markdownDirty,
  onRetryDelivery,
  onOpenRunDetail,
}: ConversationTurnCardProps) {
  const canRetry = turnCanRetryDelivery(turn, markdownDirty);
  return (
    <article
      className={`conversation-turn is-${turn.status} is-${turn.deliveryOutcome.kind}`}
    >
      {userMessage ? (
        <section className="conversation-turn-block is-user">
          <div className="conversation-turn-speaker">你</div>
          <div className="conversation-turn-message is-user">{userMessage.content}</div>
        </section>
      ) : null}
      {assistantMessage ? (
        <section className="conversation-turn-block is-assistant">
          <div className="conversation-turn-speaker">Sion</div>
          <div className="conversation-turn-message is-assistant">
            <SafeMarkdown markdown={assistantMessage.content} variant="chat" />
            {assistantMessage.modelExecution ? (
              <div className="conversation-message-execution">
                {assistantMessage.modelExecution.providerId} · {assistantMessage.modelExecution.model}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      <ConversationReasoningDisclosure
        key={turn.runId}
        active={turn.status === "queued" || turn.status === "running"}
        content={liveReasoning || turn.reasoningSummary}
      />
      <button
        type="button"
        className="conversation-turn-status"
        onClick={() => onOpenRunDetail(turn.runId)}
        aria-label={`查看运行详情：${turnHeadline(turn)}`}
      >
        <span className="conversation-turn-activity-dot" aria-hidden="true" />
        <strong>{turnHeadline(turn)}</strong>
        <span className="conversation-turn-status-arrow" aria-hidden="true">›</span>
      </button>
      {turn.activities.length > 0 ? (
        <ul className="conversation-turn-activities">
          {turn.activities.map((activity) => (
            <li key={activity.id} className={`is-${activity.status}`}>
              <span className="conversation-turn-activity-dot" aria-hidden="true" />
              <span className="conversation-turn-activity-label">{activity.label}</span>
              {activity.publicSummary ? (
                <span className="conversation-turn-activity-summary">{activity.publicSummary}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canRetry ? (
        <button
          type="button"
          className="conversation-turn-retry"
          onClick={() => onRetryDelivery(turn.id)}
        >
          重新判断交付稿
        </button>
      ) : null}
    </article>
  );
}
