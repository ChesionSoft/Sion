import type { ProjectFile } from "../../types";
import { Button, EmptyState } from "../ui";

export function FilePoolWorkspace({
  files,
  selectedFileIds,
  importing,
  onImport,
  onToggleContext,
  onPreview,
}: {
  files: ProjectFile[];
  selectedFileIds: string[];
  importing: boolean;
  onImport: () => void;
  onToggleContext: (fileId: string) => void;
  onPreview: (fileId: string) => void;
}) {
  return (
    <section className="file-pool-workspace">
      <header><div><h2>文件池</h2><p>选择需要提供给当前节点 Agent 的本地文件。</p></div><Button variant="primary" loading={importing} onClick={onImport}>导入文件</Button></header>
      {files.length === 0 ? <EmptyState title="文件池为空" description="导入的文件会复制到当前项目，并仅通过受限文本预览读取。" action={{ label: "导入文件", onClick: onImport }} /> : (
        <div className="project-file-list">
          {files.map((file) => (
            <article key={file.id}>
              <label><input type="checkbox" checked={selectedFileIds.includes(file.id)} onChange={() => onToggleContext(file.id)} /><span><strong>{file.originalName}</strong><small>{file.extension.toUpperCase()} · {Math.max(1, Math.round(file.byteSize / 1024)).toLocaleString()} KB</small></span></label>
              <span className={`file-extraction-status is-${file.extractionStatus ?? "available"}`}>{file.extractionStatus === "failed" ? "提取失败" : file.extractionStatus === "unsupported" ? "仅文件" : file.truncated ? "文本已截断" : "文本可用"}</span>
              <Button variant="ghost" onClick={() => onPreview(file.id)}>预览</Button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
