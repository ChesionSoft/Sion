import type { ExportArtifactKind, ExportArtifactSummary } from "../../types";
import { exportArtifactGroups, type ExportArtifactGroup } from "../../export-state";

export const EXPORT_ARTIFACT_LABELS: Record<ExportArtifactKind, string> = {
  blueprint: "导出蓝图",
  formal_draft: "正式正文",
  qa_report: "Word QA 报告",
  formal_docx: "正式 Word",
  project_design: "PROJECT_DESIGN",
  spec: "SPEC",
  tasks: "TASKS",
  agents: "AGENTS",
};

export type ArtifactNavigatorProps = {
  artifacts: ExportArtifactSummary[];
  selectedKind: ExportArtifactKind | null;
  onSelect: (kind: ExportArtifactKind) => void;
};

export function ArtifactNavigator({ artifacts, selectedKind, onSelect }: ArtifactNavigatorProps) {
  const groups: ExportArtifactGroup[] = exportArtifactGroups(artifacts);
  return (
    <nav className="export-navigator" aria-label="导出交付产物">
      {groups.map((group) => (
        <div key={group.id} className="export-navigator-group">
          <p className="export-navigator-group-title">
            {group.id === "engineering" ? "工程附件" : group.label}
          </p>
          {group.items.map((item) => {
            const disabled = !item.available;
            return (
              <button
                key={item.kind}
                type="button"
                className={`export-navigator-item${item.kind === selectedKind ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}
                disabled={disabled}
                onClick={() => onSelect(item.kind)}
              >
                <strong>{EXPORT_ARTIFACT_LABELS[item.kind]}</strong>
                <small>{item.available ? `修订 ${item.revision}` : "未生成"}</small>
                {item.stale ? <span className="export-navigator-item-tag is-stale">基于旧版本</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}