import type { FilePreviewPaneProps } from "../types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Right-side attachment pane. The list offers Agent-context checkboxes and a
// per-file preview action; selecting a file loads its bounded extracted text
// (never an iframe, webview, or filesystem URL). At compact widths the pane
// becomes a drawer toggled by `data-open`.
export function FilePreviewPane({ files, selectedFileIds, preview, importing, isFileDrawerOpen, onImport, onSelectPreview, onToggleContext }: FilePreviewPaneProps) {
  return (
    <aside className="file-preview-pane" data-open={isFileDrawerOpen === false ? "false" : "true"}>
      <div className="file-preview-list">
        <div className="file-head"><span>文件池 / {files.length}</span><button disabled={importing} onClick={onImport} type="button">{importing ? "导入中" : "+ 导入"}</button></div>
        {files.length === 0
          ? <small>尚无项目文件</small>
          : files.map((file) => (
            <div className="file-row" key={file.id}>
              <label><input checked={selectedFileIds.includes(file.id)} disabled={file.extractionStatus !== "available"} onChange={() => onToggleContext(file.id)} type="checkbox" /> {file.extractionStatus === "available" ? "◼" : "◇"} {file.originalName}</label>
              {onSelectPreview ? <button className="file-preview-select" onClick={() => onSelectPreview(file.id)} type="button">预览</button> : null}
            </div>
          ))}
      </div>
      <div className="file-preview-body">
        {!preview
          ? <p className="file-preview-empty">选择文件后在这里查看本地提取文本。</p>
          : !preview.text
            ? <p className="file-preview-unavailable">{preview.file.extractionStatus === "failed" ? preview.file.extractionError : "该文件没有可预览的提取文本。"}</p>
            : (
              <>
                <header>{preview.file.originalName}</header>
                <p>{preview.file.extension} · {formatBytes(preview.file.byteSize)} · {preview.file.extractionStatus === "available" ? "已提取" : "不可提取"}</p>
                <pre>{preview.text}</pre>
                {preview.truncated ? <p className="file-preview-truncated">仅显示前 24,000 个字符</p> : null}
              </>
            )}
      </div>
    </aside>
  );
}
