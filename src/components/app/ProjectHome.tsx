import { useMemo, useState } from "react";
import { NODES, type AppSettings, type RecentProject } from "../../types";
import { filterAndSortProjects, type ProjectSort } from "../../ui-state.ts";
import { Button, EmptyState, Field, Icon, Popover, SelectField } from "../ui";
import { NewProjectDialog } from "./NewProjectDialog";

type ProjectHomeProps = {
  projects: RecentProject[];
  settings: AppSettings;
  hasProvider: boolean;
  creating: boolean;
  notice: string | null;
  onOpen: (project: RecentProject) => void;
  onReveal: (projectId: string) => void;
  onCreate: (name: string, customer: string, author: string) => Promise<boolean>;
  onOpenSettings: () => void;
};

const nodeNames = new Map(NODES);

function openedAtLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "打开时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function ProjectHome({
  projects,
  settings,
  hasProvider,
  creating,
  notice,
  onOpen,
  onReveal,
  onCreate,
  onOpenSettings,
}: ProjectHomeProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("recent");
  const [creationOpen, setCreationOpen] = useState(false);
  const visibleProjects = useMemo(() => filterAndSortProjects(projects, query, sort), [projects, query, sort]);

  return (
    <section className="project-home">
      <header className="project-home-header">
        <div><p>项目</p><h1>所有项目</h1><span>{projects.length} 个本地项目</span></div>
        <Button variant="primary" onClick={() => setCreationOpen(true)} disabled={!settings.projectsDirectory} loading={creating}>＋ 新建项目</Button>
      </header>

      {!hasProvider ? <div className="project-home-quiet-notice"><span aria-hidden="true">i</span><p>尚未配置模型连接；本地编辑与保存仍可正常使用。可稍后前往设置。</p></div> : null}
      {notice ? <div className="project-home-quiet-notice"><span aria-hidden="true">i</span><p>{notice}</p></div> : null}

      {settings.projectsDirectory ? (
        <>
          <div className="project-home-toolbar">
            <Field label="搜索项目" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称搜索" />
            <SelectField label="排序" value={sort} onChange={(event) => setSort(event.target.value as ProjectSort)}>
              <option value="recent">最近打开</option>
              <option value="name">项目名称</option>
            </SelectField>
          </div>
          {projects.length === 0 ? (
            <EmptyState title="还没有项目" description="创建第一份本地设计文档，项目会保存在你设置的目录中。" action={{ label: "新建项目", onClick: () => setCreationOpen(true) }} />
          ) : visibleProjects.length === 0 ? (
            <EmptyState title="没有匹配的项目" description="换一个关键词，或清空搜索条件查看全部项目。" action={{ label: "清空搜索", onClick: () => setQuery("") }} />
          ) : (
            <div className="project-list" role="list">
              {visibleProjects.map((item) => {
                const projectUi = settings.ui.projects[item.id];
                const activeNode = projectUi?.activeNodeId ? nodeNames.get(projectUi.activeNodeId) : null;
                return (
                  <article className="project-list-row" role="listitem" key={item.id}>
                    <button className="project-row-open" onClick={() => onOpen(item)} type="button">
                      <span className="project-row-symbol" aria-hidden="true"><Icon name="project-document" size={18} /></span>
                      <span className="project-row-name"><strong>{item.name}</strong><small>{activeNode ? `上次节点：${activeNode}` : "尚未打开节点"}</small></span>
                      <span className="project-row-state"><strong>{projectUi?.openedNodeIds.length ?? 0} 个已打开节点</strong><small>本地项目</small></span>
                      <span className="project-row-time"><strong>{openedAtLabel(item.openedAt)}</strong><small>最近打开</small></span>
                    </button>
                    <Popover label={`${item.name} 更多操作`} trigger={<span aria-hidden="true">•••</span>}>
                      <button className="project-menu-action" onClick={() => onReveal(item.id)} type="button">在文件管理器中显示</button>
                    </Popover>
                  </article>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <EmptyState title="项目目录尚未设置" description="选择一个目录后，Sion 才能创建并发现本地项目。" action={{ label: "打开设置", onClick: onOpenSettings }} />
      )}

      <NewProjectDialog open={creationOpen} projectsDirectory={settings.projectsDirectory} creating={creating} onClose={() => setCreationOpen(false)} onCreate={onCreate} onOpenSettings={onOpenSettings} />
    </section>
  );
}
