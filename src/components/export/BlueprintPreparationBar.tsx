import { Button } from "../ui";
import type { ExportApproval, ExportArtifactSummary } from "../../types";

export type BlueprintPreparationBarProps = {
  blueprint: ExportArtifactSummary;
  approval: ExportApproval | null;
  selected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onRegenerate?: () => void;
  onReview?: () => void;
  onApprove?: () => void;
  canApprove?: boolean;
  actionsDisabled?: boolean;
};

export function BlueprintPreparationBar({
  blueprint,
  approval,
  selected,
  onSelect,
  onEdit,
  onRegenerate,
  onReview,
  onApprove,
  canApprove,
  actionsDisabled,
}: BlueprintPreparationBarProps) {
  const tag = !blueprint.available
    ? { label: "未生成", className: "" }
    : approval
      ? { label: "已批准", className: "is-approved" }
      : blueprint.stale
        ? { label: "已变化", className: "is-stale" }
        : { label: "待批准", className: "" };
  return (
    <section
      className="export-blueprint-bar"
      aria-label="导出蓝图准备材料"
      data-selected={selected || undefined}
    >
      <div className="export-blueprint-bar-label">
        <strong>准备材料 · 导出蓝图</strong>
        <small>{blueprint.available ? "蓝图已生成，供正式正文使用。" : "尚未生成导出蓝图。"}</small>
      </div>
      <span className={`export-blueprint-bar-tag ${tag.className}`.trim()}>{tag.label}</span>
      <div className="export-blueprint-bar-actions">
        <Button variant={selected ? "secondary" : "ghost"} onClick={onSelect}>
          {selected ? "查看中" : "查看"}
        </Button>
        {onEdit ? (
          <Button variant="ghost" onClick={onEdit} disabled={actionsDisabled}>
            编辑
          </Button>
        ) : null}
        {onRegenerate ? (
          <Button variant="ghost" onClick={onRegenerate} disabled={actionsDisabled}>
            重新生成
          </Button>
        ) : null}
        {onReview ? (
          <Button variant="ghost" onClick={onReview} disabled={actionsDisabled}>
            评审
          </Button>
        ) : null}
        {onApprove ? (
          <Button
            variant="primary"
            onClick={onApprove}
            disabled={!canApprove || actionsDisabled}
          >
            批准
          </Button>
        ) : null}
      </div>
    </section>
  );
}