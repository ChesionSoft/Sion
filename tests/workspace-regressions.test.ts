import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("compact workspace keeps every primary action available and labelled", async () => {
  const [workspaceCss, workspaceSource] = await Promise.all([
    readFile("src/styles/workspace.css", "utf8"),
    readFile("src/components/workspace/ProjectWorkspace.tsx", "utf8"),
  ]);
  assert.doesNotMatch(
    workspaceCss,
    /\.workspace-header-actions\s*>\s*\.ui-button:first-child\s*\{[^}]*display:\s*none/,
  );
  assert.match(workspaceSource, /aria-label=\{action\.label\}/);
  assert.match(workspaceSource, /title=\{action\.label\}/);
  assert.match(workspaceSource, /aria-label="聊天记录"/);
  assert.match(workspaceSource, /title="聊天记录"/);
});

test("macOS titlebar is covered by the existing workspace chrome", async () => {
  const [tauriConfig, capabilities, shellCss, workspaceCss, appShell] = await Promise.all([
    readFile("src-tauri/tauri.conf.json", "utf8"),
    readFile("src-tauri/capabilities/default.json", "utf8"),
    readFile("src/styles/shell.css", "utf8"),
    readFile("src/styles/workspace.css", "utf8"),
    readFile("src/components/app/AppShell.tsx", "utf8"),
  ]);
  assert.match(tauriConfig, /"titleBarStyle":\s*"Overlay"/);
  assert.match(tauriConfig, /"hiddenTitle":\s*true/);
  assert.match(capabilities, /"core:window:allow-start-dragging"/);
  assert.match(capabilities, /"core:window:allow-toggle-maximize"/);
  assert.match(shellCss, /\.sidebar-titlebar\s*\{[^}]*padding:\s*42px 8px 7px 14px/s);
  assert.match(shellCss, /\.sidebar-titlebar\s*\{[^}]*cursor:\s*default/s);
  assert.match(shellCss, /\.collapsed-shell-actions\s*\{[^}]*top:\s*42px/s);
  assert.match(workspaceCss, /\.workspace-header\s*\{[^}]*flex:\s*0 0 48px/s);
  assert.match(workspaceCss, /\.workspace-header\s*\{[^}]*cursor:\s*default/s);
  assert.doesNotMatch(shellCss, /\.app-main::before/);
  assert.match(appShell, /getCurrentWindow\(\)\.startDragging\(\)/);
  assert.match(appShell, /getCurrentWindow\(\)\.toggleMaximize\(\)/);
  assert.match(appShell, /function startWindowDragging[\s\S]*event\.preventDefault\(\)[\s\S]*startDragging\(\)/);
  assert.match(appShell, /function toggleWindowMaximize[\s\S]*event\.preventDefault\(\)[\s\S]*toggleMaximize\(\)/);
  assert.match(appShell, /onMouseDown=\{startWindowDragging\}/);
  assert.match(appShell, /onDoubleClick=\{toggleWindowMaximize\}/);
  assert.match(appShell, /const TITLEBAR_GESTURE_HEIGHT = 56/);
  assert.match(appShell, /event\.clientY - bounds\.top >= TITLEBAR_GESTURE_HEIGHT/);
  assert.match(appShell, /closest\("button, input, textarea, select, a, \[role=\\"button\\"\]"\)/);
});

