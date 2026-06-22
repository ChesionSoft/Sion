"use client";

import { useEffect, useState } from "react";
import type { AgentActivityStage } from "@/lib/project/types";

export type AgentActivityProps = {
  stage: AgentActivityStage;
  summary: string;
  /** Wall-clock ms when the current stage began, or null while idle. */
  startedAt: number | null;
};

const STAGE_LABELS: Record<AgentActivityStage, string> = {
  idle: "待命",
  thinking: "思考中",
  reading_files: "读取文件",
  searching_web: "检索资料",
  generating_answer: "生成回复",
  updating_document: "更新文档",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

/**
 * Authoritative stage indicator for the chat UI. Shows a stage label, the
 * human summary, and a live elapsed-time counter that ticks once per second
 * while a stage is active. Stage color is driven by data-stage so the dot can
 * be themed without inline styles.
 */
export function AgentActivity({ stage, summary, startedAt }: AgentActivityProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed =
    startedAt != null ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
  const label = STAGE_LABELS[stage] ?? "处理中";

  return (
    <div className="agent-activity" data-stage={stage} aria-live="polite">
      <span className="agent-activity-dot" aria-hidden="true" />
      <span className="agent-activity-label">{label}</span>
      <span className="agent-activity-summary">
        {summary}
        {elapsed == null ? "" : ` · ${elapsed} 秒`}
      </span>
    </div>
  );
}