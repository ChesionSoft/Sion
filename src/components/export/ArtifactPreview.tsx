import type { ExportArtifactContent } from "../../types";
import { SafeMarkdown } from "../workspace/SafeMarkdown";

export type ArtifactPreviewProps = {
  content: ExportArtifactContent | null;
  loading: boolean;
  label: string | null;
};

export function ArtifactPreview({ content, loading, label }: ArtifactPreviewProps) {
  if (loading) {
    return <div className="export-preview-empty">正在加载{label ? `「${label}」` : ""}内容…</div>;
  }
  if (!content) {
    return <div className="export-preview-empty">选择左侧产物查看内容预览。</div>;
  }
  if (content.kind === "empty") {
    return <div className="export-preview-empty">该产物尚未生成，暂无内容。</div>;
  }
  if (content.kind === "error") {
    return <div className="export-preview-error">{content.message}</div>;
  }
  if (content.kind === "markdown") {
    return <SafeMarkdown markdown={content.markdown} variant="document" />;
  }
  if (content.kind === "source") {
    return <SafeMarkdown markdown={content.markdown} variant="document" />;
  }
  // docx_html: the only HTML accepted here is the sanitized backend response.
  return (
    <>
      <div className="export-preview-warning">
        当前为内容预览。封面、目录、页眉页脚和分页请另存后在 Word 或 WPS 中查看。
      </div>
      <div
        className="export-docx-preview"
        // content.html is produced and sanitized by the Rust preview service;
        // it only contains a fixed allowlist of tags. No URL, iframe, object,
        // embed, or webview is introduced here.
        dangerouslySetInnerHTML={{ __html: content.html }}
      />
    </>
  );
}