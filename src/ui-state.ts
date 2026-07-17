import { NODES } from "./types.ts";
import type { NodeId, ProjectUiSettings, RecentProject, RightTabId, UiSettings } from "./types.ts";

const NODE_IDS = new Set<string>(NODES.map(([id]) => id));
const MIN_PANE_WIDTH = 320;
const MAX_PANE_WIDTH = 720;

export type ProjectSort = "recent" | "name";

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
