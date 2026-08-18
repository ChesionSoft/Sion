import type { ChatMessage, ConversationTurn } from "../../types";
import {
  formatTurnElapsed,
  turnDeliveryPresentation,
  turnElapsedMs,
  turnVisualPhase,
} from "../../conversation-turns.ts";
import { ConversationActivityTimeline } from "./ConversationActivityTimeline";
import { ConversationReasoningDisclosure } from "./ConversationReasoningDisclosure";
import { ConversationStreamingResponse } from "./ConversationStreamingResponse";
import { ConversationDeliveryGeneration } from "./ConversationDeliveryGeneration";
import { DeliveryDecisionDetails } from "./DeliveryDecisionDetails";
import { HarnessProposalCard } from "./HarnessProposalCard";
import { HarnessExecutionPlanCard } from "./HarnessExecutionPlanCard";
import { SafeMarkdown } from "./SafeMarkdown";

export type ConversationTurnCardProps = {
  turn: ConversationTurn;
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
  streamingMessage?: ChatMessage;
  liveReasoning?: string;
  markdownDirty: boolean;
  agentRulesDirty: boolean;
  resolvingProposalIds: Record<string, true>;
  onApproveProposal: (turnId: string, proposalId: string) => void;
  onRejectProposal: (turnId: string, proposalId: string) => void;
  onOpenRunDetail: (runId: string) => void;
};

export function ConversationTurnCard({
  turn,
  userMessage,
  assistantMessage,
  streamingMessage,
  liveReasoning,
  markdownDirty,
  agentRulesDirty,
  resolvingProposalIds,
  onApproveProposal,
  onRejectProposal,
  onOpenRunDetail,
}: ConversationTurnCardProps) {
  const delivery = turnDeliveryPresentation(turn, markdownDirty);
  const active = turn.status === "queued" || turn.status === "running";
  const reasoningContent = liveReasoning || turn.reasoningSummary;
  const elapsedText = formatTurnElapsed(turnElapsedMs(turn, Date.now()));
  const showDecisionDetails = Boolean(turn.deliveryInspection);
  const visualPhase = turnVisualPhase(turn, liveReasoning, Boolean(streamingMessage));
  const activeDelivery = active
    ? turn.activities.find((activity) => activity.kind !== "response" && activity.status === "running")
    : undefined;
  const legacyDeliveryKind = turn.deliveryOutcome?.kind ?? "harness";
  return (
    <article
      className={`conversation-turn is-${turn.status} is-${legacyDeliveryKind} is-phase-${visualPhase}`}
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
      {activeDelivery ? <ConversationDeliveryGeneration label={activeDelivery.label} /> : null}
      {delivery && delivery.kind !== "pending" ? (
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
          outcome={turn.deliveryOutcome}
        />
      ) : null}
      {turn.harness?.executionPlan || turn.harness?.execution ? (
        <HarnessExecutionPlanCard
          plan={turn.harness.executionPlan}
          execution={turn.harness.execution}
        />
      ) : null}
      {turn.harness?.proposals.map((proposal) => (
        <HarnessProposalCard
          key={proposal.id}
          proposal={proposal}
          blocked={proposal.kind === "delivery" ? markdownDirty : agentRulesDirty}
          busy={Boolean(resolvingProposalIds[`${turn.id}:${proposal.id}`])}
          onApprove={() => onApproveProposal(turn.id, proposal.id)}
          onReject={() => onRejectProposal(turn.id, proposal.id)}
        />
      ))}
    </article>
  );
}
