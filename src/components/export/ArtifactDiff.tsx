import { lineDiff, type DiffLine } from "../../export-diff";
import type { ExportProposedChange } from "../../types";

export type ArtifactDiffProps = {
  changes: ExportProposedChange[];
  selectedChangeIds: string[];
  onToggle: (changeId: string) => void;
  disabled?: boolean;
};

function DiffLineRow({ line }: { line: DiffLine }) {
  const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
  return (
    <span className={`export-diff-line is-${line.kind}`}>
      {marker} {line.text}
      {"\n"}
    </span>
  );
}

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
      {changes.map((change, index) => {
        const lines = lineDiff(change.before, change.after);
        const selected = selectedChangeIds.includes(change.id);
        return (
          <div key={change.id} className="export-diff-change">
            <label className="export-diff-change-header">
              <input
                type="checkbox"
                checked={selected}
                disabled={disabled}
                onChange={() => onToggle(change.id)}
              />
              <span>修改 {index + 1}</span>
            </label>
            <pre className="export-diff-lines">
              {lines.map((line, index_) => (
                <DiffLineRow key={index_} line={line} />
              ))}
            </pre>
          </div>
        );
      })}
    </div>
  );
}