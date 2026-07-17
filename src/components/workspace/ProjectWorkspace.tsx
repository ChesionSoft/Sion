import type { AgentRun, AssistantDeliveryPreview, ChatMessage, ChatSession, NodeStatus, RecentProject, WorkflowNode } from "../../types";
import { statusLabel } from "../../types";
import { Button, Dialog, IconButton, Popover, StatusDot } from "../ui";
import { ConversationPane } from "./ConversationPane";

type ProjectWorkspaceProps = {
  project: RecentProject;
  node: WorkflowNode | null;
  nodeTitle: string;
  sessions: ChatSession[];
  sessionId: string | null;
  runs: AgentRun[];
  activeRunId: string | null;
  messages: ChatMessage[];
  previewingMessageId: string | null;
  messageDraft: string;
  sendingMessage: boolean;
  agentOverride: string | null;
  agentOverrideOpen: boolean;
  agentOverrideDraft: string;
  savingAgentOverride: boolean;
  deliveryPreview: AssistantDeliveryPreview | null;
  onBack: () => void;
  onOpenMaterials: () => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onCancelAgent: () => void;
  onPreviewAssistant: (messageId: string) => void;
  onMessageDraft: (value: string) => void;
  onSendMessage: () => void;
  onOpenAgentOverride: () => void;
  onCloseAgentOverride: () => void;
  onAgentOverrideDraft: (value: string) => void;
  onSaveAgentOverride: () => void;
  onCloseDeliveryPreview: () => void;
  onApplyAssistant: (messageId: string) => void;
};

const runLabel: Record<AgentRun["status"], string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function statusKind(status: NodeStatus | undefined) {
  if (status === "confirmed") return "success" as const;
  if (status === "needs_confirmation") return "warning" as const;
  return "neutral" as const;
}

export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  const activeSession = props.sessions.find((session) => session.id === props.sessionId) ?? null;

  return (
    <section className="project-workspace">
      <header className="workspace-header">
        <div className="workspace-header-leading">
          <IconButton aria-label="返回项目首页" onClick={props.onBack}>←</IconButton>
          <div className="workspace-breadcrumb">
            <span>{props.project.name}</span><i aria-hidden="true">/</i><strong>{props.nodeTitle}</strong>
          </div>
          <div className="workspace-node-status"><StatusDot kind={statusKind(props.node?.status)} /><span>{props.node ? statusLabel[props.node.status] : "正在读取"}</span></div>
        </div>
        <div className="workspace-header-actions">
          <Button variant="ghost" onClick={props.onOpenMaterials}>资料</Button>
          <Popover label="选择会话" trigger={<span>{activeSession?.name ?? "新会话"}⌄</span>} align="end">
            <div className="workspace-popover-list">
              <Button variant="ghost" onClick={props.onCreateSession}>＋ 新建会话</Button>
              {props.sessions.length === 0 ? <p>当前节点还没有会话。</p> : props.sessions.map((session) => (
                <button className={session.id === props.sessionId ? "is-active" : ""} key={session.id} onClick={() => props.onSelectSession(session.id)} type="button">
                  <span><strong>{session.name}</strong><small>{session.messageCount} 条消息</small></span>
                  {session.id === props.sessionId ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          </Popover>
          <Popover label="查看 Agent 运行" trigger={<span>{props.activeRunId ? "运行中" : `运行 ${props.runs.length}`}⌄</span>} align="end">
            <div className="workspace-popover-list run-list">
              {props.runs.length === 0 ? <p>还没有运行记录。</p> : props.runs.slice(0, 8).map((run) => (
                <div key={run.id}><StatusDot kind={run.status === "completed" ? "success" : run.status === "failed" ? "error" : run.status === "running" || run.status === "queued" ? "running" : "neutral"} /><span><strong>{run.nodeId}</strong><small>{runLabel[run.status]}</small></span></div>
              ))}
              {props.activeRunId ? <Button variant="danger" onClick={props.onCancelAgent}>停止当前运行</Button> : null}
            </div>
          </Popover>
          <Popover label="更多节点操作" trigger={<span aria-hidden="true">•••</span>} align="end">
            <div className="workspace-overflow-menu">
              <button onClick={props.onOpenAgentOverride} type="button">{props.agentOverride ? "编辑节点自定义规则" : "添加节点自定义规则"}</button>
            </div>
          </Popover>
        </div>
      </header>
      <div className="workspace-surface">
        <div className="workspace-conversation">
          <ConversationPane
            nodeAvailable={Boolean(props.node)}
            messages={props.messages}
            activeRunId={props.activeRunId}
            sendingMessage={props.sendingMessage}
            previewingMessageId={props.previewingMessageId}
            messageDraft={props.messageDraft}
            onMessageDraft={props.onMessageDraft}
            onSend={props.onSendMessage}
            onCancel={props.onCancelAgent}
            onPreviewAssistant={props.onPreviewAssistant}
          />
        </div>
      </div>
      <Dialog open={props.agentOverrideOpen} title="节点自定义规则" description="规则会追加在内置节点规则之后；留空保存可恢复默认。" size="large" closeLabel="关闭节点规则" onClose={props.onCloseAgentOverride} footer={<><Button variant="ghost" onClick={props.onCloseAgentOverride}>取消</Button><Button variant="primary" loading={props.savingAgentOverride} onClick={props.onSaveAgentOverride}>{props.agentOverrideDraft.trim() ? "保存规则" : "清除规则"}</Button></>}>
        <textarea className="workspace-rule-editor" aria-label={`${props.nodeTitle} 自定义规则`} value={props.agentOverrideDraft} onChange={(event) => props.onAgentOverrideDraft(event.target.value)} placeholder="例如：只使用已确认事实，不推断预算或日期。" />
      </Dialog>
      <Dialog open={Boolean(props.deliveryPreview)} title="Assistant 修改预览" description={props.deliveryPreview ? `基于 revision ${props.deliveryPreview.currentRevision}` : undefined} size="large" closeLabel="关闭修改预览" onClose={props.onCloseDeliveryPreview} footer={props.deliveryPreview ? <><Button variant="ghost" onClick={props.onCloseDeliveryPreview}>取消</Button><Button variant="primary" onClick={() => props.onApplyAssistant(props.deliveryPreview!.assistantMessageId)}>确认应用修改</Button></> : undefined}>
        {props.deliveryPreview ? <div className="workspace-delivery-preview"><div><span><strong>+{props.deliveryPreview.additions}</strong> 新增</span><span><strong>-{props.deliveryPreview.deletions}</strong> 删除</span><span><strong>{props.deliveryPreview.unchanged}</strong> 保留</span></div><pre>{props.deliveryPreview.markdown}</pre></div> : null}
      </Dialog>
    </section>
  );
}
