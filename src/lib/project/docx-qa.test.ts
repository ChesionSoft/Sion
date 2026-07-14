import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, HeadingLevel, Paragraph, TextRun } from "docx";
import { Packer } from "docx";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFormalPrdDocument } from "./docx";
import {
  CHINESE_FORMAL_PRD_PROFILE,
  MULTILINGUAL_PROFILE,
  runDocxQa,
} from "./docx-qa";
import type { Project } from "./types";

const workDir = path.join(tmpdir(), "sion-docx-qa-test");
const docxPath = path.join(workDir, "a.docx");

const project: Project = {
  id: "p",
  name: "测试项目",
  version: "v1.0",
  authorName: "Sion",
  customerName: "客户",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
} as Project;

async function writeDocx(buffer: Buffer): Promise<string> {
  await writeFile(docxPath, buffer);
  return docxPath;
}

async function pack(document: Document): Promise<string> {
  return writeDocx(Buffer.from(await Packer.toBuffer(document)));
}

/** A minimal valid OOXML package built from a caller-supplied document.xml.
 * Entries are stored uncompressed so the package reliably exceeds the 1 KB
 * minimum-size guard, letting each test target the structural check it means
 * to exercise rather than the size guard. */
async function packRawXml(documentXml: string): Promise<string> {
  const zip = zipSync({
    "[Content_Types].xml": [
      strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="text/xml"/></Types>'),
      { level: 0 },
    ],
    "word/document.xml": [strToU8(documentXml), { level: 0 }],
  });
  return writeDocx(Buffer.from(zip));
}

/** A stored (uncompressed) zip with no word/document.xml, padded past 1 KB. */
async function packZipWithoutDocumentXml(): Promise<string> {
  const zip = zipSync({
    "[Content_Types].xml": [
      strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
      { level: 0 },
    ],
    "foo.txt": [strToU8(`${"not a docx\n".repeat(120)}`), { level: 0 }],
  });
  return writeDocx(Buffer.from(zip));
}

beforeEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("runDocxQa (pure-Node structural QA)", () => {
  it("passes a real formal-PRD DOCX from buildFormalPrdDocument + Packer", async () => {
    const doc = buildFormalPrdDocument(project, "## 执行摘要\n\n已确认正文内容。");
    const report = await runDocxQa(await pack(doc));
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.structuralUnitCount).toBeGreaterThanOrEqual(1);
  });

  it("fails with invalid_docx on an empty file", async () => {
    await writeFile(docxPath, Buffer.alloc(0));
    const report = await runDocxQa(docxPath);
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "invalid_docx" })]);
  });

  it("fails with invalid_docx on random (non-ZIP) bytes", async () => {
    await writeFile(docxPath, Buffer.from(Array.from({ length: 2048 }, () => 0xab)));
    const report = await runDocxQa(docxPath);
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "invalid_docx" })]);
  });

  it("fails with invalid_docx when the ZIP has no word/document.xml", async () => {
    const report = await runDocxQa(await packZipWithoutDocumentXml());
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "invalid_docx" })]);
  });

  it("fails with parse_failed when document.xml is malformed XML", async () => {
    // Valid prefix with padding, then unclosed root tags -> not well-formed.
    const padding = "<w:p/>".repeat(200);
    const report = await runDocxQa(
      await packRawXml(
        `<?xml version="1.0"?>\n<w:document xmlns:w="x"><w:body>${padding}`,
      ),
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "parse_failed" })]);
  });

  it("fails with empty_document when the package has no body text", async () => {
    const report = await runDocxQa(
      await pack(
        new Document({
          sections: [
            {
              children: [new Paragraph({ children: [] })],
            },
          ],
        }),
      ),
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "empty_document" })]);
  });

  it("fails with missing_structure when a valid package has no outline-level heading", async () => {
    const report = await runDocxQa(
      await pack(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({ children: [new TextRun({ text: "纯正文，没有任何标题" })] }),
              ],
            },
          ],
        }),
      ),
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "missing_structure" })]);
  });

  it("fails with missing_cjk_text under the Chinese formal-PRD profile for an ASCII-only package", async () => {
    const report = await runDocxQa(
      await pack(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({
                  heading: HeadingLevel.HEADING_1,
                  children: [new TextRun({ text: "Summary" })],
                }),
                new Paragraph({ children: [new TextRun({ text: "English body only" })] }),
              ],
            },
          ],
        }),
      ),
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "missing_cjk_text" })]);
    expect(report.structuralUnitCount).toBe(1);
  });

  it("passes the same ASCII-only package under the multilingual profile", async () => {
    const report = await runDocxQa(
      await pack(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({
                  heading: HeadingLevel.HEADING_1,
                  children: [new TextRun({ text: "Summary" })],
                }),
                new Paragraph({ children: [new TextRun({ text: "English body only" })] }),
              ],
            },
          ],
        }),
      ),
      { profile: MULTILINGUAL_PROFILE },
    );
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("never requires a fake process runner (default path is pure Node)", async () => {
    // No `run` injection exists on DocxQaDeps anymore; the default path must
    // succeed against a real Packer buffer with deps omitted entirely.
    const doc = buildFormalPrdDocument(project, "## 概述\n\n正文内容。");
    const report = await runDocxQa(await pack(doc));
    expect(report.passed).toBe(true);
  });

  it("counts outline-level headings across Heading1–Heading3", async () => {
    const report = await runDocxQa(
      await pack(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "第一章 概述" })] }),
                new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "1.1 背景" })] }),
                new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: "1.1.1 细节" })] }),
                new Paragraph({ children: [new TextRun({ text: "正文段落" })] }),
              ],
            },
          ],
        }),
      ),
    );
    expect(report.passed).toBe(true);
    expect(report.structuralUnitCount).toBe(3);
  });

  it("exposes the Chinese formal-PRD profile as the default", () => {
    expect(CHINESE_FORMAL_PRD_PROFILE.id).toBe("chinese-formal-prd");
    expect(CHINESE_FORMAL_PRD_PROFILE.validateContent?.("纯中文")).toBeNull();
    expect(CHINESE_FORMAL_PRD_PROFILE.validateContent?.("ascii only")).toMatchObject({
      code: "missing_cjk_text",
    });
  });
});
