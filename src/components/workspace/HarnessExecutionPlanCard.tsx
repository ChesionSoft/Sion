import type { HarnessExecutionPlan, HarnessExecutionRecord } from "../../types";
import { executionInvalidReasonLabel, executionPlanStatusLabel, executionStatusLabel } from "../../harness-execution";

type Props = { plan?: HarnessExecutionPlan; execution?: HarnessExecutionRecord };

export function HarnessExecutionPlanCard({ plan, execution }: Props) {
  if (!plan && !execution) return null;
  return (
    <section className="harness-execution-card" aria-label="确认执行计划">
      {plan ? (
        <div className="harness-execution-plan">
          <div className="harness-execution-heading">
            <strong>文稿修改计划</strong>
            <span className={`harness-execution-status is-${plan.status}`}>{executionPlanStatusLabel(plan)}</span>
          </div>
          <p className="harness-execution-summary">{plan.summary}</p>
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
            <span className={`harness-execution-status is-${execution.status}`}>{execution.writes.length} 次保存</span>
          </div>
          {execution.writes.length ? (
            <ul className="harness-execution-writes">
              {execution.writes.map((write) => (
                <li key={`${write.revision}-${write.savedAt}`}>
                  <span>revision {write.revision}</span>
                  <span>{write.summary}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {execution.publicError ? <p className="harness-execution-note">{execution.publicError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
