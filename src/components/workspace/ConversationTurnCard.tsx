import type { ChatMessage, ConversationTurn } from "../../types";
import { turnCanRetryDelivery, turnHeadline } from "../../conversation-turns.ts";

export type ConversationTurnCardProps = {
  turn: ConversationTurn;
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
  markdownDirty: boolean;
  onRetryDelivery: (turnId: string) => void;
};

export function ConversationTurnCard({
  turn,
  userMessage,
  assistantMessage,
  markdownDirty,
  onRetryDelivery,
}: ConversationTurnCardProps) {
  const canRetry = turnCanRetryDelivery(turn, markdownDirty);
  return (
    <details
      className={`conversation-turn is-${turn.status} is-${turn.deliveryOutcome.kind}`}
      open
    >
      <summary className="conversation-turn-summary">{turnHeadline(turn)}</summary>
      <div className="conversation-turn-detail">
        {userMessage ? (
          <div className="conversation-turn-message is-user">{userMessage.content}</div>
        ) : null}
        {assistantMessage ? (
          <div className="conversation-turn-message is-assistant">
            {assistantMessage.content}
            {assistantMessage.modelExecution ? (
              <div className="conversation-message-execution">
                {assistantMessage.modelExecution.providerId} · {assistantMessage.modelExecution.model}
              </div>
            ) : null}
          </div>
        ) : null}
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
        {turn.reasoningSummary ? (
          <p className="conversation-turn-reasoning">{turn.reasoningSummary}</p>
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
      </div>
    </details>
  );
}
