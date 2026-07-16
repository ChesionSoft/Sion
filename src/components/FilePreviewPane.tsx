import type { FilePreviewPaneProps } from "../types";

// Attachment list with Agent-context checkboxes. Task 5 preserves the existing
// node-rail file pool; Task 7 expands this into the right-side preview pane with
// bounded extracted text, metadata, and click-to-preview (no iframe/webview).
export function FilePreviewPane({ files, selectedFileIds, importing, onImport, onToggleContext }: FilePreviewPaneProps) {
  return (
    <div className="rail-foot">
      <div className="file-head"><span>文件池 / {files.length}</span><button disabled={importing} onClick={onImport} type="button">{importing ? "导入中" : "+ 导入"}</button></div>
      {files.length === 0 ? <small>尚无项目文件</small> : files.slice(-3).map((file) => (
        <label className="file-row" key={file.id}>
          <input checked={selectedFileIds.includes(file.id)} disabled={file.extractionStatus !== "available"} onChange={() => onToggleContext(file.id)} type="checkbox" /> {file.extractionStatus === "available" ? "◼" : "◇"} {file.originalName}
        </label>
      ))}
    </div>
  );
}
