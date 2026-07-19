import { useState } from "react";
import { Button } from "../ui";
import { ArtifactDiff } from "./ArtifactDiff";
import type { ExportReviewTask } from "../../types";

export type ReviewLedgerProps = {
  tasks: ExportReviewTask[];
  busy: boolean;
  onCreateTask: (instruction: string) => void;
  onApplyTask: (taskId: string, selectedChangeIds: string[]) => void;
};

const STATUS_LABEL: Record<ExportReviewTask["status"], string> = {
  queued: "排队中",
  running: "生成中",
  ready: "待应用",
  partially_applied: "部分应用",
  applied: "已应用",
  stale: "已过期",
  failed: "失败",
  cancelled: "已取消",
};

export function ReviewLedger({ tasks, busy, onCreateTask, onApplyTask }: ReviewLedgerProps) {
  const [instruction, setInstruction] = useState("");
  const [selectedByTask, setSelectedByTask] = useState<Record<string, string[]>>({});

  const toggle = (taskId: string, changeId: string) => {
    setSelectedByTask((current) => {
      const selected = current[taskId] ?? [];
      return {
        ...current,
        [taskId]: selected.includes(changeId)
          ? selected.filter((id) => id !== changeId)
          : [...selected, changeId],
      };
    });
  };

  return (
    <section className="export-review-ledger" aria-label="评审任务账本">
      <h2 className="export-review-title">评审任务</h2>
      <textarea
        className="export-review-instruction"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder="输入一条聚焦的评审意见，例如：把目标改成可量化指标。"
        rows={3}
        disabled={busy}
      />
      <Button
        variant="primary"
        disabled={busy || instruction.trim().length === 0}
        onClick={() => {
          onCreateTask(instruction.trim());
          setInstruction("");
        }}
      >
        生成修改建议
      </Button>

      <div className="export-review-tasks">
        {tasks.length === 0 ? (
          <p className="export-review-placeholder">暂无评审任务。输入评审意见后生成修改建议。</p>
        ) : null}
        {tasks.map((task) => {
          const selected = selectedByTask[task.id] ?? [];
          const canApply = task.status === "ready" && !busy && selected.length > 0;
          return (
            <article key={task.id} className="export-review-task">
              <header className="export-review-task-header">
                <span className={`export-review-task-tag is-${task.status}`}>
                  {STATUS_LABEL[task.status]}
                </span>
                <small>{task.instruction}</small>
              </header>
              {task.proposedChanges.length > 0 ? (
                <ArtifactDiff
                  changes={task.proposedChanges}
                  selectedChangeIds={selected}
                  onToggle={(changeId) => toggle(task.id, changeId)}
                  disabled={task.status !== "ready" || busy}
                />
              ) : null}
              {task.status === "ready" || task.status === "partially_applied" ? (
                <Button
                  variant="secondary"
                  disabled={!canApply}
                  onClick={() => onApplyTask(task.id, selected)}
                >
                  应用修改
                </Button>
              ) : null}
              {task.status === "stale" ? (
                <p className="export-review-task-hint">文档已变化，建议创建新的评审任务。</p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}