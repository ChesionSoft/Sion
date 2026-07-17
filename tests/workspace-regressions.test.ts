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
});

test("leaving the file-pool context invalidates pending import presentation", async () => {
  const source = await readFile("src/App.tsx", "utf8");

  for (const [startMarker, endMarker] of [
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
