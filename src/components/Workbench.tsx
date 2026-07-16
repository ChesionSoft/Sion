import { FilePreviewPane } from "./FilePreviewPane";
import { NODES, statusLabel, type AgentRun, type AssistantDeliveryPreview, type ChatMessage, type ChatSession, type FilePreview, type NodeId, type ProjectFile, type RecentProject, type WorkflowNode, type WorkbenchTab } from "../types";

// Task 7: the workbench is recomposed around a central chat/draft pane with a
// right-side file preview. The node rail no longer holds the file pool; files
// live in the right pane, where selecting one loads bounded extracted text.
type WorkbenchProps = {
  project: RecentProject;
  node: WorkflowNode | null;
  nodeTitle: string;
  draft: string;
  setDraft: (value: string) => void;
  dirty: boolean;
  saving: boolean;
  exporting: boolean;
  onExit: () => void;
  onSave: () => void;
  onExportDocx: () => void;
  onSelectNode: (nodeId: NodeId) => void;
  tab: WorkbenchTab;
  onSelectTab: (tab: WorkbenchTab) => void;
  files: ProjectFile[];
  selectedFileIds: string[];
  importingFile: boolean;
  onImport: () => void;
  onToggleFile: (fileId: string) => void;
  preview: FilePreview | null;
  onSelectPreview: (fileId: string) => void;
  isFileDrawerOpen: boolean;
  onToggleFileDrawer: () => void;
  agentOverride: string | null;
  agentOverrideOpen: boolean;
  agentOverrideDraft: string;
  setAgentOverrideDraft: (value: string) => void;
  openAgentOverride: () => void;
  closeAgentOverride: () => void;
  savingAgentOverride: boolean;
  saveAgentOverride: () => void;
  sessions: ChatSession[];
  sessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  runs: AgentRun[];
  activeRunId: string | null;
  onCancelAgent: () => void;
  messages: ChatMessage[];
  previewingMessageId: string | null;
  onPreviewAssistant: (messageId: string) => void;
  messageDraft: string;
  setMessageDraft: (value: string) => void;
  onSendMessage: () => void;
  sendingMessage: boolean;
  notice: string;
  deliveryPreview: AssistantDeliveryPreview | null;
  onCloseDeliveryPreview: () => void;
  onApplyAssistant: (messageId: string) => void;
};

