import { NODES } from "./types.ts";

export const ICON_NAMES = [
  "projects",
  "export",
  "settings",
  "project-document",
  "delivery",
  "agent",
  "file-pool",
  "chat-history",
  "run-history",
  "search",
  "sidebar-collapse",
  "sidebar-expand",
  "back",
  "close",
  "trash",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export const PRIMARY_NAV_ITEMS = [
  { id: "projects", label: "项目", icon: "projects" },
  { id: "exports", label: "导出中心", icon: "export" },
] as const;

export const WORKSPACE_HEADER_ACTIONS = [
  { id: "delivery", label: "交付稿", icon: "delivery" },
  { id: "agent-rules", label: "agent.md", icon: "agent" },
  { id: "file-pool", label: "文件池", icon: "file-pool" },
] as const;

export const MORE_MENU_ITEMS = [
  { id: "run-history", label: "运行记录", icon: "run-history" },
] as const;

export const WORKSPACE_NODE_ROWS = NODES;
