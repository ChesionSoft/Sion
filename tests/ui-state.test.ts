import assert from "node:assert/strict";
import test from "node:test";
import {
  closeNode,
  closeRightTab,
  createSerialTaskQueue,
  durableUiSettings,
  filterAndSortProjects,
  initialProjectUi,
  requestNavigationDecision,
  requestScope,
  resolveNavigationDecision,
  openNode,
  openRightTab,
  sanitizeUiSettings,
} from "../src/ui-state.ts";
import type { NavigationIntent } from "../src/ui-state.ts";

test("filters project names case-insensitively and sorts recent projects descending", () => {
  const projects = [
    { id: "1", name: "Alpha Brief", rootPath: "/alpha", openedAt: "2026-07-15T08:00:00Z" },
    { id: "2", name: "beta Launch", rootPath: "/beta", openedAt: "2026-07-17T08:00:00Z" },
    { id: "3", name: "ALPHA Archive", rootPath: "/archive", openedAt: "2026-07-16T08:00:00Z" },
  ];

  assert.deepEqual(
    filterAndSortProjects(projects, "alpha", "recent").map((project) => project.id),
    ["3", "1"],
  );
  assert.deepEqual(
    filterAndSortProjects(projects, "", "name").map((project) => project.name),
    ["ALPHA Archive", "Alpha Brief", "beta Launch"],
  );
});

test("first project open initializes basic info and delivery", () => {
  assert.deepEqual(initialProjectUi(), {
    initialized: true,
    openedNodeIds: ["basic-info"],
    activeNodeId: "basic-info",
    tabsInitialized: true,
    rightTabIds: ["delivery"],
    activeRightTabId: "delivery",
    rightPaneWidth: 440,
  });
});

test("closing the last node preserves an intentional empty state", () => {
  const state = closeNode(initialProjectUi(), "basic-info");
  assert.deepEqual(state.openedNodeIds, []);
  assert.equal(state.activeNodeId, null);
  assert.equal(state.initialized, true);
});

test("closing active node selects the most recent remaining node", () => {
  let state = openNode(initialProjectUi(), "goals");
  state = openNode(state, "business-flow");
  state = closeNode(state, "business-flow");
  assert.equal(state.activeNodeId, "goals");
});

test("closing the final right tab keeps tabs initialized and empty", () => {
  const state = closeRightTab(initialProjectUi(), "delivery");
  assert.deepEqual(state.rightTabIds, []);
  assert.equal(state.activeRightTabId, null);
});

test("closing an inactive right tab preserves the active tab", () => {
  let state = openRightTab(initialProjectUi(), "files");
  state = openRightTab(state, "file:brief");
  state = closeRightTab(state, "files");
  assert.equal(state.activeRightTabId, "file:brief");
  assert.deepEqual(state.rightTabIds, ["delivery", "file:brief"]);
});

test("closing the first active right tab selects its nearest neighbor", () => {
  let state = openRightTab(initialProjectUi(), "files");
  state = openRightTab(state, "file:brief");
  state = openRightTab(state, "delivery");
  state = closeRightTab(state, "delivery");
  assert.equal(state.activeRightTabId, "files");
});

test("durable file tabs persist and pane width clamps", () => {
  const state = openRightTab(initialProjectUi(), "file:brief");
  const low = sanitizeUiSettings({ sidebarCollapsed: false, lastDestination: "projects", projects: { p1: { ...state, rightPaneWidth: 10 } } });
  const high = sanitizeUiSettings({ sidebarCollapsed: false, lastDestination: "projects", projects: { p1: { ...state, rightPaneWidth: 9999 } } });
  assert.deepEqual(low.projects.p1.rightTabIds, ["delivery", "file:brief"]);
  assert.equal(low.projects.p1.rightPaneWidth, 320);
  assert.equal(high.projects.p1.rightPaneWidth, 720);
});

test("transient preview tabs are excluded from persisted settings", () => {
  const state = openRightTab(initialProjectUi(), "delivery-preview:message-1");
  const durable = durableUiSettings({
    sidebarCollapsed: false,
    lastDestination: "projects",
    projects: { p1: state },
  });
  assert.deepEqual(durable.projects.p1.rightTabIds, ["delivery"]);
});

test("clean navigation executes immediately while dirty navigation waits", () => {
  const intent: NavigationIntent = { kind: "node", nodeId: "goals" };
  assert.deepEqual(requestNavigationDecision(false, intent), { execute: intent, pending: null });
  assert.deepEqual(requestNavigationDecision(true, intent), { execute: null, pending: intent });
});

test("cancel clears a pending navigation and discard executes without saving", () => {
  const intent: NavigationIntent = { kind: "project", projectId: "project-2" };
  assert.deepEqual(resolveNavigationDecision(intent, "cancel"), { execute: null, pending: null, shouldSave: false });
  assert.deepEqual(resolveNavigationDecision(intent, "discard"), { execute: intent, pending: null, shouldSave: false });
});

test("save executes navigation only after a successful save", () => {
  const intent: NavigationIntent = { kind: "close-window" };
  assert.deepEqual(resolveNavigationDecision(intent, "save"), { execute: null, pending: intent, shouldSave: true });
  assert.deepEqual(resolveNavigationDecision(intent, "save", "failed"), { execute: null, pending: intent, shouldSave: false });
  assert.deepEqual(resolveNavigationDecision(intent, "save", "conflict"), { execute: null, pending: intent, shouldSave: false });
  assert.deepEqual(resolveNavigationDecision(intent, "save", "saved"), { execute: intent, pending: null, shouldSave: false });
});

test("async request scopes change when project, node, or session changes", () => {
  const nodeRequest = requestScope("project-1", "basic-info");
  assert.equal(nodeRequest, requestScope("project-1", "basic-info"));
  assert.notEqual(nodeRequest, requestScope("project-1", "goals"));
  assert.notEqual(nodeRequest, requestScope("project-2", "basic-info"));
  assert.notEqual(requestScope("project-1", "basic-info", "session-1"), requestScope("project-1", "basic-info", "session-2"));
  assert.equal(requestScope("project-1", null), null);
});

test("serial task queue preserves persistence request order", async () => {
  const enqueue = createSerialTaskQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = enqueue(async () => { order.push("first-start"); await firstGate; order.push("first-end"); });
  const second = enqueue(async () => { order.push("second"); });
  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});
