import type { ProjectFile } from "../../types";
import { Button } from "../ui";

function FilePoolEmptyState({ importing, onImport }: { importing: boolean; onImport: () => void }) {
  return (
    <section className="file-pool-empty">
      <div className="file-pool-empty-panel">
        <span className="file-pool-empty-folder" aria-hidden="true">
          <svg viewBox="0 0 48 48" focusable="false">
            <path d="M5 14h14l4 5h20v19H5z" />
            <path d="M5 19h38" />
          </svg>
        </span>
        <h3>把项目资料放在这里</h3>
        <p>文件会复制到当前项目，仅提取受支持的文本供 Agent 使用。</p>
        <Button variant="primary" loading={importing} loadingLabel="正在导入…" onClick={onImport}>选择文件</Button>
        <div className="file-pool-empty-formats" aria-label="支持的文件格式">
          <span>PDF</span><span>DOCX</span><span>XLSX</span><span>MD</span><span>TXT</span>
        </div>
        <small className="file-pool-empty-privacy"><i aria-hidden="true" />本地保存 · 受限文本读取</small>
      </div>
    </section>
  );
}

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
      <header><div><h2>文件池</h2><p>选择需要提供给当前节点 Agent 的本地文件。</p></div>{files.length > 0 ? <Button variant="primary" loading={importing} onClick={onImport}>导入文件</Button> : null}</header>
      {files.length === 0 ? <FilePoolEmptyState importing={importing} onImport={onImport} /> : (
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