export function Workbench(props: WorkbenchProps) {
  const {
    project, node, nodeTitle, draft, setDraft, dirty, saving, exporting,
    onExit, onSave, onExportDocx, onSelectNode, tab, onSelectTab,
    files, selectedFileIds, importingFile, onImport, onToggleFile,
    preview, onSelectPreview, isFileDrawerOpen, onToggleFileDrawer,
    agentOverride, agentOverrideOpen, agentOverrideDraft, setAgentOverrideDraft,
    openAgentOverride, closeAgentOverride, savingAgentOverride, saveAgentOverride,
    sessions, sessionId, onSelectSession, onCreateSession, runs, activeRunId, onCancelAgent,
    messages, previewingMessageId, onPreviewAssistant, messageDraft, setMessageDraft,
    onSendMessage, sendingMessage, notice, deliveryPreview, onCloseDeliveryPreview, onApplyAssistant,
  } = props;
  const nodeId = node?.id ?? "basic-info";

  return (
    <main className="desk-shell workbench-shell">
      <header className="workbench-bar"><button className="wordmark" onClick={onExit} type="button">SION<span>DESKTOP</span></button><div className="project-heading"><span>项目 / {project.name}</span><strong>{nodeTitle}</strong></div><div className="save-state"><span className={dirty ? "dirty-dot" : "clean-dot"} />{dirty ? "有未保存修改" : "已同步本地磁盘"}</div></header>
      <div className="workbench-grid">
        <aside className="node-rail"><div className="rail-title"><span>设计路径</span><b>12</b></div>{NODES.map(([id, title], index) => <button className={id === nodeId ? "node-item selected" : "node-item"} key={id} onClick={() => onSelectNode(id)} type="button"><span>{String(index + 1).padStart(2, "0")}</span><strong>{title}</strong><i>{id === nodeId ? "●" : ""}</i></button>)}</aside>
        <section className="main-pane">
          <header className="main-pane-head">
            <div className="workbench-tabs">
              <button aria-pressed={tab === "chat"} onClick={() => onSelectTab("chat")} type="button">对话</button>
              <button aria-pressed={tab === "draft"} onClick={() => onSelectTab("draft")} type="button">交付稿</button>
            </div>
            <div className="node-actions">
              <span>{nodeTitle} · {node ? statusLabel[node.status] : "读取中"}</span>
              <button disabled={!dirty || saving} onClick={onSave} type="button">{saving ? "保存中" : "保存"} <b>⌘/Ctrl S</b></button>
              <button disabled={exporting} onClick={onExportDocx} type="button">{exporting ? "导出中" : "导出 DOCX"}</button>
              <button onClick={onToggleFileDrawer} type="button">资料</button>
            </div>
          </header>
          {tab === "chat" ? (
            <div className="chat-pane">
              <div className="run-heading"><p className="panel-kicker">节点会话</p><span>{activeRunId ? <button className="cancel-run" onClick={onCancelAgent} type="button">取消运行</button> : <button className="new-session" onClick={onCreateSession} type="button">+ 新建</button>}</span></div>
              <div className="session-list">{sessions.length === 0 ? <p className="session-empty">这个节点还没有会话。可直接输入消息，Sion 会先建立本地会话。</p> : sessions.map((session) => <button className={session.id === sessionId ? "session-row active" : "session-row"} key={session.id} onClick={() => onSelectSession(session.id)} type="button"><strong>{session.name}</strong><span>{session.messageCount} 条消息</span></button>)}</div>
              <div className="task-center"><p>任务中心 / {runs.length}</p>{runs.length === 0 ? <span>暂无运行记录</span> : runs.slice(0, 3).map((run) => <div key={run.id}><i className={`run-${run.status}`} /> <strong>{run.nodeId === nodeId ? "当前节点" : run.nodeId}</strong><small>{run.status === "running" ? "运行中" : run.status === "queued" ? "排队中" : run.status === "completed" ? "已完成" : run.status === "cancelled" ? "已取消" : "失败"}</small></div>)}</div>
              <div className="message-thread">{messages.length === 0 ? <div className="thread-empty"><div className="orbit-mark">↗</div><p>消息会保存在项目 `.sion/chat/`。Agent 只基于当前节点、已选择附件和会话工作。</p></div> : messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span>{message.role === "user" ? "你" : message.role === "assistant" ? "助手" : "系统"}</span><p>{message.content}</p>{message.role === "assistant" && !message.id.startsWith("stream-") ? <button className="apply-reply" disabled={previewingMessageId === message.id} onClick={() => onPreviewAssistant(message.id)} type="button">{previewingMessageId === message.id ? "解析中" : "预览修改"}</button> : null}</article>)}</div>
              <form className="message-form" onSubmit={(event) => { event.preventDefault(); onSendMessage(); }}><textarea aria-label="发送给此节点的消息" onChange={(event) => setMessageDraft(event.target.value)} placeholder="描述你希望在此节点完成的工作…" value={messageDraft} /><button disabled={!messageDraft.trim() || sendingMessage || Boolean(activeRunId)} type="submit">{sendingMessage ? "发送中" : activeRunId ? "Agent 运行中" : "发送并运行"}<b>↗</b></button></form>
              <div className="run-notice">{notice}</div>
            </div>
          ) : (
            <div className="draft-pane">
              <div className="editor-head"><div><p className="panel-kicker">NODE / {nodeId.toUpperCase()}</p><h1>{nodeTitle}</h1></div><div className="editor-actions"><button className={agentOverride ? "override-control active" : "override-control"} onClick={openAgentOverride} type="button">{agentOverride ? "自定义规则 · 已启用" : "自定义规则"}</button><span className={`node-status status-${node?.status ?? "not_started"}`}>{node ? statusLabel[node.status] : "读取中"}</span></div></div>
              <textarea aria-label={`${nodeTitle} Markdown 编辑器`} disabled={!node} onChange={(event) => setDraft(event.target.value)} spellCheck={false} value={draft} />
              <div className="editor-foot"><span>Markdown · revision {node?.revision ?? "-"}</span><span>{draft.length.toLocaleString()} 字符</span></div>
            </div>
          )}
        </section>
        <FilePreviewPane files={files} selectedFileIds={selectedFileIds} preview={preview} importing={importingFile} isFileDrawerOpen={isFileDrawerOpen} onImport={onImport} onSelectPreview={onSelectPreview} onToggleContext={onToggleFile} />
      </div>
      {agentOverrideOpen ? <section className="override-dialog" role="dialog" aria-modal="true" aria-label="节点自定义规则"><div className="override-card"><div className="override-head"><div><p className="panel-kicker">节点自定义规则</p><h2>{nodeTitle}</h2><span>这段规则会追加到内置规则之后；留空并保存即可恢复默认规则。</span></div><button onClick={closeAgentOverride} type="button" aria-label="关闭自定义规则">×</button></div><textarea aria-label={`${nodeTitle} 自定义规则`} onChange={(event) => setAgentOverrideDraft(event.target.value)} placeholder="例如：仅使用已经确认的事实；不推断预算或日期。" value={agentOverrideDraft} /><div className="override-footer"><span>{agentOverrideDraft.trim() ? "将作为附加约束传给本节点 Agent" : "当前没有附加规则"}</span><div><button onClick={closeAgentOverride} type="button">取消</button><button disabled={savingAgentOverride} onClick={saveAgentOverride} type="button">{savingAgentOverride ? "保存中…" : agentOverrideDraft.trim() ? "保存规则" : "清除规则"}</button></div></div></div></section> : null}
      {deliveryPreview ? <section className="delivery-preview" role="dialog" aria-modal="true" aria-label="Assistant 修改预览"><div className="delivery-preview-card"><div className="delivery-preview-head"><div><p className="panel-kicker">修改预览</p><span>以下为应用分节交付后的完整节点</span></div><button onClick={onCloseDeliveryPreview} type="button" aria-label="关闭修改预览">×</button></div><div className="delivery-stats"><span><strong>+{deliveryPreview.additions}</strong> 新增</span><span><strong>-{deliveryPreview.deletions}</strong> 删除</span><span><strong>{deliveryPreview.unchanged}</strong> 保留</span><span><strong>r{deliveryPreview.currentRevision}</strong> 基线</span></div><pre>{deliveryPreview.markdown}</pre><div className="delivery-actions"><button onClick={onCloseDeliveryPreview} type="button">取消</button><button onClick={() => onApplyAssistant(deliveryPreview.assistantMessageId)} type="button">确认应用修改</button></div></div></section> : null}
    </main>
  );
}
