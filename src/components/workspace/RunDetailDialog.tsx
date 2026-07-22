import type { AgentRun, AgentRunDetail, DeliveryOutcome, TurnActivity } from "../../types";
import { Button, Dialog, StatusDot } from "../ui";

const LEGACY_MISSING = "历史记录未保存此信息";

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

const CONTEXT_STATUS_LABEL = { ready: "正常", warning: "接近上限", blocked: "超过上限" } as const;
const USAGE_SOURCE_LABEL = { exact: "精确", estimated: "估算", mixed: "混合" } as const;
const CALL_CATEGORY_LABEL = { answer: "回复", tool_planning: "工具规划", document_update: "文稿更新", other: "其他" } as const;
const CALL_STATUS_LABEL = { completed: "已完成", interrupted: "已中断", failed: "失败" } as const;

function statusKind(status: AgentRun["status"]) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "error" as const;
  if (status === "running" || status === "queued") return "running" as const;
  return "neutral" as const;
}

function formatTime(value?: string) {
  if (!value) return LEGACY_MISSING;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function formatDuration(value?: number) {
  if (value === undefined) return LEGACY_MISSING;
  if (value < 1_000) return `${value} 毫秒`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}

function activityStatus(activity: TurnActivity) {
  const labels: Record<TurnActivity["status"], string> = {
    pending: "待处理",
    running: "进行中",
    completed: "已完成",
    failed: "失败",
    skipped: "已跳过",
  };
  return labels[activity.status];
}

function deliveryLabel(outcome?: DeliveryOutcome) {
  if (!outcome) return LEGACY_MISSING;
  switch (outcome.kind) {
    case "pending": return "等待交付判断";
    case "unchanged": return "未修改交付稿";
    case "patch_applied": return `已保存 revision ${outcome.revision}（${outcome.sectionTitles.join("、") || "未记录章节"}）`;
    case "awaiting_manual_draft_resolution": return `等待处理未保存草稿（revision ${outcome.expectedRevision}）`;
    case "conflict": return `版本冲突：预期 ${outcome.expectedRevision}，实际 ${outcome.actualRevision}`;
    case "failed": return `${outcome.stage} 阶段失败：${outcome.publicError}`;
    case "cancelled": return "已取消";
  }
}

function DetailField({ label, value }: { label: string; value?: string | number | null }) {
  const missing = value === undefined || value === null || value === "";
  return (
    <div className="run-detail-field">
      <dt>{label}</dt>
      <dd className={missing ? "is-missing" : undefined}>{missing ? LEGACY_MISSING : value}</dd>
    </div>
  );
}

export function RunDetailDialog({ open, detail, loading, error, onClose, onRetry }: {
  open: boolean;
  detail: AgentRunDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const run = detail?.run;
  const turn = detail?.turn;
  const context = run?.contextSnapshot;
  const usage = run?.usage;

  return (
    <Dialog open={open} title="运行详情" description="查看本次运行保存的上下文、用量和交付结果。" size="medium" closeLabel="关闭运行详情" onClose={onClose}>
      {loading ? (
        <div className="run-detail-loading" aria-busy="true" aria-label="正在读取运行详情">
          <span /><span /><span /><span />
        </div>
      ) : error ? (
        <div className="run-detail-error">
          <p role="alert">{error}</p>
          <Button onClick={onRetry}>重试</Button>
        </div>
      ) : run ? (
        <div className="run-detail">
          <header className="run-detail-summary">
            <StatusDot kind={statusKind(run.status)} />
            <div>
              <strong>{RUN_KIND_LABEL[run.kind]} · {RUN_STATUS_LABEL[run.status]}</strong>
              <p>{run.summary || LEGACY_MISSING}</p>
            </div>
          </header>

          <section>
            <h3>运行信息</h3>
            <dl className="run-detail-grid">
              <DetailField label="开始时间" value={formatTime(run.startedAt)} />
              <DetailField label="完成时间" value={formatTime(run.finishedAt)} />
              <DetailField label="耗时" value={formatDuration(run.durationMs)} />
              <DetailField label="会话" value={run.sessionId} />
              <DetailField label="提供商" value={run.providerId} />
              <DetailField label="模型" value={run.model} />
              <DetailField label="推理强度" value={run.reasoningEffort} />
              <DetailField label="本轮资料" value={run.fileIds?.length ? run.fileIds.join("、") : undefined} />
            </dl>
          </section>

          <section>
            <h3>上下文与用量</h3>
            <dl className="run-detail-grid">
              <DetailField label="当前上下文" value={context ? `${context.estimatedInputTokens.toLocaleString()} / ${context.contextWindowTokens.toLocaleString()} tokens` : undefined} />
              <DetailField label="上下文占用" value={context ? `${Math.round(context.ratio * 100)}% · ${CONTEXT_STATUS_LABEL[context.status]}` : undefined} />
              <DetailField label="协议提示" value={context?.breakdown.protocolTokens} />
              <DetailField label="Agent 规则" value={context?.breakdown.rulesTokens} />
              <DetailField label="依赖节点交付稿" value={context?.breakdown.dependencyNodeTokens} />
              <DetailField label="节点文稿" value={context?.breakdown.nodeMarkdownTokens} />
              <DetailField label="会话历史" value={context?.breakdown.conversationTokens} />
              <DetailField label="本轮资料" value={context?.breakdown.attachmentTokens} />
              <DetailField label="本轮输入" value={usage?.inputTokens} />
              <DetailField label="本轮输出" value={usage?.outputTokens} />
              <DetailField label="模型调用" value={usage?.callCount} />
              <DetailField label="统计来源" value={usage ? USAGE_SOURCE_LABEL[usage.source] : undefined} />
              <DetailField label="会话累计输入" value={context?.cumulativeUsage.inputTokens} />
              <DetailField label="会话累计输出" value={context?.cumulativeUsage.outputTokens} />
              <DetailField label="会话累计总量" value={context?.cumulativeUsage.totalTokens} />
              <DetailField label="会话累计调用" value={context?.cumulativeUsage.callCount} />
            </dl>
          </section>

          {usage?.calls.length ? (
            <section>
              <h3>模型调用明细</h3>
              <ol className="run-detail-calls">
                {usage.calls.map((call) => (
                  <li key={call.id}>
                    <strong>{call.providerId} · {call.model}</strong>
                    <span>{CALL_CATEGORY_LABEL[call.category]} · {CALL_STATUS_LABEL[call.status]} · {USAGE_SOURCE_LABEL[call.source]}</span>
                    <small>输入 {call.inputTokens.toLocaleString()} · 输出 {call.outputTokens.toLocaleString()} · 总计 {call.totalTokens.toLocaleString()} tokens</small>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section>
            <h3>活动时间线</h3>
            {turn?.activities.length ? (
              <ol className="run-detail-timeline">
                {turn.activities.map((activity) => (
                  <li key={activity.id} className={`is-${activity.status}`}>
                    <span aria-hidden="true" />
                    <div>
                      <strong>{activity.label}</strong>
                      <small>{activityStatus(activity)} · {formatTime(activity.startedAt)}{activity.finishedAt ? ` → ${formatTime(activity.finishedAt)}` : ""}</small>
                      {activity.publicSummary ? <p>{activity.publicSummary}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="run-detail-missing">{LEGACY_MISSING}</p>}
          </section>

          <section>
            <h3>交付结果</h3>
            <p className="run-detail-delivery">{deliveryLabel(turn?.deliveryOutcome)}</p>
          </section>
        </div>
      ) : (
        <p className="run-detail-missing">{LEGACY_MISSING}</p>
      )}
    </Dialog>
  );
}
