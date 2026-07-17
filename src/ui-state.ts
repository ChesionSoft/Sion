import { NODES } from "./types.ts";
import type { AgentRun, NodeId, ProjectUiSettings, RecentProject, RightSurface, UiSettings, WorkspaceView } from "./types.ts";

const NODE_IDS = new Set<string>(NODES.map(([id]) => id));
const FIXED_NODE_IDS = NODES.map(([id]) => id);
const MIN_PANE_WIDTH = 320;
const MAX_PANE_WIDTH = 720;

export type ProjectSort = "recent" | "name";
export type NavigationIntent =
  | { kind: "destination"; destination: "projects" | "exports" }
  | { kind: "project"; projectId: string }
  | { kind: "node"; nodeId: NodeId }
  | { kind: "close-node"; nodeId: NodeId }
  | { kind: "close-window" };

export type SaveResult = "saved" | "conflict" | "failed";

export function requestScope(...parts: Array<string | null | undefined>): string | null {
  return parts.every((part): part is string => typeof part === "string") ? JSON.stringify(parts) : null;
}

export function isLatestRequest(expected: string | null, current: string | null): boolean {
  return expected !== null && expected === current;
}

export function shouldChangeNode(currentNodeId: NodeId | null, nextNodeId: NodeId): boolean {
  return currentNodeId !== nextNodeId;
}

export function shouldChangeProject(currentProjectId: string | null, nextProjectId: string): boolean {
  return currentProjectId !== nextProjectId;
}

export function isAgentRulesDirty(draft: string, saved: string | null | undefined): boolean {
  return draft !== (saved ?? "");
}

export function activeRunIdForContext(
  runs: AgentRun[],
  projectId: string | null,
  nodeId: NodeId | null,
): string | null {
  if (!projectId || !nodeId) return null;
  return runs.find((run) => (
    run.projectId === projectId
    && run.nodeId === nodeId
    && (run.status === "queued" || run.status === "running")
  ))?.id ?? null;
}

export function createSerialTaskQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function requestNavigationDecision(dirty: boolean, intent: NavigationIntent) {
  return dirty
    ? { execute: null, pending: intent }
    : { execute: intent, pending: null };
}

export function resolveNavigationDecision(
  pending: NavigationIntent,
  action: "cancel" | "discard" | "save",
  saveResult?: SaveResult,
) {
  if (action === "cancel") return { execute: null, pending: null, shouldSave: false };
  if (action === "discard") return { execute: pending, pending: null, shouldSave: false };
  if (saveResult === "saved") return { execute: pending, pending: null, shouldSave: false };
  return { execute: null, pending, shouldSave: saveResult === undefined };
}

export function filterAndSortProjects(projects: RecentProject[], query: string, sort: ProjectSort): RecentProject[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return projects
    .filter((project) => !normalized || project.name.toLocaleLowerCase("zh-CN").includes(normalized))
    .sort((left, right) => sort === "name"
      ? left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" })
      : Date.parse(right.openedAt) - Date.parse(left.openedAt));
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && NODE_IDS.has(value);
}

export const initialWorkspaceView = (): WorkspaceView => ({
  rightSurface: { kind: "delivery" },
  deliveryView: "preview",
});

export const resetWorkspaceViewForNode = (
  current: WorkspaceView,
  options: { sameNode: boolean },
): WorkspaceView => (options.sameNode ? current : initialWorkspaceView());

export function parentSurface(surface: RightSurface): RightSurface | null {
  if (surface.kind === "file") return { kind: "file-pool" };
  if (surface.kind === "delivery-preview") return { kind: "delivery" };
  return null;
}

export const initialProjectUi = (): ProjectUiSettings => ({
  initialized: true,
  openedNodeIds: [...FIXED_NODE_IDS],
  activeNodeId: "basic-info",
  tabsInitialized: true,
  rightTabIds: ["delivery"],
  activeRightTabId: "delivery",
  rightPaneWidth: 440,
});

export const selectNode = (
  state: ProjectUiSettings,
  nodeId: NodeId,
): ProjectUiSettings => ({
  ...state,
  initialized: true,
  openedNodeIds: [...FIXED_NODE_IDS],
  activeNodeId: nodeId,
  tabsInitialized: true,
  rightTabIds: ["delivery"],
  activeRightTabId: "delivery",
});

export const initialUiSettings = (): UiSettings => ({
  sidebarCollapsed: false,
  lastDestination: "projects",
  projects: {},
});

function sanitizeProjectUi(value: ProjectUiSettings): ProjectUiSettings {
  const activeNodeId = isNodeId(value.activeNodeId) ? value.activeNodeId : "basic-info";
  return {
    initialized: true,
    openedNodeIds: [...FIXED_NODE_IDS],
    activeNodeId,
    tabsInitialized: true,
    rightTabIds: ["delivery"],
    activeRightTabId: "delivery",
    rightPaneWidth: Math.min(
      MAX_PANE_WIDTH,
      Math.max(MIN_PANE_WIDTH, Number(value.rightPaneWidth) || 440),
    ),
  };
}

export const sanitizeUiSettings = (value: UiSettings): UiSettings => ({
  sidebarCollapsed: Boolean(value?.sidebarCollapsed),
  lastDestination: value?.lastDestination === "exports" ? "exports" : "projects",
  projects: Object.fromEntries(
    Object.entries(value?.projects ?? {})
      .slice(0, 256)
      .map(([projectId, project]) => [projectId, sanitizeProjectUi(project)]),
  ),
});

export const durableUiSettings = (state: UiSettings): UiSettings => sanitizeUiSettings(state);
