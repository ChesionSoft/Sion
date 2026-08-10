import type { ReactNode } from "react";
import type { NumberedDiffLine } from "../../export-diff";

export type FileDiffProps = {
  /** Title shown in the card head, e.g. a file or target name. */
  label: ReactNode;
  /** Numbered add/remove/context rows in presentation order. */
  rows: NumberedDiffLine[];
  /** Optional read-only or interactive control rendered at the head start
   * (e.g. the Export Center selection checkbox). Omit for pure read-only use. */
  leadingControl?: ReactNode;
  /** Extra class on the card, for surface-specific sizing. */
  className?: string;
};

/** AIcss-style line-numbered diff card shared by Export Center review and
 * conversation delivery inspection. Rendering is read-only unless the caller
 * supplies a `leadingControl`; row add/remove/context semantics, line numbers,
 * and tints live in one place. */
export function FileDiff({ label, rows, leadingControl, className }: FileDiffProps) {
  const added = rows.filter((row) => row.kind === "add").length;
  const removed = rows.filter((row) => row.kind === "remove").length;
  return (
    <div className={`file-diff-card${className ? ` ${className}` : ""}`}>
      <div className="file-diff-head">
        {leadingControl ? <div className="file-diff-control">{leadingControl}</div> : null}
        <div className="file-diff-label">{label}</div>
        <div className="file-diff-stat" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
          <span className="is-add">+{added}</span>
          <span className="is-del">-{removed}</span>
        </div>
      </div>
      <div className="file-diff-body">
        {rows.map((row, index) => (
          <div key={index} className={`file-diff-row is-${row.kind}`}>
            <span className="file-diff-ln is-old">{row.oldLine ?? ""}</span>
            <span className="file-diff-ln is-new">{row.newLine ?? ""}</span>
            <span className="file-diff-sign" aria-hidden="true">
              {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : ""}
            </span>
            <code className="file-diff-code">{row.text || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
