import { NODES, type MainDestination, type NodeId, type RecentProject, type UiSettings } from "../../types";
import { IconButton, StatusDot } from "../ui";

type SidebarProps = {
  destination: MainDestination;
  projects: RecentProject[];
  activeProject: RecentProject | null;
  ui: UiSettings;
  dirty: boolean;
  onDestination: (destination: "projects" | "exports") => void;
  onProject: (project: RecentProject) => void;
  onNode: (nodeId: NodeId) => void;
  onCloseNode: (nodeId: NodeId) => void;
  onToggle: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenNodePicker: () => void;
};

const nodeTitle = new Map<NodeId, string>(NODES);

function ProjectGlyph() {
  return <span className="sidebar-glyph" aria-hidden="true">□</span>;
}

export function Sidebar({
  destination,
  projects,
  activeProject,
  ui,
  dirty,
  onDestination,
  onProject,
  onNode,
  onCloseNode,
  onToggle,
  onOpenSearch,
  onOpenSettings,
  onOpenNodePicker,
}: SidebarProps) {
  const projectUi = activeProject ? ui.projects[activeProject.id] : undefined;

  return (
    <aside className="sidebar" aria-label="Sion 导航">
      <div className="sidebar-titlebar">
        <strong>Sion</strong>
        <div>
          <IconButton aria-label="搜索项目和节点" onClick={onOpenSearch}>⌕</IconButton>
          <IconButton aria-label="收起侧边栏" onClick={onToggle}>‹</IconButton>
        </div>
      </div>

      <nav className="sidebar-primary" aria-label="主导航">
        <button className={destination === "projects" ? "sidebar-nav-item is-active" : "sidebar-nav-item"} onClick={() => onDestination("projects")} type="button">
          <span aria-hidden="true">⌂</span><span>项目</span>
        </button>
        <button className={destination === "exports" ? "sidebar-nav-item is-active" : "sidebar-nav-item"} onClick={() => onDestination("exports")} type="button">
          <span aria-hidden="true">⇩</span><span>导出中心</span>
        </button>
      </nav>

      <div className="sidebar-section-label"><span>项目</span><span>{projects.length}</span></div>
      <div className="sidebar-project-scroll">
        {projects.length === 0 ? <p className="sidebar-empty">尚无本地项目</p> : projects.map((item) => {
          const active = item.id === activeProject?.id;
          return (
            <div className="sidebar-project-group" key={item.id}>
              <button className={active ? "sidebar-project is-active" : "sidebar-project"} onClick={() => onProject(item)} type="button">
                <ProjectGlyph />
                <span>{item.name}</span>
                {active ? <span aria-hidden="true">›</span> : null}
              </button>
              {active && projectUi ? (
                <div className="sidebar-node-list" aria-label={`${item.name} 已打开节点`}>
                  {projectUi.openedNodeIds.map((id) => {
                    const selected = destination === "workspace" && projectUi.activeNodeId === id;
                    return (
                      <div className={selected ? "sidebar-node is-active" : "sidebar-node"} key={id}>
                        <button onClick={() => onNode(id)} type="button">
                          {selected && dirty ? <StatusDot kind="warning" label="有未保存修改" /> : <span className="sidebar-node-mark" aria-hidden="true">·</span>}
                          <span>{nodeTitle.get(id) ?? id}</span>
                        </button>
                        <IconButton aria-label={`关闭${nodeTitle.get(id) ?? id}`} onClick={() => onCloseNode(id)}>×</IconButton>
                      </div>
                    );
                  })}
                  <button className="sidebar-all-nodes" onClick={onOpenNodePicker} type="button"><span aria-hidden="true">＋</span> 全部节点</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-nav-item" onClick={onOpenSettings} type="button"><span aria-hidden="true">⚙</span><span>设置</span></button>
      </div>
    </aside>
  );
}
