import type { ChatMessage } from "../../types";
import { Button } from "../ui";

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
};

export function ConversationPane({
  nodeAvailable,
  messages,
  activeRunId,
  sendingMessage,
  previewingMessageId,
  messageDraft,
  onMessageDraft,
  onSend,
  onCancel,
  onPreviewAssistant,
}: ConversationPaneProps) {
  const composerMode = activeRunId ? "stop" : sendingMessage ? "sending" : "send";
  const sendDisabled = !nodeAvailable || composerMode === "sending" || (composerMode === "send" && !messageDraft.trim());

  function submit() {
    if (composerMode === "stop") onCancel();
    else if (!sendDisabled) onSend();
  }

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
              {message.role === "assistant" && !streaming ? (
                <Button variant="ghost" loading={previewingMessageId === message.id} onClick={() => onPreviewAssistant(message.id)}>预览修改</Button>
              ) : null}
            </article>
          );
        })}
      </div>
      <form className="conversation-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
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
          <span>{activeRunId ? "Agent 正在运行，可随时停止" : "Enter 发送 · Shift+Enter 换行"}</span>
          <Button variant={composerMode === "stop" ? "danger" : "primary"} disabled={sendDisabled} loading={composerMode === "sending"} type="submit">
            {composerMode === "stop" ? "停止" : "发送"}
          </Button>
        </div>
      </form>
    </section>
  );
}
