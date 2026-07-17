import { useEffect, useState, type ReactNode } from "react";
import { getNode } from "../../api";
import { NODES, type MainDestination, type NodeId, type NodeStatus, type NoticeMessage, type RecentProject, type UiSettings } from "../../types";
import { EmptyState, IconButton, Notice } from "../ui";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { NodePickerDialog } from "./NodePickerDialog";
import { Sidebar } from "./Sidebar";

export type AppShellProps = {
  destination: MainDestination;
  projects: RecentProject[];
  activeProject: RecentProject | null;
  ui: UiSettings;
  dirty: boolean;
  notice: NoticeMessage | null;
  onDismissNotice: () => void;
  onDestination: (destination: "projects" | "exports") => void;
  onProject: (project: RecentProject) => void;
  onNode: (nodeId: NodeId) => void;
  onCloseNode: (nodeId: NodeId) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
};

export function AppShell(props: AppShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [nodeStatuses, setNodeStatuses] = useState<Partial<Record<NodeId, NodeStatus | "unavailable">>>({});
  const projectUi = props.activeProject ? props.ui.projects[props.activeProject.id] : undefined;
  const intentionalNodeEmpty = props.destination === "workspace" && props.activeProject && projectUi?.initialized && projectUi.activeNodeId === null;

  useEffect(() => {
    if (!props.notice?.dismissAfterMs) return;
    const timeout = window.setTimeout(props.onDismissNotice, props.notice.dismissAfterMs);
    return () => window.clearTimeout(timeout);
  }, [props.notice, props.onDismissNotice]);

  useEffect(() => {
    if (!nodePickerOpen || !props.activeProject) return;
    let cancelled = false;
    setNodeStatuses({});
    void Promise.allSettled(NODES.map(([id]) => getNode(props.activeProject!.id, id))).then((results) => {
      if (cancelled) return;
      setNodeStatuses(Object.fromEntries(results.map((result, index) => [NODES[index][0], result.status === "fulfilled" ? result.value.status : "unavailable"])));
    });
    return () => { cancelled = true; };
  }, [nodePickerOpen, props.activeProject]);

  function chooseProject(project: RecentProject) {
    setSearchOpen(false);
    props.onProject(project);
  }

  function chooseNode(nodeId: NodeId) {
    setSearchOpen(false);
    setNodePickerOpen(false);
    props.onNode(nodeId);
  }

  return (
    <div className={`app-shell ${props.ui.sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
      <Sidebar
        destination={props.destination}
        projects={props.projects}
        activeProject={props.activeProject}
        ui={props.ui}
        dirty={props.dirty}
        onDestination={props.onDestination}
        onProject={chooseProject}
        onNode={chooseNode}
        onCloseNode={props.onCloseNode}
        onToggle={props.onToggleSidebar}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={props.onOpenSettings}
        onOpenNodePicker={() => setNodePickerOpen(true)}
      />
      <main className="app-main">
        {props.ui.sidebarCollapsed ? (
          <div className="collapsed-shell-actions">
            <IconButton aria-label="展开侧边栏" onClick={props.onToggleSidebar}>›</IconButton>
            <IconButton aria-label="搜索项目和节点" onClick={() => setSearchOpen(true)}>⌕</IconButton>
          </div>
        ) : null}
        {intentionalNodeEmpty ? <EmptyState title="选择节点" description="从左侧已打开节点或“全部节点”中选择一个节点继续工作。" action={{ label: "选择节点", onClick: () => setNodePickerOpen(true) }} /> : props.children}
      </main>
      <div className="notice-viewport" aria-live="polite">
        {props.notice ? <Notice kind={props.notice.kind} onDismiss={props.onDismissNotice}>{props.notice.message}</Notice> : null}
      </div>
      <GlobalSearchDialog open={searchOpen} projects={props.projects} activeProject={props.activeProject} onClose={() => setSearchOpen(false)} onProject={chooseProject} onNode={chooseNode} />
      <NodePickerDialog open={nodePickerOpen} statuses={nodeStatuses} onClose={() => setNodePickerOpen(false)} onSelect={chooseNode} />
    </div>
  );
}
