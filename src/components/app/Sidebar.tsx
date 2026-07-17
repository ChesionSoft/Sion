import { useEffect, useState } from "react";
import { type MainDestination, type NodeId, type RecentProject, type UiSettings } from "../../types";
import { IconButton, Icon } from "../ui";
import { PRIMARY_NAV_ITEMS, WORKSPACE_NODE_ROWS } from "../../workspace-config";

type SidebarProps = {
  destination: MainDestination;
  projects: RecentProject[];
  activeProject: RecentProject | null;
  ui: UiSettings;
  onDestination: (destination: "projects" | "exports") => void;
  onProject: (project: RecentProject) => void;
  onNode: (nodeId: NodeId) => void;
  onToggle: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
};

export function Sidebar({
  destination,
  projects,
  activeProject,
  ui,
  onDestination,
  onProject,
  onNode,
  onToggle,
  onOpenSearch,
  onOpenSettings,
}: SidebarProps) {
  const projectUi = activeProject ? ui.projects[activeProject.id] : undefined;
  const [nodesCollapsed, setNodesCollapsed] = useState(false);

  useEffect(() => {
    setNodesCollapsed(false);
  }, [activeProject?.id]);

  return (
    <aside className="sidebar" aria-label="Sion 导航">
      <div className="sidebar-titlebar">
        <strong>Sion</strong>
        <div>
          <IconButton aria-label="搜索项目和节点" onClick={onOpenSearch}><Icon name="search" /></IconButton>
          <IconButton aria-label="收起侧边栏" onClick={onToggle}><Icon name="sidebar-collapse" /></IconButton>
        </div>
      </div>

      <nav className="sidebar-primary" aria-label="主导航">
        {PRIMARY_NAV_ITEMS.map((item) => (
          <button
            className={destination === item.id ? "sidebar-nav-item is-active" : "sidebar-nav-item"}
            key={item.id}
            onClick={() => onDestination(item.id)}
            type="button"
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-section-label"><span>项目</span><span>{projects.length}</span></div>
      <div className="sidebar-project-scroll">
        {projects.length === 0 ? <p className="sidebar-empty">尚无本地项目</p> : projects.map((item) => {
          const active = item.id === activeProject?.id;
          return (
            <div className="sidebar-project-group" key={item.id}>
              <div className="sidebar-project-row">
                <button className={active ? "sidebar-project is-active" : "sidebar-project"} onClick={() => onProject(item)} type="button">
                  <Icon name="project-document" />
                  <span>{item.name}</span>
                </button>
                {active ? (
                  <IconButton
                    aria-label={nodesCollapsed ? `展开${item.name}节点` : `折叠${item.name}节点`}
                    onClick={() => setNodesCollapsed((value) => !value)}
                  >
                    <Icon name={nodesCollapsed ? "sidebar-expand" : "sidebar-collapse"} />
                  </IconButton>
                ) : null}
              </div>
              {active && projectUi ? (
                <div
                  className="sidebar-node-list"
                  aria-label={item.name + " 工作流节点"}
                  hidden={nodesCollapsed}
                >
                  {WORKSPACE_NODE_ROWS.map(([id, title]) => {
                    const selected = destination === "workspace" && projectUi.activeNodeId === id;
                    return (
                      <button
                        aria-current={selected ? "page" : undefined}
                        className={selected ? "sidebar-node is-active" : "sidebar-node"}
                        key={id}
                        onClick={() => onNode(id)}
                        type="button"
                      >
                        {title}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-nav-item" onClick={onOpenSettings} type="button"><Icon name="settings" /><span>设置</span></button>
      </div>
    </aside>
  );
}
