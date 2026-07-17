import { useMemo, useState } from "react";
import { NODES, type NodeId, type RecentProject } from "../../types";
import { Dialog, Field } from "../ui";

export function GlobalSearchDialog({
  open,
  projects,
  activeProject,
  onClose,
  onProject,
  onNode,
}: {
  open: boolean;
  projects: RecentProject[];
  activeProject: RecentProject | null;
  onClose: () => void;
  onProject: (project: RecentProject) => void;
  onNode: (nodeId: NodeId) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const projectRows = useMemo(() => projects.filter((item) => !normalized || item.name.toLocaleLowerCase("zh-CN").includes(normalized)), [normalized, projects]);
  const nodeRows = useMemo(() => activeProject ? NODES.filter(([id, title]) => !normalized || id.includes(normalized) || title.toLocaleLowerCase("zh-CN").includes(normalized)) : [], [activeProject, normalized]);

  return (
    <Dialog open={open} title="搜索" description="查找所有项目和当前项目的节点。" size="medium" closeLabel="关闭搜索" onClose={onClose}>
      <div className="global-search">
        <Field label="搜索项目和节点" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入名称" autoFocus />
        <section>
          <h3>项目</h3>
          <div className="search-result-list">
            {projectRows.map((item) => <button key={item.id} onClick={() => onProject(item)} type="button"><span aria-hidden="true">□</span><span><strong>{item.name}</strong><small>{item.rootPath}</small></span></button>)}
            {projectRows.length === 0 ? <p>没有匹配的项目</p> : null}
          </div>
        </section>
        {activeProject ? (
          <section>
            <h3>{activeProject.name} · 节点</h3>
            <div className="search-result-list">
              {nodeRows.map(([id, title]) => <button key={id} onClick={() => onNode(id)} type="button"><span aria-hidden="true">·</span><span><strong>{title}</strong><small>{id}</small></span></button>)}
              {nodeRows.length === 0 ? <p>没有匹配的节点</p> : null}
            </div>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
