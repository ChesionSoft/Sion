import { FileDiff } from "../ui";
import { lineDiffWithNumbers } from "../../export-diff";
import type { ExportArtifactKind, ExportProposedChange } from "../../types";

export type ArtifactDiffProps = {
  changes: ExportProposedChange[];
  selectedChangeIds: string[];
  onToggle: (changeId: string) => void;
  disabled?: boolean;
};

const TARGET_KIND_LABEL: Record<ExportArtifactKind, string> = {
  blueprint: "蓝图",
  formal_draft: "正式稿",
  qa_report: "QA 报告",
  formal_docx: "正式文档",
  project_design: "项目设计",
  spec: "规格",
  tasks: "任务",
  agents: "智能体",
};

function opSummary(op: ExportProposedChange["op"]): string {
  if ("blueprint" in op) {
    switch (op.blueprint.op) {
      case "update":
        return "更新章节";
      case "insert":
        return "插入章节";
      case "delete":
        return "删除章节";
      case "reorder":
        return "调整章节顺序";
    }
  }
  switch (op.draft.op) {
    case "replace":
      return "替换内容";
    case "insert":
      return "插入小节";
    case "delete":
      return "删除小节";
    case "reorder":
      return "调整小节顺序";
  }
}

/** Export review renders each proposed change as a selectable FileDiff card.
 * Selection stays checkbox-driven here; the diff card itself is shared with
 * conversation delivery inspection. */
export function ArtifactDiff({
  changes,
  selectedChangeIds,
  onToggle,
  disabled,
}: ArtifactDiffProps) {
  if (changes.length === 0) {
    return <p className="export-diff-empty">暂无修改建议。</p>;
  }
  return (
    <div className="export-diff">
      {changes.map((change, index) => (
        <FileDiff
          key={change.id}
          label={
            <span className="export-diff-file">
              <svg
                className="export-diff-icon"
                viewBox="0 0 24 24"
                width="15"
                height="15"
                aria-hidden="true"
              >
                <path
                  d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="export-diff-target">
                {TARGET_KIND_LABEL[change.targetKind]} · {opSummary(change.op)}
              </span>
            </span>
          }
          rows={lineDiffWithNumbers(change.before, change.after)}
          leadingControl={
            <label className="export-diff-select">
              <input
                type="checkbox"
                checked={selectedChangeIds.includes(change.id)}
                disabled={disabled}
                onChange={() => onToggle(change.id)}
              />
              <span>修改 {index + 1}</span>
            </label>
          }
        />
      ))}
    </div>
  );
}
