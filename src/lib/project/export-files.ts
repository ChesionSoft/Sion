/**
 * The fixed set of files produced by the staged export workflow (see
 * exports.ts). Used by `ProjectStore.listExports` (which files to stat) and by
 * the `[filename]` route (the whitelist that gates file serving). Keeping the
 * list in one place keeps the store and the route in sync and is the security
 * boundary that prevents path traversal via the dynamic filename segment.
 *
 * The formal-PRD artifacts come first (blueprint, draft, QA report, formal
 * Word); the internal Markdown exports follow. `formal-prd-state.json` is
 * persisted in the same directory but is intentionally NOT in this list, so it
 * is never served or listed.
 */
export const EXPORT_FILENAMES = [
  "export-blueprint.md",
  "formal-prd-draft.md",
  "formal-prd-qa-report.md",
  "项目开发设计文档.docx",
  "PROJECT_DESIGN.md",
  "SPEC.md",
  "TASKS.md",
  "AGENTS.md",
] as const;

export type ExportFilename = (typeof EXPORT_FILENAMES)[number];

export type ExportFileInfo = {
  filename: ExportFilename;
  size: number;
  mtime: number;
};

export function isExportFilename(filename: string): filename is ExportFilename {
  return (EXPORT_FILENAMES as readonly string[]).includes(filename);
}