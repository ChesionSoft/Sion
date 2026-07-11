/**
 * The fixed set of files produced by `exportProjectDocuments` (see exports.ts).
 * Used by `ProjectStore.listExports` (which files to stat) and by the
 * `[filename]` route (the whitelist that gates file serving). Keeping the list
 * in one place keeps the store and the route in sync and is the security
 * boundary that prevents path traversal via the dynamic filename segment.
 */
export const EXPORT_FILENAMES = [
  "PROJECT_DESIGN.md",
  "项目开发设计文档.docx",
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
