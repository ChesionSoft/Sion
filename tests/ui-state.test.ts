import assert from "node:assert/strict";
import test from "node:test";
import * as uiState from "../src/ui-state.ts";
import {
  createSerialTaskQueue,
  durableUiSettings,
  filterAndSortProjects,
  initialProjectUi,
  initialWorkspaceView,
  requestNavigationDecision,
  requestScope,
  resetWorkspaceViewForNode,
  resolveNavigationDecision,
  sanitizeUiSettings,
  selectNode,
  parentSurface,
} from "../src/ui-state.ts";
import type { NavigationIntent } from "../src/ui-state.ts";
import { NODES } from "../src/types.ts";
import type { AgentRun } from "../src/types.ts";

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

test("first project open initializes every node in fixed order and delivery preview", () => {
  const project = initialProjectUi();
  assert.deepEqual(project.openedNodeIds, NODES.map(([id]) => id));
  assert.equal(project.activeNodeId, "basic-info");
  assert.deepEqual(project.rightTabIds, ["delivery"]);
  assert.equal(project.activeRightTabId, "delivery");
  assert.deepEqual(initialWorkspaceView(), {
    rightSurface: { kind: "delivery" },
    deliveryView: "preview",
  });
});

test("selecting a node changes only the active node and never reorders the directory", () => {
  const selected = selectNode(initialProjectUi(), "goals");
  assert.equal(selected.activeNodeId, "goals");
  assert.deepEqual(selected.openedNodeIds, NODES.map(([id]) => id));
});

test("legacy opened nodes and tabs normalize to the fixed directory and delivery", () => {
  const sanitized = sanitizeUiSettings({
    sidebarCollapsed: false,
    lastDestination: "projects",
    projects: {
      project: {
        initialized: true,
        openedNodeIds: ["goals", "basic-info"],
        activeNodeId: "goals",
        tabsInitialized: true,
        rightTabIds: ["files", "file:old"],
        activeRightTabId: "file:old",
        rightPaneWidth: 9999,
      },
    },
  });
  assert.deepEqual(sanitized.projects.project.openedNodeIds, NODES.map(([id]) => id));
  assert.equal(sanitized.projects.project.activeNodeId, "goals");
  assert.deepEqual(sanitized.projects.project.rightTabIds, ["delivery"]);
  assert.equal(sanitized.projects.project.activeRightTabId, "delivery");
  assert.equal(sanitized.projects.project.rightPaneWidth, 720);
});

test("node change resets transient surfaces to delivery preview", () => {
  assert.deepEqual(
    resetWorkspaceViewForNode(
      {
        rightSurface: { kind: "file", fileId: "brief" },
        deliveryView: "source",
      },
      { sameNode: false },
    ),
    initialWorkspaceView(),
  );
});

test("same-node selection preserves the current transient workspace", () => {
  const current = {
    rightSurface: { kind: "agent-rules" } as const,
    deliveryView: "preview" as const,
  };
  assert.equal(
    resetWorkspaceViewForNode(current, { sameNode: true }),
    current,
  );
});

test("durable settings never persist file or assistant preview surfaces", () => {
  const durable = durableUiSettings({
    sidebarCollapsed: false,
    lastDestination: "projects",
    projects: {
      project: {
        ...initialProjectUi(),
        rightTabIds: ["file:brief"],
        activeRightTabId: "file:brief",
      },
    },
  });
  assert.deepEqual(durable.projects.project.rightTabIds, ["delivery"]);
  assert.equal(durable.projects.project.activeRightTabId, "delivery");
});

test("nested right surfaces return to their owning workspace", () => {
  assert.deepEqual(
    parentSurface({ kind: "file", fileId: "brief" }),
    { kind: "file-pool" },
  );
  assert.equal(parentSurface({ kind: "delivery" }), null);
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

test("same-node navigation is a no-op before transient content is cleared", () => {
  const shouldChangeNode = (uiState as unknown as {
    shouldChangeNode?: (currentNodeId: string | null, nextNodeId: string) => boolean;
  }).shouldChangeNode;
  assert.equal(typeof shouldChangeNode, "function");
  assert.equal(shouldChangeNode?.("goals", "goals"), false);
  assert.equal(shouldChangeNode?.("goals", "basic-info"), true);
});

test("project collections reset only when opening a different project", () => {
  const shouldChangeProject = (uiState as unknown as {
    shouldChangeProject?: (currentProjectId: string | null, nextProjectId: string) => boolean;
  }).shouldChangeProject;
  assert.equal(typeof shouldChangeProject, "function");
  assert.equal(shouldChangeProject?.("project-a", "project-a"), false);
  assert.equal(shouldChangeProject?.("project-a", "project-b"), true);
  assert.equal(shouldChangeProject?.(null, "project-a"), true);
});

test("agent rule drafts participate in dirty navigation protection", () => {
  const isAgentRulesDirty = (uiState as unknown as {
    isAgentRulesDirty?: (draft: string, saved: string | null | undefined) => boolean;
  }).isAgentRulesDirty;
  assert.equal(typeof isAgentRulesDirty, "function");
  assert.equal(isAgentRulesDirty?.("只使用事实", "只使用事实"), false);
  assert.equal(isAgentRulesDirty?.("只使用事实\n", "只使用事实"), true);
  assert.equal(isAgentRulesDirty?.("新增规则", null), true);
});

test("active agent runs are selected only for the current project and node", () => {
  const activeRunIdForContext = (uiState as unknown as {
    activeRunIdForContext?: (runs: AgentRun[], projectId: string | null, nodeId: string | null) => string | null;
  }).activeRunIdForContext;
  const runs: AgentRun[] = [
    { id: "old-project", projectId: "project-a", nodeId: "goals", status: "running" },
    { id: "old-node", projectId: "project-b", nodeId: "basic-info", status: "queued" },
    { id: "current", projectId: "project-b", nodeId: "goals", status: "running" },
  ];
  assert.equal(typeof activeRunIdForContext, "function");
  assert.equal(activeRunIdForContext?.(runs, "project-b", "goals"), "current");
  assert.equal(activeRunIdForContext?.(runs, "project-b", "final-export"), null);
  assert.equal(activeRunIdForContext?.(runs, null, "goals"), null);
});

test("late async responses are accepted only for the latest request scope", () => {
  const isLatestRequest = (uiState as unknown as {
    isLatestRequest?: (expected: string | null, current: string | null) => boolean;
  }).isLatestRequest;
  assert.equal(typeof isLatestRequest, "function");
  assert.equal(isLatestRequest?.("request-a", "request-a"), true);
  assert.equal(isLatestRequest?.("request-a", "request-b"), false);
  assert.equal(isLatestRequest?.(null, null), false);
});
