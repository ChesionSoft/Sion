import type { ChatMessage, ChatModelSelection, ConversationContextSnapshot, ConversationTurn, ProjectFile, Provider } from "../../types";
import { Button } from "../ui";
import { ConversationModelMenu } from "./ConversationModelMenu";
import { ConversationFileMenu } from "./ConversationFileMenu";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ConversationTurnCard } from "./ConversationTurnCard";
import { conversationCanSend } from "../../conversation-controls";
import { groupConversation } from "../../conversation-turns.ts";

export type ConversationPaneProps = {
  nodeAvailable: boolean;
  messages: ChatMessage[];
  turns: ConversationTurn[];
  activeRunId: string | null;
  sendingMessage: boolean;
  messageDraft: string;
  markdownDirty: boolean;
  onMessageDraft: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onRetryDelivery: (turnId: string) => void;
  providers: Provider[];
  files: ProjectFile[];
  selectedFileIds: string[];
  importing: boolean;
  modelSelection: ChatModelSelection | null;
  savingModelSelection: boolean;
  conversationContext: ConversationContextSnapshot | null;
  loadingConversationContext: boolean;
  conversationContextError: string | null;
  onModelSelection: (selection: ChatModelSelection) => Promise<void>;
  onToggleFile: (fileId: string) => void;
  onImportFile: () => Promise<ProjectFile | null>;
};

const reasoningLabel: Record<string, string> = { off: "关闭", low: "低", medium: "中", high: "高" };

export function ConversationPane(props: ConversationPaneProps) {
  const {
    nodeAvailable, messages, turns, activeRunId, sendingMessage, messageDraft, markdownDirty,
    onMessageDraft, onSend, onCancel, onRetryDelivery,
    providers, files, selectedFileIds, importing, modelSelection, savingModelSelection,
    conversationContext, loadingConversationContext, conversationContextError, onModelSelection, onToggleFile, onImportFile,
  } = props;
  const composerMode = activeRunId ? "stop" : sendingMessage ? "sending" : "send";
  const sendDisabled = composerMode === "stop"
    ? !nodeAvailable
    : composerMode === "sending" || !conversationCanSend({
      nodeAvailable,
      draft: messageDraft,
      selection: modelSelection,
      providers,
      savingSelection: savingModelSelection,
    });

  function submit() {
    if (composerMode === "stop") onCancel();
    else if (!sendDisabled) onSend();
  }

  const selectedFiles = files.filter((file) => selectedFileIds.includes(file.id));
  const items = groupConversation(messages, turns);

  return (
    <section className="conversation-pane" aria-label="节点对话">
      <div className="conversation-thread">
        {items.length === 0 ? (
          <div className="conversation-empty">
            <span aria-hidden="true">↗</span>
            <h2>从这里开始完善节点</h2>
            <p>描述你希望补充、分析或调整的内容。消息、回复与交付修改都会保存在当前项目中。</p>
          </div>
        ) : items.map((item) => {
          if (item.kind === "legacy_message") {
            const message = item.message;
            const streaming = message.id.startsWith("stream-");
            return (
              <article className={`conversation-message is-${message.role} ${streaming ? "is-streaming" : ""}`} key={message.id}>
                <div className="conversation-message-meta"><strong>{message.role === "user" ? "你" : message.role === "assistant" ? "Sion" : "系统"}</strong><time>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div>
                <div className="conversation-message-copy">{message.content}</div>
                {message.role === "user" && message.attachments && message.attachments.length > 0 ? (
                  <div className="conversation-message-attachments">
                    {message.attachments.map((attachment) => <span key={attachment.fileId}>{attachment.originalName}</span>)}
                  </div>
                ) : null}
                {message.role === "assistant" && message.modelExecution ? (
                  <div className="conversation-message-execution">{message.modelExecution.providerId} · {message.modelExecution.model} · 推理：{reasoningLabel[message.modelExecution.reasoningEffort] ?? message.modelExecution.reasoningEffort}</div>
                ) : null}
              </article>
            );
          }
          return (
            <ConversationTurnCard
              key={item.turn.id}
              turn={item.turn}
              userMessage={item.userMessage}
              assistantMessage={item.assistantMessage}
              markdownDirty={markdownDirty}
              onRetryDelivery={onRetryDelivery}
            />
          );
        })}
      </div>
      <form className="conversation-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {selectedFiles.length > 0 ? (
          <div className="conversation-attachment-chips">
            {selectedFiles.map((file) => (
              <button key={file.id} type="button" onClick={() => onToggleFile(file.id)}>{file.originalName}<span aria-hidden="true">×</span></button>
            ))}
          </div>
        ) : null}
        <textarea
          aria-label="发送给当前节点的消息"
          disabled={!nodeAvailable}
          placeholder={nodeAvailable ? "描述你希望在此节点完成的工作…" : "节点尚未加载"}
          value={messageDraft}
          onChange={(event) => onMessageDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="conversation-composer-toolbar">
          <ConversationFileMenu
            files={files}
            selectedFileIds={selectedFileIds}
            disabled={!nodeAvailable || Boolean(activeRunId)}
            importing={importing}
            onToggle={onToggleFile}
            onImport={onImportFile}
          />
          <div className="conversation-composer-actions">
            <ContextUsageIndicator snapshot={conversationContext} loading={loadingConversationContext} error={conversationContextError} />
            <ConversationModelMenu
              providers={providers}
              selection={modelSelection}
              disabled={!nodeAvailable || Boolean(activeRunId)}
              saving={savingModelSelection}
              onSelection={onModelSelection}
            />
            <Button variant={composerMode === "stop" ? "danger" : "primary"} disabled={sendDisabled} loading={composerMode === "sending"} type="submit">
              {composerMode === "stop" ? "停止" : "发送"}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}
