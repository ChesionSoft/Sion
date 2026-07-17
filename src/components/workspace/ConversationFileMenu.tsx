import { useEffect, useRef, useState } from "react";
import type { ProjectFile } from "../../types";

export function ConversationFileMenu(props: {
  files: ProjectFile[];
  selectedFileIds: string[];
  disabled: boolean;
  importing: boolean;
  onToggle: (fileId: string) => void;
  onImport: () => Promise<ProjectFile | null>;
}) {
  const { files, selectedFileIds, disabled, importing, onToggle, onImport } = props;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  async function handleImport() {
    const file = await onImport();
    if (file && file.extractionStatus === "available" && !selectedFileIds.includes(file.id)) {
      onToggle(file.id);
    }
  }

  return (
    <div className="conversation-file-menu" ref={containerRef}>
      <button
        type="button"
        className="conversation-file-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        文件（{selectedFileIds.length}）
      </button>
      {open ? (
        <div className="conversation-file-panel" role="menu">
          <button type="button" role="menuitem" disabled={disabled || importing} onClick={() => void handleImport()}>
            {importing ? "导入中…" : "导入新文件"}
          </button>
          <div className="conversation-file-list">
            {files.map((file) => {
              const selectable = file.extractionStatus === "available";
              const checked = selectedFileIds.includes(file.id);
              return (
                <label key={file.id} className={selectable ? "" : "is-disabled"}>
                  <input type="checkbox" checked={checked} disabled={!selectable} onChange={() => onToggle(file.id)} />
                  {file.originalName}
                  {!selectable ? <span>（{file.extractionStatus === "unsupported" ? "不支持的格式" : "提取失败"}）</span> : null}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
