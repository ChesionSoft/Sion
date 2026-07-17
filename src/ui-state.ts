import { NODES } from "./types.ts";
import type { NodeId, ProjectUiSettings, RecentProject, RightTabId, UiSettings } from "./types.ts";

const NODE_IDS = new Set<string>(NODES.map(([id]) => id));
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

function isRightTabId(value: unknown): value is RightTabId {
  return typeof value === "string" && (
    value === "delivery"
    || value === "files"
    || value.startsWith("file:")
    || value.startsWith("delivery-preview:")
  );
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export const initialProjectUi = (): ProjectUiSettings => ({
  initialized: true,
  openedNodeIds: ["basic-info"],
  activeNodeId: "basic-info",
  tabsInitialized: true,
  rightTabIds: ["delivery"],
  activeRightTabId: "delivery",
  rightPaneWidth: 440,
});

export const initialUiSettings = (): UiSettings => ({
  sidebarCollapsed: false,
  lastDestination: "projects",
  projects: {},
});

function sanitizeProjectUi(value: ProjectUiSettings): ProjectUiSettings {
  const openedNodeIds = unique((value.openedNodeIds ?? []).filter(isNodeId)).slice(-12);
  const rightTabIds = unique((value.rightTabIds ?? []).filter(isRightTabId)).slice(-32);
  return {
    initialized: Boolean(value.initialized),
    openedNodeIds,
    activeNodeId: openedNodeIds.includes(value.activeNodeId as NodeId) ? value.activeNodeId : openedNodeIds.at(-1) ?? null,
    tabsInitialized: Boolean(value.tabsInitialized),
    rightTabIds,
    activeRightTabId: rightTabIds.includes(value.activeRightTabId as RightTabId) ? value.activeRightTabId : rightTabIds.at(-1) ?? null,
    rightPaneWidth: Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, Number(value.rightPaneWidth) || 440)),
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

export const openNode = (state: ProjectUiSettings, nodeId: NodeId): ProjectUiSettings => ({
  ...state,
  initialized: true,
  openedNodeIds: [...state.openedNodeIds.filter((id) => id !== nodeId), nodeId],
  activeNodeId: nodeId,
});

export const closeNode = (state: ProjectUiSettings, nodeId: NodeId): ProjectUiSettings => {
  const openedNodeIds = state.openedNodeIds.filter((id) => id !== nodeId);
  return {
    ...state,
    initialized: true,
    openedNodeIds,
    activeNodeId: state.activeNodeId === nodeId ? openedNodeIds.at(-1) ?? null : state.activeNodeId,
  };
};

export const openRightTab = (state: ProjectUiSettings, tabId: RightTabId): ProjectUiSettings => ({
  ...state,
  tabsInitialized: true,
  rightTabIds: state.rightTabIds.includes(tabId) ? state.rightTabIds : [...state.rightTabIds, tabId],
  activeRightTabId: tabId,
});

export const closeRightTab = (state: ProjectUiSettings, tabId: RightTabId): ProjectUiSettings => {
  const closedIndex = state.rightTabIds.indexOf(tabId);
  const rightTabIds = state.rightTabIds.filter((id) => id !== tabId);
  return {
    ...state,
    tabsInitialized: true,
    rightTabIds,
    activeRightTabId: state.activeRightTabId === tabId
      ? rightTabIds[Math.min(Math.max(closedIndex, 0), rightTabIds.length - 1)] ?? null
      : state.activeRightTabId,
  };
};

export const durableUiSettings = (state: UiSettings): UiSettings => sanitizeUiSettings({
  ...state,
  projects: Object.fromEntries(Object.entries(state.projects).map(([projectId, project]) => {
    const rightTabIds = project.rightTabIds.filter((id) => !id.startsWith("delivery-preview:"));
    return [projectId, {
      ...project,
      rightTabIds,
      activeRightTabId: rightTabIds.includes(project.activeRightTabId as RightTabId)
        ? project.activeRightTabId
        : rightTabIds.at(-1) ?? null,
    }];
  })),
});