test("shared Markdown renderer centralizes safe GFM for every visual variant", async () => {
  const [safeMarkdown, preview] = await Promise.all([
    readFile("src/components/workspace/SafeMarkdown.tsx", "utf8"),
    readFile("src/components/workspace/MarkdownPreview.tsx", "utf8"),
  ]);

  assert.match(safeMarkdown, /type SafeMarkdownVariant = "document" \| "chat" \| "reasoning"/);
  assert.match(safeMarkdown, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(safeMarkdown, /urlTransform=\{blockedMarkdownUrl\}/);
  assert.match(safeMarkdown, /className="safe-markdown-table-scroll"/);
  assert.match(safeMarkdown, /className="safe-markdown-code-scroll"/);
  assert.match(safeMarkdown, /MarkdownErrorBoundary/);
  assert.match(safeMarkdown, /static getDerivedStateFromError/);
  assert.match(safeMarkdown, /className="safe-markdown-fallback"/);
  assert.match(safeMarkdown, /\{this\.props\.markdown\}/);
  assert.match(safeMarkdown, /markdown-link-text/);
  assert.match(safeMarkdown, /markdown-image-placeholder/);
  assert.doesNotMatch(safeMarkdown, /rehypeRaw|skipHtml|dangerouslySetInnerHTML/);
  assert.match(preview, /<SafeMarkdown markdown=\{markdown\} variant="document" \/>/);
});

test("storage contract verifier references only current source files", async () => {
  const source = await readFile("scripts/verify-storage-contract.mjs", "utf8");
  const listedFiles = Array.from(source.matchAll(/^\s*"([^"]+)",$/gm), (match) => match[1])
    .filter((file) => file.startsWith("src") || file.startsWith("crates"));
  assert.ok(listedFiles.length > 0);
  await Promise.all(listedFiles.map((file) => access(file)));
});

test("workspace mutations are scoped and session loading clears stale rows first", async () => {
  const source = await readFile("src/App.tsx", "utf8");
  assert.match(source, /sessionMutationScopeRef/);
  assert.match(source, /messageMutationScopeRef/);
  assert.match(source, /fileImportScopeRef/);
  assert.match(source, /projectsRequestScopeRef/);

  const loadSessionsStart = source.indexOf("async function loadSessions");
  const loadSessionsEnd = source.indexOf("async function createSession", loadSessionsStart);
  const loadSessionsSource = source.slice(loadSessionsStart, loadSessionsEnd);
  assert.ok(loadSessionsSource.indexOf("setSessions([])") < loadSessionsSource.indexOf("await listSessions"));

  const loadProjectsStart = source.indexOf("async function loadProjects");
  const loadProjectsEnd = source.indexOf("async function loadProviders", loadProjectsStart);
  const loadProjectsSource = source.slice(loadProjectsStart, loadProjectsEnd);
  assert.match(loadProjectsSource, /catch[\s\S]*setProjects\(\[\]\)/);

  const loadTurnsStart = source.indexOf("async function loadTurns");
  const loadTurnsEnd = source.indexOf("async function retryDelivery", loadTurnsStart);
  const loadTurnsSource = source.slice(loadTurnsStart, loadTurnsEnd);
  assert.match(loadTurnsSource, /const scope = requestScope\(projectId, nextNodeId, nextSessionId\)/);
  assert.match(loadTurnsSource, /messageScopeRef\.current !== scope/);
});

test("leaving the file-pool context invalidates pending import presentation", async () => {
  const source = await readFile("src/App.tsx", "utf8");

  for (const [startMarker, endMarker] of [
    ["function openProjectImmediate", "async function loadNode"],
    ["function selectNodeImmediate", "function updateActiveProjectUi"],
    ["function closeRightSurface", "function openRightSurface"],
    ["function openRightSurface", "function selectDestinationImmediate"],
    ["function selectDestinationImmediate", "function executeNavigation"],
  ]) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    assert.match(source.slice(start, end), /fileImportScopeRef\.current = null/);
    assert.match(source.slice(start, end), /setImportingFile\(false\)/);
  }
});

test("file pool uses the approved single-action empty state", async () => {
  const [source, css] = await Promise.all([
    readFile("src/components/workspace/FilePoolWorkspace.tsx", "utf8"),
    readFile("src/styles/workspace.css", "utf8"),
  ]);

  assert.match(source, /className="file-pool-empty"/);
  assert.match(source, /className="file-pool-empty-folder"/);
  assert.match(source, /把项目资料放在这里/);
  assert.match(source, /本地保存 · 受限文本读取/);
  for (const format of ["PDF", "DOCX", "XLSX", "MD", "TXT"]) {
    assert.match(source, new RegExp(`>${format}<`));
  }
  assert.match(source, /files\.length > 0 \? <Button[^>]+onClick=\{onImport\}>导入文件<\/Button> : null/);
  assert.match(css, /\.file-pool-empty-panel/);
  assert.match(css, /radial-gradient/);
  assert.doesNotMatch(source, /<EmptyState/);
  assert.doesNotMatch(source, /name="file-pool"/);
});

