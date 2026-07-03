"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { stripToolCallLeakage } from "@/lib/project/tool-call-strip";
import type { AgentActivityStage } from "@/lib/project/types";

export type AgentActivityProps = {
  stage: AgentActivityStage;
  summary: string;
  /** Wall-clock ms when the current stage began, or null while idle. */
  startedAt: number | null;
  /** Live reasoning text for the streaming turn, if any. When non-empty and
   * the stage is active, a folded "思考过程" panel is shown beneath the status
   * row so a reasoning model's thinking is visible (and clearly progressing)
   * instead of looking like a hung turn. */
  reasoning?: string;
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

/** Stages during which the live reasoning panel may be shown. */
const REASONING_STAGES: ReadonlySet<AgentActivityStage> = new Set([
  "thinking",
  "reading_files",
  "searching_web",
  "generating_answer",
  "updating_document",
]);

/**
 * Authoritative stage indicator for the chat UI. Shows a stage label, the
 * human summary, and a live elapsed-time counter that ticks once per second
 * while a stage is active. Stage color is driven by data-stage so the dot can
 * be themed without inline styles. When `reasoning` is supplied during an
 * active stage, a folded panel beneath the status row surfaces the model's
 * thinking live (with a growing character count) so a long reasoning phase is
 * not mistaken for a hung turn.
 */
export function AgentActivity({ stage, summary, startedAt, reasoning }: AgentActivityProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed =
    startedAt != null ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
  const label = STAGE_LABELS[stage] ?? "处理中";
  const displayReasoning = reasoning ? stripToolCallLeakage(reasoning) : "";
  const showReasoning = displayReasoning.length > 0 && REASONING_STAGES.has(stage);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="agent-activity" data-stage={stage} aria-live="polite">
        <span className="agent-activity-dot" aria-hidden="true" />
        <Badge variant="secondary" className="agent-activity-badge">{label}</Badge>
        <span className="agent-activity-summary">
          {summary}
          {elapsed == null ? "" : ` · ${elapsed} 秒`}
        </span>
      </div>
      {showReasoning ? (
        <details className="agent-reasoning group rounded-md border bg-muted/40 px-2 py-1.5" open={false}>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="agent-reasoning-dot inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            思考过程 · {displayReasoning.length} 字
          </summary>
          <div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {displayReasoning}
          </div>
        </details>
      ) : null}
    </div>
  );
}
