import { useState, type CSSProperties } from "react";
import type { ConversationTurn, TurnActivityStatus } from "../../types";
import { SionActivityOrb } from "./SionActivityOrb";

const TURN_STATUS_LABEL: Record<ConversationTurn["status"], string> = {
  queued: "Agent 已排队",
  running: "Sion 正在处理",
  completed: "回复已完成",
  failed: "运行失败",
  cancelled: "已取消",
  interrupted: "运行在应用退出前中断",
};

export type ConversationActivityTimelineProps = {
  turn: ConversationTurn;
  onOpenRunDetail: (runId: string) => void;
};

type TimelineMarkerStatus = ConversationTurn["status"] | TurnActivityStatus;

function TimelineMarker({ status }: { status: TimelineMarkerStatus }) {
  if (status === "queued" || status === "running") {
    return (
      <span className="conversation-activity-marker is-active" aria-hidden="true">
        <SionActivityOrb phase={status === "queued" ? "queued" : "delivery"} />
      </span>
    );
  }
  return (
    <span className="conversation-activity-marker" aria-hidden="true">
      {status === "completed" ? (
        <svg viewBox="0 0 16 16" focusable="false">
          <path d="M3.35 8.2 6.55 11.1 12.65 4.95" />
        </svg>
      ) : status === "failed" ? (
        <svg viewBox="0 0 16 16" focusable="false">
          <path d="m4.75 4.75 6.5 6.5m0-6.5-6.5 6.5" />
        </svg>
      ) : status === "skipped" ? (
        <svg viewBox="0 0 16 16" focusable="false">
          <path d="M4.25 8h7.5" />
        </svg>
      ) : null}
    </span>
  );
}

/** One keyboard-accessible timeline combining the run's overall status (a
 * button that opens the full diagnostic dialog) with each execution activity.
 * Markers are shape + text driven so states stay readable without color. */
export function ConversationActivityTimeline({
  turn,
  onOpenRunDetail,
}: ConversationActivityTimelineProps) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const active = turn.status === "queued" || turn.status === "running";
  const hasSteps = turn.activities.length > 0;
  const showSteps = active || stepsOpen;
  return (
    <ol className={`conversation-activity-timeline${showSteps && hasSteps ? " is-steps-open" : ""}`}>
      <li className={`conversation-activity-item is-${turn.status}`}>
        <TimelineMarker status={turn.status} />
        <div className="conversation-activity-content">
          <button
            type="button"
            className="conversation-activity-status"
            onClick={() => onOpenRunDetail(turn.runId)}
            aria-label={`查看运行详情：${TURN_STATUS_LABEL[turn.status]}`}
          >
            <strong>{TURN_STATUS_LABEL[turn.status]}</strong>
            <span className="conversation-turn-status-arrow" aria-hidden="true">›</span>
          </button>
        </div>
      </li>
      {!active && hasSteps ? (
        <li className="conversation-activity-toggle">
          <span className="conversation-activity-toggle-rail" aria-hidden="true" />
          <button
            type="button"
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen((open) => !open)}
          >
            <span>{stepsOpen ? "收起执行步骤" : `${turn.activities.length} 个执行步骤`}</span>
            <svg
              className={stepsOpen ? "is-open" : undefined}
              viewBox="0 0 16 16"
              width="12"
              height="12"
              aria-hidden="true"
            >
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </li>
      ) : null}
      {showSteps ? turn.activities.map((activity, index) => (
        <li
          key={activity.id}
          className={`conversation-activity-item is-${activity.status}`}
          style={{ "--timeline-index": index } as CSSProperties}
        >
          <TimelineMarker status={activity.status} />
          <div className="conversation-activity-content">
            <strong className="conversation-activity-label">{activity.label}</strong>
            {activity.publicSummary ? (
              <p className="conversation-activity-summary">{activity.publicSummary}</p>
            ) : null}
          </div>
        </li>
      )) : null}
    </ol>
  );
}
