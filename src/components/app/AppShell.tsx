import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { type MainDestination, type NodeId, type NoticeMessage, type RecentProject, type UiSettings } from "../../types";
import { IconButton, Icon, Notice } from "../ui";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { Sidebar } from "./Sidebar";

const TITLEBAR_GESTURE_HEIGHT = 56;

function isTitlebarGesture(event: MouseEvent<HTMLDivElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientY - bounds.top >= TITLEBAR_GESTURE_HEIGHT) return false;
  const target = event.target;
  return !(target instanceof Element && target.closest("button, input, textarea, select, a, [role=\"button\"]"));
}

export type AppShellProps = {
  destination: MainDestination;
  projects: RecentProject[];
  activeProject: RecentProject | null;
  ui: UiSettings;
  notice: NoticeMessage | null;
  onDismissNotice: () => void;
  onDestination: (destination: "projects" | "exports") => void;
  onProject: (project: RecentProject) => void;
  onNode: (nodeId: NodeId) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
};

export function AppShell(props: AppShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (!props.notice?.dismissAfterMs) return;
    const timeout = window.setTimeout(props.onDismissNotice, props.notice.dismissAfterMs);
    return () => window.clearTimeout(timeout);
  }, [props.notice, props.onDismissNotice]);

  function chooseProject(project: RecentProject) {
    setSearchOpen(false);
    props.onProject(project);
  }

  function chooseNode(nodeId: NodeId) {
    setSearchOpen(false);
    props.onNode(nodeId);
  }

  function startWindowDragging(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !isTitlebarGesture(event)) return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  }

  function toggleWindowMaximize(event: MouseEvent<HTMLDivElement>) {
    if (!isTitlebarGesture(event)) return;
    event.preventDefault();
    void getCurrentWindow().toggleMaximize();
  }

  return (
    <div
      className={`app-shell ${props.ui.sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}
      onMouseDown={startWindowDragging}
      onDoubleClick={toggleWindowMaximize}
    >
      <Sidebar
        destination={props.destination}
        projects={props.projects}
        activeProject={props.activeProject}
        ui={props.ui}
        onDestination={props.onDestination}
        onProject={chooseProject}
        onNode={chooseNode}
        onToggle={props.onToggleSidebar}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={props.onOpenSettings}
      />
      <main className="app-main">
        {props.ui.sidebarCollapsed ? (
          <div className="collapsed-shell-actions">
            <IconButton aria-label="展开侧边栏" onClick={props.onToggleSidebar}><Icon name="sidebar-expand" /></IconButton>
            <IconButton aria-label="搜索项目和节点" onClick={() => setSearchOpen(true)}><Icon name="search" /></IconButton>
          </div>
        ) : null}
        {props.children}
      </main>
      <div className="notice-viewport" aria-live="polite">
        {props.notice ? <Notice kind={props.notice.kind} onDismiss={props.onDismissNotice}>{props.notice.message}</Notice> : null}
      </div>
      <GlobalSearchDialog open={searchOpen} projects={props.projects} activeProject={props.activeProject} onClose={() => setSearchOpen(false)} onProject={chooseProject} onNode={chooseNode} />
    </div>
  );
}
