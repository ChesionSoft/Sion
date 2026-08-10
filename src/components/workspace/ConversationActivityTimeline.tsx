import type { ConversationTurn } from "../../types";

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

/** One keyboard-accessible timeline combining the run's overall status (a
 * button that opens the full diagnostic dialog) with each execution activity.
 * Markers are shape + text driven so states stay readable without color. */
export function ConversationActivityTimeline({
  turn,
  onOpenRunDetail,
}: ConversationActivityTimelineProps) {
  return (
    <ol className="conversation-activity-timeline">
      <li className={`conversation-activity-item is-${turn.status}`}>
        <span className="conversation-activity-marker" aria-hidden="true" />
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
      {turn.activities.map((activity) => (
        <li key={activity.id} className={`conversation-activity-item is-${activity.status}`}>
          <span className="conversation-activity-marker" aria-hidden="true" />
          <div className="conversation-activity-content">
            <strong className="conversation-activity-label">{activity.label}</strong>
            {activity.publicSummary ? (
              <p className="conversation-activity-summary">{activity.publicSummary}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
