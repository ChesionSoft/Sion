import type { ChatMessage, ConversationTurn } from "../../types";
import {
  formatTurnElapsed,
  turnCanRetryDelivery,
  turnDeliveryPresentation,
  turnElapsedMs,
  turnVisualPhase,
} from "../../conversation-turns.ts";
import { ConversationActivityTimeline } from "./ConversationActivityTimeline";
import { ConversationReasoningDisclosure } from "./ConversationReasoningDisclosure";
import { ConversationStreamingResponse } from "./ConversationStreamingResponse";
import { DeliveryDecisionDetails } from "./DeliveryDecisionDetails";
import { SafeMarkdown } from "./SafeMarkdown";

export type ConversationTurnCardProps = {
  turn: ConversationTurn;
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
  streamingMessage?: ChatMessage;
  liveReasoning?: string;
  liveDecisionRaw?: string;
  markdownDirty: boolean;
  onRetryDelivery: (turnId: string) => void;
  onOpenRunDetail: (runId: string) => void;
};

export function ConversationTurnCard({
  turn,
  userMessage,
  assistantMessage,
  streamingMessage,
  liveReasoning,
  liveDecisionRaw,
  markdownDirty,
  onRetryDelivery,
  onOpenRunDetail,
}: ConversationTurnCardProps) {
  const canRetry = turnCanRetryDelivery(turn, markdownDirty);
  const delivery = turnDeliveryPresentation(turn, markdownDirty);
  const active = turn.status === "queued" || turn.status === "running";
  const reasoningContent = liveReasoning || turn.reasoningSummary;
  const elapsedText = formatTurnElapsed(turnElapsedMs(turn, Date.now()));
  const showDecisionDetails = Boolean(turn.deliveryInspection) || Boolean(liveDecisionRaw);
  const visualPhase = turnVisualPhase(turn, liveReasoning, Boolean(streamingMessage));
  return (
    <article
      className={`conversation-turn is-${turn.status} is-${turn.deliveryOutcome.kind} is-phase-${visualPhase}`}
    >
      {userMessage ? (
        <section className="conversation-turn-block is-user">
          <div className="conversation-turn-speaker">你</div>
          <div className="conversation-turn-message is-user">{userMessage.content}</div>
        </section>
      ) : null}
      <ConversationReasoningDisclosure
        key={turn.runId}
        active={active}
        content={reasoningContent}
        elapsedText={elapsedText}
        phase={visualPhase}
      />
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
      {!assistantMessage && streamingMessage ? (
        <section className="conversation-turn-block is-assistant is-streaming">
          <div className="conversation-turn-speaker">Sion</div>
          <ConversationStreamingResponse content={streamingMessage.content} />
        </section>
      ) : null}
      <ConversationActivityTimeline
        turn={turn}
        onOpenRunDetail={onOpenRunDetail}
      />
      {delivery.kind !== "pending" ? (
        <section className={`delivery-result is-${delivery.tone}`}>
          <div className="delivery-result-main">
            <strong>{delivery.headline}</strong>
            {delivery.detail ? <p>{delivery.detail}</p> : null}
          </div>
          <button
            type="button"
            className="delivery-result-action"
            onClick={() => onOpenRunDetail(turn.runId)}
          >
            查看详情
          </button>
        </section>
      ) : null}
      {showDecisionDetails ? (
        <DeliveryDecisionDetails
          inspection={turn.deliveryInspection}
          liveRaw={liveDecisionRaw}
          outcome={turn.deliveryOutcome}
        />
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
