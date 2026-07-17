import { useEffect, useRef } from "react";
import type { ChatSession } from "../../types";
import { Button, Icon } from "../ui";

type ConversationHistoryDrawerProps = {
  open: boolean;
  sessions: ChatSession[];
  error: string | null;
  sessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onClose: () => void;
};

export function ConversationHistoryDrawer({ open, sessions, error, sessionId, onSelect, onCreate, onClose }: ConversationHistoryDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  function choose(nextSessionId: string) {
    onSelect(nextSessionId);
    onClose();
  }

  return (
    <div className="conversation-history-backdrop" onClick={onClose}>
      <div
        className="conversation-history-drawer"
        role="dialog"
        aria-modal="false"
        aria-label="聊天记录"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
      >
        <header className="conversation-history-header">
          <h3>聊天记录</h3>
          <button ref={closeRef} type="button" className="ui-icon-button" aria-label="关闭聊天记录" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="conversation-history-body">
          <Button variant="secondary" onClick={() => { onCreate(); onClose(); }}>＋ 新建会话</Button>
          {error ? <p role="alert">{error}</p> : sessions.length === 0 ? <p>当前节点还没有聊天记录。</p> : (
            <div className="conversation-history-list">
              {sessions.map((session) => (
                <button
                  className={session.id === sessionId ? "is-active" : ""}
                  key={session.id}
                  onClick={() => choose(session.id)}
                  type="button"
                >
                  <span><strong>{session.name}</strong><small>{session.messageCount} 条消息</small></span>
                  {session.id === sessionId ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
