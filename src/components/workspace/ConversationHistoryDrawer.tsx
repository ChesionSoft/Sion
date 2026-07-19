import { useEffect, useRef, useState } from "react";
import type { ChatSession } from "../../types";
import { Button, Dialog, Icon } from "../ui";

type ConversationHistoryDrawerProps = {
  open: boolean;
  sessions: ChatSession[];
  error: string | null;
  sessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onDelete: (sessionId: string) => Promise<void>;
  onClose: () => void;
};

export function ConversationHistoryDrawer({ open, sessions, error, sessionId, onSelect, onCreate, onDelete, onClose }: ConversationHistoryDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await onDelete(pendingDelete.id);
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
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
                <div className="conversation-history-row" key={session.id}>
                  <button
                    className={`conversation-history-row-main${session.id === sessionId ? " is-active" : ""}`}
                    onClick={() => choose(session.id)}
                    type="button"
                  >
                    <span><strong>{session.name}</strong><small>{session.messageCount} 条消息</small></span>
                    {session.id === sessionId ? <span aria-hidden="true">✓</span> : null}
                  </button>
                  <button
                    className="conversation-history-row-delete"
                    type="button"
                    aria-label={`删除会话 ${session.name}`}
                    title="删除会话"
                    onClick={(event) => { event.stopPropagation(); setPendingDelete(session); }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={Boolean(pendingDelete)}
        title="删除会话？"
        description={pendingDelete ? `将删除「${pendingDelete.name}」及其全部消息，且无法恢复。` : undefined}
        size="confirm"
        closeLabel="关闭删除确认"
        onClose={() => setPendingDelete(null)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>取消</Button>
            <Button variant="danger" loading={deleting} onClick={() => void confirmDelete()}>删除</Button>
          </>
        )}
      >
        <p className="confirm-copy">删除后该会话记录将从本节点移除，不影响已保存的交付稿。</p>
      </Dialog>
    </div>
  );
}
