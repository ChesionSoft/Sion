import { Button } from "../ui";
import type { ExportArtifactContent } from "../../types";
import { SafeMarkdown } from "../workspace/SafeMarkdown";

export type ArtifactPreviewProps = {
  content: ExportArtifactContent | null;
  loading: boolean;
  label: string | null;
  canEdit: boolean;
  editing: boolean;
  editBuffer: string;
  editError: string | null;
  onEditBufferChange: (value: string) => void;
  onEditStart: () => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onRegenerate?: () => void;
  onSaveAs?: () => void;
  actionsDisabled?: boolean;
};

export function ArtifactPreview({
  content,
  loading,
  label,
  canEdit,
  editing,
  editBuffer,
  editError,
  onEditBufferChange,
  onEditStart,
  onEditSave,
  onEditCancel,
  onRegenerate,
  onSaveAs,
  actionsDisabled,
}: ArtifactPreviewProps) {
  if (editing) {
    return (
      <div className="export-preview-editor">
        <textarea
          className="export-preview-textarea"
          value={editBuffer}
          onChange={(event) => onEditBufferChange(event.target.value)}
          rows={24}
        />
        {editError ? <p className="export-preview-error">{editError}</p> : null}
        <div className="export-preview-editor-actions">
          <Button variant="primary" onClick={onEditSave}>
            保存
          </Button>
          <Button variant="ghost" onClick={onEditCancel}>
            取消
          </Button>
        </div>
      </div>
    );
  }

  const toolbar =
    canEdit || onRegenerate || onSaveAs ? (
      <div className="export-preview-toolbar">
        {canEdit ? (
          <Button variant="ghost" onClick={onEditStart} disabled={actionsDisabled}>
            编辑
          </Button>
        ) : null}
        {onRegenerate ? (
          <Button variant="ghost" onClick={onRegenerate} disabled={actionsDisabled}>
            重新生成
          </Button>
        ) : null}
        {onSaveAs ? (
          <Button variant="secondary" onClick={onSaveAs} disabled={actionsDisabled}>
            另存为
          </Button>
        ) : null}
      </div>
    ) : null;

  if (loading) {
    return (
      <>
        {toolbar}
        <div className="export-preview-empty">
          正在加载{label ? `「${label}」` : ""}内容…
        </div>
      </>
    );
  }
  if (!content) {
    return (
      <>
        {toolbar}
        <div className="export-preview-empty">选择左侧产物查看内容预览。</div>
      </>
    );
  }
  if (content.kind === "empty") {
    return (
      <>
        {toolbar}
        <div className="export-preview-empty">该产物尚未生成，暂无内容。</div>
      </>
    );
  }
  if (content.kind === "error") {
    return (
      <>
        {toolbar}
        <div className="export-preview-error">{content.message}</div>
      </>
    );
  }
  if (content.kind === "markdown" || content.kind === "source") {
    return (
      <>
        {toolbar}
        <SafeMarkdown markdown={content.markdown} variant="document" />
      </>
    );
  }
  // docx_html: the only HTML accepted here is the sanitized backend response.
  return (
    <>
      {toolbar}
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