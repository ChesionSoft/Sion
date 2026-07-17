import type { FilePreview, ProjectFile } from "../../types";
import { EmptyState } from "../ui";

export function FilePreviewTab({ file, preview }: { file: ProjectFile | null; preview: FilePreview | null }) {
  if (!file) return <EmptyState title="文件不可用" description="该文件已不在项目资料列表中，可以关闭此分页。" />;
  if (file.extractionStatus === "failed") return <EmptyState title="文本提取失败" description={file.extractionError ?? "Sion 无法从此文件提取可预览文本。"} />;
  if (file.extractionStatus === "unsupported") return <EmptyState title="此格式不支持文本预览" description="文件仍保存在项目中，但不会通过 iframe、网页或外部地址打开。" />;

  return (
    <section className="file-preview-tab">
      <header><h2>{file.originalName}</h2><p>{file.mimeType} · {file.characterCount?.toLocaleString() ?? "-"} 字符{preview?.truncated || file.truncated ? " · 预览已截断" : ""}</p></header>
      {preview?.text ? <pre>{preview.text}</pre> : <div className="file-preview-loading">正在读取受限文本预览…</div>}
    </section>
  );
}