test("provider editor preserves a multi-model draft with context windows", async () => {
  const source = await readFile("src/components/settings/ProviderEditorDialog.tsx", "utf8");
  assert.match(source, /models\.map/);
  assert.match(source, /contextWindowTokens/);
  assert.match(source, /添加模型/);
  assert.doesNotMatch(source, /const \[model, setModel\]/);
});

test("conversation controls are accessible and never invoke Tauri directly", async () => {
  const [modelMenu, fileMenu, indicator] = await Promise.all([
    readFile("src/components/workspace/ConversationModelMenu.tsx", "utf8"),
    readFile("src/components/workspace/ConversationFileMenu.tsx", "utf8"),
    readFile("src/components/workspace/ContextUsageIndicator.tsx", "utf8"),
  ]);
  assert.match(modelMenu, /aria-haspopup="menu"/);
  assert.match(modelMenu, /推理强度/);
  assert.match(modelMenu, /关闭/);
  assert.match(fileMenu, /导入新文件/);
  assert.match(fileMenu, /disabled=\{!selectable/);
  assert.match(indicator, /role="status"/);
  assert.match(indicator, /aria-label/);
  assert.doesNotMatch([modelMenu, fileMenu, indicator].join("\n"), /invoke\(/);
});

test("conversation pane composes controls and app uses combined send", async () => {
  const [conversationPane, appSource] = await Promise.all([
    readFile("src/components/workspace/ConversationPane.tsx", "utf8"),
    readFile("src/App.tsx", "utf8"),
  ]);
  const sendStart = appSource.indexOf("async function sendMessage");
  const sendEnd = appSource.indexOf("async function cancelAgent", sendStart);
  const sendMessageSource = appSource.slice(sendStart, sendEnd);
  assert.match(conversationPane, /ConversationModelMenu/);
  assert.match(conversationPane, /ConversationFileMenu/);
  assert.match(conversationPane, /ContextUsageIndicator/);
  assert.match(conversationPane, /message\.attachments/);
  assert.match(conversationPane, /message\.modelExecution/);
  assert.match(appSource, /getConversationContext/);
  assert.doesNotMatch(sendMessageSource, /appendMessage\(/);
  assert.match(sendMessageSource, /startAgentRun\([^)]*content[^)]*selectedFileIds/s);
});

test("conversation pane guards IME confirmation enter from submitting", async () => {
  const conversationPane = await readFile("src/components/workspace/ConversationPane.tsx", "utf8");
  assert.match(conversationPane, /onCompositionStart/);
  assert.match(conversationPane, /onCompositionEnd/);
  assert.match(conversationPane, /event\.nativeEvent\.keyCode === 229/);
  assert.match(conversationPane, /!event\.shiftKey/);
  assert.match(conversationPane, /isComposingRef/);
});

test("conversation context refresh is session scoped rather than keystroke scoped", async () => {
  const source = await readFile("src/App.tsx", "utf8");
  const start = source.indexOf("async function loadConversationContext");
  const end = source.indexOf("async function changeModelSelection", start);
  const block = source.slice(start, end);
  assert.match(block, /getConversationContext/);
  assert.doesNotMatch(block, /messageDraft/);
  const indicator = await readFile("src/components/workspace/ContextUsageIndicator.tsx", "utf8");
  assert.match(indicator, /统计暂不可用/);
  assert.match(indicator, /cumulativeUsage/);
});

test("empty conversation offers four editable presets", async () => {
  const presets = await readFile("src/components/workspace/ConversationPresets.tsx", "utf8");
  for (const label of [
    "梳理本节已有信息",
    "列出待确认问题",
    "基于参考资料补充细节",
    "检查本节遗漏并提出改进建议",
  ]) assert.match(presets, new RegExp(label));
  assert.match(presets, /onSelect\(preset\)/);
  assert.doesNotMatch(presets, /onSend|submit/);
});

test("run history and turn status open one centered detail dialog", async () => {
  const [history, turn, dialog] = await Promise.all([
    readFile("src/components/workspace/RunHistoryList.tsx", "utf8"),
    readFile("src/components/workspace/ConversationTurnCard.tsx", "utf8"),
    readFile("src/components/workspace/RunDetailDialog.tsx", "utf8"),
  ]);
  assert.match(history, /onOpen\(run\.id\)/);
  assert.match(turn, /onOpenRunDetail\(turn\.runId\)/);
  assert.match(dialog, /title="运行详情"/);
  assert.match(dialog, /活动时间线/);
  assert.match(dialog, /历史记录未保存此信息/);
});

test("conversation telemetry migration keeps one canonical full-history path", async () => {
  const sources = await Promise.all([
    "src/api.ts",
    "src-tauri/src/lib.rs",
    "crates/sion-agent/src/lib.rs",
    "crates/sion-agent/src/model_stream.rs",
    "crates/sion-core/src/lib.rs",
    "crates/sion-core/src/conversation.rs",
    "crates/sion-core/src/conversation_telemetry.rs",
  ].map((file) => readFile(file, "utf8")));
  const joined = sources.join("\n");
  assert.doesNotMatch(joined, /agent_context_estimate|TRANSCRIPT_WINDOW/);
  assert.match(joined, /conversation_context_get/);
  assert.match(joined, /agent_run_detail/);

  const presets = await readFile("src/components/workspace/ConversationPresets.tsx", "utf8");
  for (const label of [
    "梳理本节已有信息",
    "列出待确认问题",
    "基于参考资料补充细节",
    "检查本节遗漏并提出改进建议",
  ]) assert.match(presets, new RegExp(label));
});

test("conversation drafts and one-message files do not leak across nodes or sessions", async () => {
  const source = await readFile("src/App.tsx", "utf8");
  for (const [startMarker, endMarker] of [
    ["function openProjectImmediate", "async function loadNode"],
    ["function selectNodeImmediate", "function updateActiveProjectUi"],
    ["function selectSession", "const surface = workspaceView.rightSurface"],
  ]) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    assert.match(body, /setMessageDraft\(""\)/);
    assert.match(body, /setSelectedFileIds\(\[\]\)/);
  }
  const sessionStart = source.indexOf("function selectSession");
  const sessionEnd = source.indexOf("const surface = workspaceView.rightSurface", sessionStart);
  const sessionBody = source.slice(sessionStart, sessionEnd);
  assert.match(sessionBody, /fileImportScopeRef\.current = null/);
  assert.match(sessionBody, /setImportingFile\(false\)/);
});

test("conversation controls match the approved two-panel compact interaction", async () => {
  const [modelMenu, fileMenu, indicator, css] = await Promise.all([
    readFile("src/components/workspace/ConversationModelMenu.tsx", "utf8"),
    readFile("src/components/workspace/ConversationFileMenu.tsx", "utf8"),
    readFile("src/components/workspace/ContextUsageIndicator.tsx", "utf8"),
    readFile("src/styles/workspace.css", "utf8"),
  ]);
  assert.match(modelMenu, /conversation-model-main-panel/);
  assert.match(modelMenu, /conversation-model-submenu/);
  assert.match(modelMenu, /ArrowRight/);
  assert.match(css, /\.conversation-model-popover\s*\{[^}]*display:\s*flex/s);
  assert.match(fileMenu, /aria-label=\{`添加文件/);
  assert.match(fileMenu, />＋</);
  assert.doesNotMatch(fileMenu, /文件（\{selectedFileIds\.length\}）/);
  assert.match(indicator, /context-usage-detail/);
  assert.match(css, /\.context-usage-indicator:hover\s+\.context-usage-detail/);
  assert.match(css, /\.context-usage-indicator:focus-within\s+\.context-usage-detail/);
});

test("model selection mutations ignore stale session responses", async () => {
  const source = await readFile("src/App.tsx", "utf8");
  const start = source.indexOf("async function changeModelSelection");
  const end = source.indexOf("async function sendMessage", start);
  const body = source.slice(start, end);
  assert.match(body, /sessionMutationScopeRef\.current = scope/);
  assert.match(body, /isLatestRequest\(scope, sessionMutationScopeRef\.current\)/);
  assert.match(body, /isLatestRequest\(contextScope, workspaceScopeRef\.current\)/);
});

test("model menu keyboard navigation stays within its active panel", async () => {
  const source = await readFile("src/components/workspace/ConversationModelMenu.tsx", "utf8");
  assert.match(source, /target\.closest<HTMLElement>\('\[role="menu"\]'\)/);
  assert.match(source, /menu\?\.querySelectorAll<HTMLButtonElement>/);
  assert.match(source, /ArrowLeft[\s\S]*setSubmenu\(null\)/);
});

test("model submenu can shrink inside narrow viewports", async () => {
  const css = await readFile("src/styles/workspace.css", "utf8");
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.conversation-model-submenu\s*\{[^}]*min-width:\s*0/s);
});

test("conversation turns own agent status and the app no longer notices run completion", async () => {
  const [app, pane, card] = await Promise.all([
    readFile("src/App.tsx", "utf8"),
    readFile("src/components/workspace/ConversationPane.tsx", "utf8"),
    readFile("src/components/workspace/ConversationTurnCard.tsx", "utf8"),
  ]);
  assert.match(app, /conversation-turn-updated/);
  assert.doesNotMatch(app, /Agent 回复已保存到本地会话/);
  assert.doesNotMatch(app, /Agent 正在本机流式生成回复/);
  assert.doesNotMatch(app, /已请求取消 Agent Run/);
  assert.match(pane, /ConversationTurnCard/);
  assert.doesNotMatch(card, /<details/);
  assert.match(card, /conversation-turn-status/);
  assert.match(card, /reasoningSummary/);
  assert.match(card, /重新判断交付稿/);
});

test("conversation emits public reasoning summaries but never hidden reasoning", async () => {
  const source = await readFile("src-tauri/src/lib.rs", "utf8");
  assert.match(source, /"agent-reasoning-summary"/);
  assert.match(source, /StreamDelta::ReasoningSummary\(text\)/);
  const start = source.indexOf("struct AgentReasoningSummaryEvent");
  const end = source.indexOf("struct AgentFinishedEvent", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /reasoning_content/);
});

test("live public reasoning is scoped and cleared at terminal or navigation boundaries", async () => {
  const app = await readFile("src/App.tsx", "utf8");
  assert.match(app, /listen<AgentReasoningSummaryEvent>\("agent-reasoning-summary"/);
  assert.match(app, /appendLiveReasoning/);
  assert.match(app, /removeLiveReasoning/);
  assert.match(app, /\[project\?\.id, nodeId, sessionId\]/);
});

test("reasoning disclosure is collapsed, accessible, and adds no retry action", async () => {
  const source = await readFile(
    "src/components/workspace/ConversationReasoningDisclosure.tsx",
    "utf8",
  );
  assert.match(source, /useState\(false\)/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /Agent 正在思考/);
  assert.match(source, /模型暂未提供公开思考内容/);
  assert.doesNotMatch(source, /reasoning_content|重新请求|自动重试/);
});

test("conversation renders assistant and reasoning Markdown with bounded scrolling", async () => {
  const [turn, disclosure, css] = await Promise.all([
    readFile("src/components/workspace/ConversationTurnCard.tsx", "utf8"),
    readFile("src/components/workspace/ConversationReasoningDisclosure.tsx", "utf8"),
    readFile("src/styles/workspace.css", "utf8"),
  ]);

  assert.match(turn, /import \{ SafeMarkdown \} from "\.\/SafeMarkdown"/);
  assert.match(turn, /<SafeMarkdown markdown=\{assistantMessage\.content\} variant="chat" \/>/);
  assert.match(turn, /conversation-turn-message is-user">\{userMessage\.content\}/);
  assert.match(disclosure, /<SafeMarkdown markdown=\{displayContent\} variant="reasoning" \/>/);
  assert.match(disclosure, /\[\.\.\.\(content \?\? ""\)\]\.length/);
  assert.match(disclosure, /conversation-reasoning-count/);
  assert.match(css, /\.conversation-reasoning-content\s*\{[^}]*max-height:\s*min\(360px, 45vh\)/s);
  assert.match(css, /\.conversation-reasoning-content\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(disclosure, /scrollTop|scrollIntoView/);
});

test("delivery regenerates locally while DOCX stays in Export Center", async () => {
  const [delivery, exportCenter, app, shellCss] = await Promise.all([
    readFile("src/components/workspace/DeliveryWorkspace.tsx", "utf8"),
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/App.tsx", "utf8"),
    readFile("src/styles/shell.css", "utf8"),
  ]);
  assert.match(delivery, /重新生成交付稿/);
  assert.doesNotMatch(delivery, /导出 DOCX/);
  assert.match(exportCenter, /导出中心/);
  assert.match(app, /delivery-generation-token/);
  assert.match(shellCss, /\.notice-viewport\s*\{[^}]*top:\s*16px/s);
  assert.doesNotMatch(shellCss, /\.notice-viewport\s*\{[^}]*bottom:/s);
  assert.match(delivery, /locked: boolean/);
  assert.match(delivery, /disabled=\{!node \|\| locked\}/);
  assert.match(delivery, /node\.status !== "confirmed"/);
  assert.match(delivery, /确认交付稿/);
  assert.match(delivery, /disabled=\{!canSave \|\| !node \|\| locked\}/);
  assert.match(app, /const deliveryLocked = Boolean\(activeRunId\) \|\| regenerating/);
  assert.match(app, /locked=\{deliveryLocked\}/);
  assert.match(app, /if \(!project \|\| !node \|\| deliveryLocked\) return "cancelled"/);
  assert.match(app, /generationScopeByIdRef\.current\[payload\.generation\.id\]/);
  assert.match(app, /sessionId, activeGenerationId, selectedFileIds, node\.revision, messageDraft\.trim\(\), now\(\)/);
  assert.match(app, /saveNode\(project\.id, nodeId, node\.revision, draft, "confirmed", now\(\)\)/);
  assert.match(app, /deliveryGenerationScope\(project\.id, nodeId, sessionId\)/);
  assert.match(app, /generationScopeByIdRef/);
  assert.match(app, /setGenerationProgressByScope/);
  const generationStatus = await readFile("src/components/workspace/DeliveryGenerationStatus.tsx", "utf8");
  assert.match(generationStatus, /generation\.status === "queued"/);
  assert.match(generationStatus, /等待重新生成交付稿/);
});

test("obsolete manual assistant delivery flow is gone", async () => {
  const [app, api, tauri] = await Promise.all([
    readFile("src/App.tsx", "utf8"),
    readFile("src/api.ts", "utf8"),
    readFile("src-tauri/src/lib.rs", "utf8"),
  ]);
  for (const source of [app, api, tauri]) {
    assert.doesNotMatch(source, /project_preview_assistant_delivery|project_apply_assistant|previewAssistantDelivery|applyAssistant/);
  }
});

test("live reasoning and provider errors preserve the public-only boundary", async () => {
  const [transport, desktop, app, disclosure] = await Promise.all([
    readFile("crates/sion-agent/src/model_stream.rs", "utf8"),
    readFile("src-tauri/src/lib.rs", "utf8"),
    readFile("src/App.tsx", "utf8"),
    readFile("src/components/workspace/ConversationReasoningDisclosure.tsx", "utf8"),
  ]);
  assert.match(transport, /StreamFailure/);
  assert.match(desktop, /agent-reasoning-summary/);
  assert.match(app, /AgentReasoningSummaryEvent/);
  assert.match(disclosure, /aria-expanded/);
  const eventStart = desktop.indexOf("struct AgentReasoningSummaryEvent");
  const eventEnd = desktop.indexOf("struct AgentFinishedEvent", eventStart);
  assert.ok(eventStart >= 0 && eventEnd > eventStart);
  assert.doesNotMatch(desktop.slice(eventStart, eventEnd), /reasoning_content/);
  assert.doesNotMatch([app, disclosure].join("\n"), /reasoning_content/);
  assert.doesNotMatch(disclosure, /重新请求/);
});

test("export center separates blueprint and previews seven delivery artifacts", async () => {
  const [center, blueprint, navigator, preview, css] = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/components/export/BlueprintPreparationBar.tsx", "utf8"),
    readFile("src/components/export/ArtifactNavigator.tsx", "utf8"),
    readFile("src/components/export/ArtifactPreview.tsx", "utf8"),
    readFile("src/styles/export.css", "utf8"),
  ]);
  assert.match(center, /BlueprintPreparationBar/);
  assert.match(center, /ArtifactNavigator/);
  assert.match(center, /ArtifactPreview/);
  assert.match(center, /exportDocxSaveAs/);
  assert.match(center, /handleApprove\("formal_draft"\)/);
  assert.match(center, /regenerate_blueprint|regenerate_draft/);
  assert.match(blueprint, /准备材料/);
  assert.doesNotMatch(navigator, /export-blueprint\.md/);
  assert.match(navigator, /工程附件/);
  assert.match(preview, /当前为内容预览/);
  assert.match(preview, /另存为/);
  assert.match(css, /grid-template-columns/);
});

test("export center uses bottom model menu and review without right aside", async () => {
  const [center, action, css] = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/components/export/ExportActionBar.tsx", "utf8"),
    readFile("src/styles/export.css", "utf8"),
  ]);
  assert.match(action, /ConversationModelMenu/);
  assert.match(action, /ReviewLedger/);
  assert.match(action, /生成修改建议/);
  assert.doesNotMatch(action, /SelectField/);
  assert.doesNotMatch(center, /aside className="export-review"/);
  assert.match(center, /export-header-actions/);
  assert.match(center, /PRIMARY_LABELS\[next\.action\]/);
  assert.match(center, /ExportActionBar/);
  assert.match(css, /export-action-bar/);
  assert.match(css, /export-action-review/);
  assert.match(css, /export-header-actions/);
});

test("export center opens with a project list then workbench, no auto-pick", async () => {
  const [center, list, app] = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/components/export/ExportProjectList.tsx", "utf8"),
    readFile("src/App.tsx", "utf8"),
  ]);
  assert.match(center, /ExportProjectList/);
  assert.match(center, /onBackToList|所有导出项目/);
  assert.match(center, /onOpenProject/);
  assert.doesNotMatch(center, /resolveExportProjectId/);
  assert.doesNotMatch(center, /SelectField/);
  assert.match(list, /选择要导出的项目/);
  assert.match(list, /filterAndSortProjects/);
  assert.match(list, /打开导出文件夹/);
  assert.match(app, /setExportProjectId\(null\)/);
  assert.doesNotMatch(app, /resolveExportProjectId/);
  assert.match(app, /onOpenProject=\{setExportProjectId\}/);
  assert.match(app, /onBackToList=\{\(\) => setExportProjectId\(null\)\}/);
});

test("export center can open the project exports folder", async () => {
  const [center, list, api, tauri] = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/components/export/ExportProjectList.tsx", "utf8"),
    readFile("src/api.ts", "utf8"),
    readFile("src-tauri/src/lib.rs", "utf8"),
  ]);
  assert.match(center, /打开导出文件夹/);
  assert.match(center, /revealExportFolder|handleRevealExportFolder/);
  assert.match(list, /打开导出文件夹/);
  assert.match(api, /export_folder_reveal/);
  assert.match(tauri, /fn export_folder_reveal/);
  assert.match(tauri, /exports/);
});

test("export center surfaces run progress and terminal outcomes", async () => {
  const [center, css, runtime] = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/styles/export.css", "utf8"),
    readFile("src-tauri/src/export_runtime.rs", "utf8"),
  ]);
  assert.match(center, /export-run-updated/);
  assert.match(center, /export-run-banner/);
  assert.match(center, /runOutcome/);
  assert.match(center, /formatElapsed|已用时/);
  assert.match(center, /导出失败/);
  assert.match(css, /export-run-banner/);
  assert.match(runtime, /正在生成导出蓝图/);
  assert.match(runtime, /progress_summary_for_target|require_cas_saved/);
});

test("export review is a task ledger with explicit diff application, not chat", async () => {
  const [center, ledger, diff, action] = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/components/export/ReviewLedger.tsx", "utf8"),
    readFile("src/components/export/ArtifactDiff.tsx", "utf8"),
    readFile("src/components/export/ExportActionBar.tsx", "utf8"),
  ]);
  assert.match(ledger, /评审任务/);
  assert.match(ledger, /生成修改建议/);
  assert.match(ledger, /应用修改/);
  assert.doesNotMatch(ledger, /ChatSession|消息|conversation/);
  assert.match(diff, /selectedChangeIds/);
  assert.match(center, /expectedRevision/);
  assert.match(center, /expectedDigest/);
  assert.match(center, /取消/);
  assert.match(action, /生成修改建议/);
});

test("app scopes export events and removes the obsolete one-shot command", async () => {
  const [app, api, tauri] = await Promise.all([
    readFile("src/App.tsx", "utf8"),
    readFile("src/api.ts", "utf8"),
    readFile("src-tauri/src/lib.rs", "utf8"),
  ]);
  assert.match(app, /export-workspace-invalidated/);
  assert.match(app, /projectId/);
  assert.match(app, /exportRefreshByProject/);
  assert.doesNotMatch(app, /lastExportResult|setExporting|exportDocxApi/);
  assert.doesNotMatch(api, /project_export_docx/);
  assert.doesNotMatch(tauri, /project_export_docx,/);
});

test("export center advertises only implemented local capabilities", async () => {
  const sources = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("README.md", "utf8"),
    readFile("README.en.md", "utf8"),
  ]);
  const joined = sources.join("\n");
  assert.match(joined, /导出蓝图|Export blueprint/);
  assert.match(joined, /DOCX/);
  assert.doesNotMatch(joined, /云端导出|计划任务|scheduled export|cloud export/i);
});

test("dependency delivery tokens appear in context and run details", async () => {
  const [types, indicator, dialog, app] = await Promise.all([
    readFile("src/types.ts", "utf8"),
    readFile("src/components/workspace/ContextUsageIndicator.tsx", "utf8"),
    readFile("src/components/workspace/RunDetailDialog.tsx", "utf8"),
    readFile("src/App.tsx", "utf8"),
  ]);
  assert.match(types, /dependencyNodeTokens: number/);
  assert.match(indicator, /依赖节点交付稿/);
  assert.match(indicator, /snapshot\.breakdown\.dependencyNodeTokens/);
  assert.match(dialog, /依赖节点交付稿/);
  assert.match(dialog, /breakdown\.dependencyNodeTokens/);
  assert.match(app, /dependency_nodes:\s*"依赖节点交付稿"/);
});

test("delivery decision details expose raw json diff and save result", async () => {
  const [details, runDetail, appSource, types] = await Promise.all([
    readFile("src/components/workspace/DeliveryDecisionDetails.tsx", "utf8"),
    readFile("src/components/workspace/RunDetailDialog.tsx", "utf8"),
    readFile("src/App.tsx", "utf8"),
    readFile("src/types.ts", "utf8"),
  ]);
  assert.match(details, /模型返回的交付 JSON/);
  assert.match(details, /交付稿差异/);
  assert.match(details, /保存结果/);
  assert.match(details, /proposedMarkdown/);
  assert.doesNotMatch(details, /dangerouslySetInnerHTML/);
  assert.match(runDetail, /delivery_decision/);
  assert.match(runDetail, /DeliveryDecisionDetails/);
  assert.match(appSource, /delivery-decision-token/);
  assert.match(appSource, /liveDecisionRawByTurn/);
  assert.match(types, /DeliveryDecisionTokenEvent/);
  assert.match(types, /DeliveryDecisionInspection/);
});

test("active conversation work uses an accessible beacon instead of a blinking dot", async () => {
  const styles = await readFile("src/styles/workspace.css", "utf8");
  assert.match(styles, /conversation-activity-beacon/);
  assert.match(styles, /@keyframes conversation-activity-beacon/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
