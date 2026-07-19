import { Button } from "../ui";
import type { ExportApproval, ExportArtifactSummary } from "../../types";

export type BlueprintPreparationBarProps = {
  blueprint: ExportArtifactSummary;
  approval: ExportApproval | null;
  selected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onReview?: () => void;
  onApprove?: () => void;
  canApprove?: boolean;
};

export function BlueprintPreparationBar({
  blueprint,
  approval,
  selected,
  onSelect,
  onEdit,
  onReview,
  onApprove,
  canApprove,
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
        {onEdit ? <Button variant="ghost" onClick={onEdit}>编辑</Button> : null}
        {onReview ? <Button variant="ghost" onClick={onReview}>评审</Button> : null}
        {onApprove ? (
          <Button variant="primary" onClick={onApprove} disabled={!canApprove}>
            批准
          </Button>
        ) : null}
      </div>
    </section>
  );
}