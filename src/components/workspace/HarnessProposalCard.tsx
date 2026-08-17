import { lineDiffWithNumbers } from "../../export-diff";
import {
  proposalCanResolve,
  proposalStaleDetail,
  proposalStatusLabel,
  proposalTargetLabel,
} from "../../harness-proposals";
import type { HarnessProposal } from "../../types";
import { Button, FileDiff } from "../ui";

export function HarnessProposalCard({
  proposal,
  blocked,
  busy,
  onApprove,
  onReject,
}: {
  proposal: HarnessProposal;
  blocked: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const canResolve = proposalCanResolve(proposal, busy, blocked);
  const staleDetail = proposalStaleDetail(proposal);
  const blockedDetail = proposal.kind === "delivery"
    ? "请先保存或撤销当前未保存的交付稿，再审核此提案。"
    : "请先保存或撤销当前未保存的 Agent 规则，再审核此提案。";
  return (
    <section className={`harness-proposal is-${proposal.status}`} aria-label={`${proposalTargetLabel(proposal)}提案`}>
      <header className="harness-proposal-head">
        <div>
          <strong>{proposalTargetLabel(proposal)}提案</strong>
          <span className="harness-proposal-status">{proposalStatusLabel(proposal)}</span>
        </div>
        {proposal.kind === "agent_rule" ? <small>仅影响当前节点后续对话</small> : null}
      </header>
      <p className="harness-proposal-reason">{proposal.reason}</p>
      <FileDiff
        className="harness-proposal-diff"
        label={<span>{proposal.kind === "delivery" ? "当前交付稿 → 建议交付稿" : "当前规则 → 建议规则"}</span>}
        rows={lineDiffWithNumbers(proposal.baseContent, proposal.proposedContent)}
      />
      {staleDetail ? <p className="harness-proposal-note is-stale">{staleDetail}</p> : null}
      {proposal.status === "ready" && blocked ? <p className="harness-proposal-note">{blockedDetail}</p> : null}
      {proposal.status === "ready" ? (
        <div className="harness-proposal-actions">
          <Button type="button" variant="primary" disabled={!canResolve} loading={busy} onClick={onApprove}>应用提案</Button>
          <Button type="button" variant="ghost" disabled={!canResolve} onClick={onReject}>拒绝</Button>
        </div>
      ) : null}
    </section>
  );
}
