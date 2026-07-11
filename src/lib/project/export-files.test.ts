import { describe, expect, it } from "vitest";
import { EXPORT_FILENAMES, isExportFilename } from "./export-files";

describe("export-files", () => {
  it("lists the five produced artifacts", () => {
    expect(EXPORT_FILENAMES).toEqual([
      "PROJECT_DESIGN.md",
      "项目开发设计文档.docx",
      "SPEC.md",
      "TASKS.md",
      "AGENTS.md",
    ]);
  });

  it("recognizes known export filenames", () => {
    expect(isExportFilename("PROJECT_DESIGN.md")).toBe(true);
    expect(isExportFilename("项目开发设计文档.docx")).toBe(true);
    expect(isExportFilename("AGENTS.md")).toBe(true);
  });

  it("rejects unknown and traversal filenames", () => {
    expect(isExportFilename("project.json")).toBe(false);
    expect(isExportFilename("../project.json")).toBe(false);
    expect(isExportFilename("foo.md")).toBe(false);
    expect(isExportFilename("")).toBe(false);
  });
});
