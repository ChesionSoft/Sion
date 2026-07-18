import type { AgentRun } from "../../types";
import { StatusDot } from "../ui";

const RUN_STATUS_LABEL: Record<AgentRun["status"], string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const RUN_KIND_LABEL: Record<AgentRun["kind"], string> = {
  conversation: "对话",
  delivery_retry: "交付重试",
  delivery_regeneration: "重新生成交付稿",
};

function statusKind(status: AgentRun["status"]) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "error" as const;
  if (status === "running" || status === "queued") return "running" as const;
  return "neutral" as const;
}

function shortTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RunHistoryList({ runs, error, onOpen }: {
  runs: AgentRun[];
  error: string | null;
  onOpen: (runId: string) => void;
}) {
  if (error) return <p role="alert">{error}</p>;
  if (runs.length === 0) return <p>还没有运行记录。</p>;

  return runs.slice(0, 8).map((run) => (
    <button
      type="button"
      className="run-history-row"
      key={run.id}
      onClick={() => onOpen(run.id)}
      aria-label={`查看${RUN_KIND_LABEL[run.kind]}运行详情，${RUN_STATUS_LABEL[run.status]}`}
    >
      <StatusDot kind={statusKind(run.status)} />
      <span>
        <strong>{RUN_KIND_LABEL[run.kind]}</strong>
        <small>{shortTime(run.startedAt ?? run.createdAt)} · {RUN_STATUS_LABEL[run.status]}</small>
      </span>
      <span className="run-history-row-arrow" aria-hidden="true">›</span>
    </button>
  ));
}
