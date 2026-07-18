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

test("markdown preview preserves raw HTML as escaped text", async () => {
  const source = await readFile("src/components/workspace/MarkdownPreview.tsx", "utf8");
  assert.doesNotMatch(source, /\bskipHtml\b/);
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

test("delivery regenerates locally while DOCX stays in Export Center", async () => {
  const [delivery, exportCenter, app, shellCss] = await Promise.all([
    readFile("src/components/workspace/DeliveryWorkspace.tsx", "utf8"),
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/App.tsx", "utf8"),
    readFile("src/styles/shell.css", "utf8"),
  ]);
  assert.match(delivery, /重新生成交付稿/);
  assert.doesNotMatch(delivery, /导出 DOCX/);
  assert.match(exportCenter, /导出 DOCX/);
  assert.match(app, /delivery-generation-token/);
  assert.match(shellCss, /\.notice-viewport\s*\{[^}]*top:\s*16px/s);
  assert.doesNotMatch(shellCss, /\.notice-viewport\s*\{[^}]*bottom:/s);
  assert.match(delivery, /locked: boolean/);
  assert.match(delivery, /disabled=\{!node \|\| locked\}/);
  assert.match(delivery, /disabled=\{!dirty \|\| !node \|\| locked\}/);
  assert.match(app, /const deliveryLocked = Boolean\(activeRunId\) \|\| regenerating/);
  assert.match(app, /locked=\{deliveryLocked\}/);
  assert.match(app, /if \(!project \|\| !node \|\| deliveryLocked\) return "cancelled"/);
  assert.match(app, /isCurrentGenerationEvent\(activeGenerationIdRef\.current, payload\.generation\.id\)/);
  assert.match(app, /sessionId, activeGenerationId, selectedFileIds/);
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
