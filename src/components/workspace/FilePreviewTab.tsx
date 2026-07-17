import type { FilePreview, ProjectFile } from "../../types";
import { Button, EmptyState } from "../ui";

export function FilePreviewTab({ file, preview, onBack }: { file: ProjectFile | null; preview: FilePreview | null; onBack: () => void }) {
  if (!file) return <EmptyState title="文件不可用" description="该文件已不在文件池中。" action={{ label: "返回文件池", onClick: onBack }} />;
  if (file.extractionStatus === "failed") return <EmptyState title="文本提取失败" description={file.extractionError ?? "Sion 无法从此文件提取可预览文本。"} action={{ label: "返回文件池", onClick: onBack }} />;
  if (file.extractionStatus === "unsupported") return <EmptyState title="此格式不支持文本预览" description="文件仍保存在项目中，但不会通过 iframe、网页或外部地址打开。" action={{ label: "返回文件池", onClick: onBack }} />;

  return (
    <section className="file-preview-tab">
      <header><div><h2>{file.originalName}</h2><p>{file.mimeType} · {file.characterCount?.toLocaleString() ?? "-"} 字符{preview?.truncated || file.truncated ? " · 预览已截断" : ""}</p></div><Button variant="ghost" onClick={onBack}>返回文件池</Button></header>
      {preview?.text ? <pre>{preview.text}</pre> : <div className="file-preview-loading">正在读取受限文本预览…</div>}
    </section>
  );
}
