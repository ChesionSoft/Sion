import { describe, expect, it } from "vitest";
import { EXPORT_FILENAMES, isExportFilename } from "./export-files";

describe("export-files", () => {
  it("lists the staged export artifacts in formal-first order", () => {
    expect(EXPORT_FILENAMES).toEqual([
      "export-blueprint.md",
      "formal-prd-draft.md",
      "formal-prd-qa-report.md",
      "项目开发设计文档.docx",
      "PROJECT_DESIGN.md",
      "SPEC.md",
      "TASKS.md",
      "AGENTS.md",
    ]);
  });

  it("recognizes known export filenames", () => {
    expect(isExportFilename("PROJECT_DESIGN.md")).toBe(true);
    expect(isExportFilename("项目开发设计文档.docx")).toBe(true);
    expect(isExportFilename("export-blueprint.md")).toBe(true);
    expect(isExportFilename("formal-prd-qa-report.md")).toBe(true);
    expect(isExportFilename("AGENTS.md")).toBe(true);
  });

  it("rejects unknown, state, and traversal filenames", () => {
    // the persisted state file is intentionally not servable
    expect(isExportFilename("formal-prd-state.json")).toBe(false);
    expect(isExportFilename("project.json")).toBe(false);
    expect(isExportFilename("../project.json")).toBe(false);
    expect(isExportFilename("foo.md")).toBe(false);
    expect(isExportFilename("")).toBe(false);
  });
});
