import { describe, expect, it } from "vitest";
import {
  EXTRACTED_TEXT_LIMIT,
  detectProjectFileKind,
  extractFileText,
  isReadableProjectFile,
  truncateExtractedText,
} from "./file-extraction";
import type { ProjectFile } from "./types";

describe("file extraction domain", () => {
  it("detects supported project file kinds by extension", () => {
    expect(detectProjectFileKind("notes.md", "text/markdown")).toBe("markdown");
    expect(detectProjectFileKind("data.tsv", "text/tab-separated-values")).toBe("csv");
    expect(detectProjectFileKind("brief.pdf", "application/pdf")).toBe("pdf");
    expect(detectProjectFileKind("proposal.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("word");
    expect(detectProjectFileKind("budget.xls", "application/vnd.ms-excel")).toBe("excel");
    expect(detectProjectFileKind("legacy.doc", "application/msword")).toBe("unsupported");
    expect(detectProjectFileKind("image.png", "image/png")).toBe("unsupported");
  });

  it("extracts UTF-8 text formats and records character counts", async () => {
    const result = await extractFileText({
      fileName: "requirements.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 需求\n\n- 登录", "utf8"),
    });

    expect(result).toMatchObject({
      kind: "markdown",
      extractionStatus: "available",
      text: "# 需求\n\n- 登录",
      characterCount: 10,
      truncated: false,
    });
  });

  it("marks legacy .doc files unsupported without pretending they are readable", async () => {
    const result = await extractFileText({
      fileName: "old.doc",
      mimeType: "application/msword",
      buffer: Buffer.from("binary", "utf8"),
    });

    expect(result).toEqual({
      kind: "unsupported",
      extractionStatus: "unsupported",
      extractionError: "暂不支持该文件格式",
    });
  });

  it("truncates extracted text at the hard limit", () => {
    const source = "a".repeat(EXTRACTED_TEXT_LIMIT + 5);
    expect(truncateExtractedText(source)).toEqual({
      text: "a".repeat(EXTRACTED_TEXT_LIMIT),
      characterCount: EXTRACTED_TEXT_LIMIT,
      truncated: true,
    });
  });

  it("treats legacy available files with textPath as readable", () => {
    const legacy: ProjectFile = {
      id: "f1",
      originalName: "old.md",
      storedName: "f1.md",
      extension: ".md",
      mimeType: "text/markdown",
      byteSize: 10,
      uploadedAt: "2026-06-23T00:00:00.000Z",
      status: "available",
      textPath: "f1.md",
    };

    expect(isReadableProjectFile(legacy)).toBe(true);
  });

  it("does not treat failed or unsupported extracted files as readable", () => {
    const failed: ProjectFile = {
      id: "f2",
      originalName: "scan.pdf",
      storedName: "f2.pdf",
      extension: ".pdf",
      mimeType: "application/pdf",
      byteSize: 10,
      uploadedAt: "2026-06-23T00:00:00.000Z",
      status: "read_failed",
      kind: "pdf",
      extractionStatus: "failed",
      extractionError: "PDF 未包含可提取文本",
    };

    expect(isReadableProjectFile(failed)).toBe(false);
  });
});