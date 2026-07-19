import { useMemo, useState } from "react";
import type { RecentProject } from "../../types";
import { filterAndSortProjects, type ProjectSort } from "../../ui-state";
import { EmptyState, Field, Icon, Popover, SelectField } from "../ui";

export type ExportProjectListProps = {
  projects: RecentProject[];
  projectsDirectory: string | null;
  onOpenProject: (projectId: string) => void;
  onRevealExportFolder: (projectId: string) => void;
  onOpenSettings: () => void;
  onGoToProjects: () => void;
};

function openedAtLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "打开时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function ExportProjectList({
  projects,
  projectsDirectory,
  onOpenProject,
  onRevealExportFolder,
  onOpenSettings,
  onGoToProjects,
}: ExportProjectListProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("recent");
  const visibleProjects = useMemo(
    () => filterAndSortProjects(projects, query, sort),
    [projects, query, sort],
  );

  return (
    <section className="export-center export-project-list-page">
      <header className="project-home-header">
        <div>
          <p>导出</p>
          <h1>选择要导出的项目</h1>
          <span>{projects.length} 个本地项目</span>
        </div>
      </header>

      {!projectsDirectory ? (
        <EmptyState
          title="项目目录尚未设置"
          description="选择一个目录后，Sion 才能发现本地项目并导出。"
          action={{ label: "打开设置", onClick: onOpenSettings }}
        />
      ) : projects.length === 0 ? (
        <EmptyState
          title="还没有可导出的项目"
          description="先在项目页创建或发现一个本地项目，然后回到这里生成导出蓝图与正式交付物。"
          action={{ label: "前往项目", onClick: onGoToProjects }}
        />
      ) : (
        <>
          <div className="project-home-toolbar">
            <Field
              label="搜索项目"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按名称搜索"
            />
            <SelectField
              label="排序"
              value={sort}
              onChange={(event) => setSort(event.target.value as ProjectSort)}
            >
              <option value="recent">最近打开</option>
              <option value="name">项目名称</option>
            </SelectField>
          </div>
          {visibleProjects.length === 0 ? (
            <EmptyState
              title="没有匹配的项目"
              description="换一个关键词，或清空搜索条件查看全部项目。"
              action={{ label: "清空搜索", onClick: () => setQuery("") }}
            />
          ) : (
            <div className="project-list" role="list">
              {visibleProjects.map((item) => (
                <article className="project-list-row" role="listitem" key={item.id}>
                  <button
                    className="project-row-open"
                    type="button"
                    onClick={() => onOpenProject(item.id)}
                  >
                    <span className="project-row-symbol" aria-hidden="true">
                      <Icon name="project-document" size={18} />
                    </span>
                    <span className="project-row-name">
                      <strong>{item.name}</strong>
                      <small>点击进入导出工作台</small>
                    </span>
                    <span className="project-row-state">
                      <strong>本地项目</strong>
                      <small>导出中心</small>
                    </span>
                    <span className="project-row-time">
                      <strong>{openedAtLabel(item.openedAt)}</strong>
                      <small>最近打开</small>
                    </span>
                  </button>
                  <Popover label={`${item.name} 更多操作`} trigger={<span aria-hidden="true">•••</span>}>
                    <button
                      className="project-menu-action"
                      type="button"
                      onClick={() => onRevealExportFolder(item.id)}
                    >
                      打开导出文件夹
                    </button>
                  </Popover>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
