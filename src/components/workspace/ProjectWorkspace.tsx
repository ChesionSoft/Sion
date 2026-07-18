import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentRun, ChatMessage, ChatModelSelection, ChatSession, ConversationContextSnapshot, ConversationTurn, NodeStatus, ProjectFile, Provider, RecentProject, RightSurface, WorkflowNode } from "../../types";
import { statusLabel } from "../../types";
import { Button, IconButton, Popover, StatusDot, Icon } from "../ui";
import { WORKSPACE_HEADER_ACTIONS } from "../../workspace-config";
import { ConversationHistoryDrawer } from "./ConversationHistoryDrawer";
import { ConversationPane } from "./ConversationPane";
import { RunHistoryList } from "./RunHistoryList";

type ProjectWorkspaceProps = {
  project: RecentProject;
  node: WorkflowNode | null;
  nodeTitle: string;
  sessions: ChatSession[];
  sessionsError: string | null;
  sessionId: string | null;
  runs: AgentRun[];
  runsError: string | null;
  activeRunId: string | null;
  messages: ChatMessage[];
  turns: ConversationTurn[];
  liveReasoningByRun: Record<string, string>;
  markdownDirty: boolean;
  messageDraft: string;
  sendingMessage: boolean;
  rightSurface: RightSurface | null;
  workPane: ReactNode;
  providers: Provider[];
  files: ProjectFile[];
  selectedFileIds: string[];
  importingFile: boolean;
  modelSelection: ChatModelSelection | null;
  savingModelSelection: boolean;
  conversationContext: ConversationContextSnapshot | null;
  loadingConversationContext: boolean;
  conversationContextError: string | null;
  onBack: () => void;
  onRightSurface: (surface: RightSurface) => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onCancelAgent: () => void;
  onRetryDelivery: (turnId: string) => void;
  onOpenRunDetail: (runId: string) => void;
  onMessageDraft: (value: string) => void;
  onSendMessage: () => void;
  onModelSelection: (selection: ChatModelSelection) => Promise<void>;
  onToggleFile: (fileId: string) => void;
  onImportFile: () => Promise<ProjectFile | null>;
};

function statusKind(status: NodeStatus | undefined) {
  if (status === "confirmed") return "success" as const;
  if (status === "needs_confirmation") return "warning" as const;
  return "neutral" as const;
}

function headerActionSurface(id: "delivery" | "agent-rules" | "file-pool"): RightSurface {
  if (id === "delivery") return { kind: "delivery" };
  if (id === "agent-rules") return { kind: "agent-rules" };
  return { kind: "file-pool" };
}

export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setHistoryOpen(false);
  }, [props.node?.id]);

  function closeHistory() {
    setHistoryOpen(false);
    window.requestAnimationFrame(() => historyTriggerRef.current?.focus());
  }

  return (
    <section className="project-workspace">
      <header className="workspace-header">
        <div className="workspace-header-leading">
          <IconButton aria-label="返回项目首页" onClick={props.onBack}><Icon name="back" /></IconButton>
          <div className="workspace-breadcrumb">
            <span>{props.project.name}</span><i aria-hidden="true">/</i><strong>{props.nodeTitle}</strong>
          </div>
          <div className="workspace-node-status"><StatusDot kind={statusKind(props.node?.status)} /><span>{props.node ? statusLabel[props.node.status] : "正在读取"}</span></div>
        </div>
        <div className="workspace-header-actions">
          {WORKSPACE_HEADER_ACTIONS.map((action) => {
            const pressed = props.rightSurface?.kind === action.id;
            return (
              <Button
                key={action.id}
                variant={pressed ? "secondary" : "ghost"}
                aria-label={action.label}
                aria-pressed={pressed}
                title={action.label}
                data-workspace-action={action.id}
                onClick={() => props.onRightSurface(headerActionSurface(action.id))}
              >
                <Icon name={action.icon} />
                <span className="workspace-action-label">{action.label}</span>
              </Button>
            );
          })}
          <Popover label="更多节点操作" trigger={<span aria-hidden="true">•••</span>} align="end">
            <div className="workspace-overflow-menu">
              <section aria-label="运行记录">
                <h3><Icon name="run-history" />运行记录</h3>
                <RunHistoryList runs={props.runs} error={props.runsError} onOpen={props.onOpenRunDetail} />
              </section>
            </div>
          </Popover>
        </div>
      </header>
      <div className="workspace-surface">
        <div className="workspace-conversation">
          <div className="conversation-toolbar">
            <button ref={historyTriggerRef} type="button" className="ui-button ui-button-ghost" aria-label="聊天记录" title="聊天记录" onClick={() => setHistoryOpen(true)}>
              <Icon name="chat-history" />
              <span className="workspace-action-label">聊天记录</span>
            </button>
            <Button variant="secondary" onClick={props.onCreateSession}>＋ 新会话</Button>
          </div>
          <ConversationPane
            nodeAvailable={Boolean(props.node)}
            messages={props.messages}
            turns={props.turns}
            liveReasoningByRun={props.liveReasoningByRun}
            markdownDirty={props.markdownDirty}
            activeRunId={props.activeRunId}
            sendingMessage={props.sendingMessage}
            messageDraft={props.messageDraft}
            onMessageDraft={props.onMessageDraft}
            onSend={props.onSendMessage}
            onCancel={props.onCancelAgent}
            onRetryDelivery={props.onRetryDelivery}
            onOpenRunDetail={props.onOpenRunDetail}
            providers={props.providers}
            files={props.files}
            selectedFileIds={props.selectedFileIds}
            importing={props.importingFile}
            modelSelection={props.modelSelection}
            savingModelSelection={props.savingModelSelection}
            conversationContext={props.conversationContext}
            loadingConversationContext={props.loadingConversationContext}
            conversationContextError={props.conversationContextError}
            onModelSelection={props.onModelSelection}
            onToggleFile={props.onToggleFile}
            onImportFile={props.onImportFile}
          />
          <ConversationHistoryDrawer
            open={historyOpen}
            sessions={props.sessions}
            error={props.sessionsError}
            sessionId={props.sessionId}
            onSelect={props.onSelectSession}
            onCreate={props.onCreateSession}
            onClose={closeHistory}
          />
        </div>
        {props.workPane}
      </div>
    </section>
  );
}
