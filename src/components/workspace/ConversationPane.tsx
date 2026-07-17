import type { ChatMessage, ChatModelSelection, ContextEstimate, ProjectFile, Provider } from "../../types";
import { Button } from "../ui";
import { ConversationModelMenu } from "./ConversationModelMenu";
import { ConversationFileMenu } from "./ConversationFileMenu";
import { ContextUsageIndicator } from "./ContextUsageIndicator";

export type ConversationPaneProps = {
  nodeAvailable: boolean;
  messages: ChatMessage[];
  activeRunId: string | null;
  sendingMessage: boolean;
  previewingMessageId: string | null;
  messageDraft: string;
  onMessageDraft: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onPreviewAssistant: (messageId: string) => void;
  providers: Provider[];
  files: ProjectFile[];
  selectedFileIds: string[];
  importing: boolean;
  modelSelection: ChatModelSelection | null;
  savingModelSelection: boolean;
  contextEstimate: ContextEstimate | null;
  estimatingContext: boolean;
  contextEstimateError: string | null;
  onModelSelection: (selection: ChatModelSelection) => Promise<void>;
  onToggleFile: (fileId: string) => void;
  onImportFile: () => Promise<ProjectFile | null>;
};

const reasoningLabel: Record<string, string> = { off: "关闭", low: "低", medium: "中", high: "高" };

export function ConversationPane(props: ConversationPaneProps) {
  const {
    nodeAvailable, messages, activeRunId, sendingMessage, previewingMessageId, messageDraft,
    onMessageDraft, onSend, onCancel, onPreviewAssistant,
    providers, files, selectedFileIds, importing, modelSelection, savingModelSelection,
    contextEstimate, estimatingContext, contextEstimateError, onModelSelection, onToggleFile, onImportFile,
  } = props;
  const composerMode = activeRunId ? "stop" : sendingMessage ? "sending" : "send";
  const sendDisabled = !nodeAvailable
    || composerMode === "sending"
    || (composerMode === "send" && !messageDraft.trim())
    || !modelSelection
    || savingModelSelection
    || contextEstimate?.status === "blocked"
    || Boolean(contextEstimateError);

  function submit() {
    if (composerMode === "stop") onCancel();
    else if (!sendDisabled) onSend();
  }

  const selectedFiles = files.filter((file) => selectedFileIds.includes(file.id));

  return (
    <section className="conversation-pane" aria-label="节点对话">
      <div className="conversation-thread">
        {messages.length === 0 ? (
          <div className="conversation-empty">
            <span aria-hidden="true">↗</span>
            <h2>从这里开始完善节点</h2>
            <p>描述你希望补充、分析或调整的内容。消息、回复与交付修改都会保存在当前项目中。</p>
          </div>
        ) : messages.map((message) => {
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
              {message.role === "assistant" && !streaming ? (
                <Button variant="ghost" loading={previewingMessageId === message.id} onClick={() => onPreviewAssistant(message.id)}>预览修改</Button>
              ) : null}
            </article>
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
            <ContextUsageIndicator estimate={contextEstimate} loading={estimatingContext} error={contextEstimateError} />
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
