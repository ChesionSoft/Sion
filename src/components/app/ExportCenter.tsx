import type { RecentProject } from "../../types";
import { Button, EmptyState, SelectField, StatusDot } from "../ui";

export type ExportResult =
  | { status: "success"; projectId: string; path: string }
  | { status: "cancelled"; projectId: string }
  | { status: "error"; projectId: string; message: string };

export function ExportCenter({ projects, selectedProjectId, exporting, lastResult, onSelect, onExport }: {
  projects: RecentProject[];
  selectedProjectId: string | null;
  exporting: boolean;
  lastResult: ExportResult | null;
  onSelect: (projectId: string) => void;
  onExport: (projectId: string) => void;
}) {
  if (projects.length === 0) {
    return (
      <section className="export-center">
        <header className="export-center-header"><p>导出</p><h1>导出中心</h1></header>
        <EmptyState title="还没有可导出的项目" description="先在项目页创建或发现一个本地项目，然后回到这里导出 DOCX。" />
      </section>
    );
  }

  const selected = projects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId!
    : projects[0].id;
  const selectedProject = projects.find((project) => project.id === selected)!;
  const visibleResult = lastResult?.projectId === selected ? lastResult : null;

  return (
    <section className="export-center">
      <header className="export-center-header">
        <p>导出</p>
        <h1>导出中心</h1>
        <span>将本地项目的 12 个设计节点整理为一个 DOCX 文档。</span>
      </header>
      <div className="export-center-content">
        <SelectField label="项目" value={selected} disabled={exporting} onChange={(event) => onSelect(event.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </SelectField>

        <section className="export-format-row" aria-labelledby="docx-format-title">
          <div className="export-format-icon" aria-hidden="true">W</div>
          <div>
            <strong id="docx-format-title">Microsoft Word 文档</strong>
            <small>DOCX · 包含项目清单与全部设计节点</small>
          </div>
          <span>可用</span>
        </section>

        <div className="export-center-action">
          <div>
            <strong>{selectedProject.name}</strong>
            <small>系统将在导出时询问本机保存位置。</small>
          </div>
          <Button variant="primary" loading={exporting} loadingLabel="正在导出…" onClick={() => onExport(selected)}>导出 DOCX</Button>
        </div>

        {exporting ? (
          <div className="export-result" role="status"><StatusDot kind="running" /><div><strong>正在生成 DOCX</strong><small>请选择保存位置并等待本机写入完成。</small></div></div>
        ) : visibleResult ? (
          <div className="export-result" role="status">
            <StatusDot kind={visibleResult.status === "success" ? "success" : visibleResult.status === "error" ? "error" : "warning"} />
            <div>
              <strong>{visibleResult.status === "success" ? "导出完成" : visibleResult.status === "cancelled" ? "已取消导出" : "导出失败"}</strong>
              <small>{visibleResult.status === "success" ? visibleResult.path : visibleResult.status === "cancelled" ? "没有写入任何文件。" : visibleResult.message}</small>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
