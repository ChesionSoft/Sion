import type { HarnessExecutionPlan, HarnessExecutionRecord, NodeId } from "../../types";
import { Icon } from "../ui";
import { executionInvalidReasonLabel, executionNodeLabel, executionPlanStatusLabel, executionPlanTargets, executionStatusLabel, executionTargetState } from "../../harness-execution";

type Props = {
  plan?: HarnessExecutionPlan;
  execution?: HarnessExecutionRecord;
  onUndoWrite?: (nodeId: NodeId, revision: number) => void;
  undoingWriteKey?: string;
};

export function HarnessExecutionPlanCard({ plan, execution, onUndoWrite, undoingWriteKey }: Props) {
  if (!plan && !execution) return null;
  const writes = execution?.writes ?? [];
  return (
    <section className="harness-execution-card" aria-label="确认执行计划">
      {plan ? (
        <div className="harness-execution-plan">
          <div className="harness-execution-heading">
            <strong>文稿修改计划</strong>
            <span className={`harness-execution-status is-${plan.status}`}>{executionPlanStatusLabel(plan)}</span>
          </div>
          <p className="harness-execution-summary">{plan.summary}</p>
          <ol className="harness-execution-targets" aria-label="确认目标节点">
            {executionPlanTargets(plan).map((target, index) => (
              <li key={target.nodeId}>
                <span className="harness-execution-target-index" aria-hidden="true">{index + 1}.</span>
                <span>{executionNodeLabel(target.nodeId)}</span>
                <span className="harness-execution-target-revision">基线 revision {target.baseRevision}</span>
              </li>
            ))}
          </ol>
          {plan.status === "pending" ? (
            <p className="harness-execution-confirm">回复“继续”或“可以”后，Sion 会执行这一轮修改。</p>
          ) : plan.status === "invalidated" ? (
            <p className="harness-execution-note">{executionInvalidReasonLabel(plan.invalidReason)}</p>
          ) : null}
        </div>
      ) : null}
      {execution ? (
        <div className="harness-execution-audit">
          <div className="harness-execution-heading">
            <strong>{executionStatusLabel(execution)}</strong>
            <span className={`harness-execution-status is-${execution.status}`}>{execution.completedTargets?.length ?? writes.length} 个节点已保存</span>
          </div>
          {plan ? (
            <ul className="harness-execution-target-audit">
              {executionPlanTargets(plan).map((target) => {
                const state = executionTargetState(plan, execution, target.nodeId);
                return (
                  <li key={target.nodeId} data-state={state}>
                    <span>{executionNodeLabel(target.nodeId)}</span>
                    <span>{state === "saved" ? "已保存" : state === "stopped" ? "已停止" : "待执行"}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {writes.length ? (
            <ul className="harness-execution-writes">
              {writes.map((write, index) => {
                const writeNodeId = write.nodeId ?? plan?.nodeId;
                const writeKey = writeNodeId ? `${writeNodeId}:${write.revision}` : undefined;
                const isLatestUndoable = execution.status !== "running"
                  && index === writes.length - 1
                  && !write.undoneAt
                  && write.previousRevision !== undefined
                  && Boolean(writeNodeId);
                return (
                  <li key={`${writeNodeId ?? "current"}-${write.revision}-${write.savedAt}`} data-undone={write.undoneAt ? "true" : undefined}>
                    <span>revision {write.revision}</span>
                    <span>{write.summary}</span>
                    {write.undoneAt ? <span className="harness-execution-undo-state">已撤销</span> : null}
                    {isLatestUndoable && onUndoWrite && writeNodeId ? (
                      <button
                        type="button"
                        className="harness-execution-undo"
                        aria-label={`撤销 revision ${write.revision}`}
                        title="撤销这次修改"
                        disabled={undoingWriteKey === writeKey}
                        onClick={() => onUndoWrite(writeNodeId, write.revision)}
                      >
                        <Icon name="undo" />
                        <span>{undoingWriteKey === writeKey ? "撤销中…" : "撤销"}</span>
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {execution.publicError ? <p className="harness-execution-note">{execution.publicError}</p> : null}
          {execution.stoppedReason ? <p className="harness-execution-note">{execution.stoppedReason}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
