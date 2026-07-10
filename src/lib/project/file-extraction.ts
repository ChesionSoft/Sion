import path from "node:path";
import type {
  FileExtractionStatus,
  ProjectFile,
  ProjectFileKind,
} from "./types";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const EXTRACTED_TEXT_LIMIT = 200_000;

export type ExtractFileTextInput = {
  fileName: string;
  mimeType?: string;
  buffer: Buffer;
};

export type ExtractFileTextResult = {
  kind: ProjectFileKind;
  extractionStatus: FileExtractionStatus;
  text?: string;
  characterCount?: number;
  extractionError?: string;
  pageCount?: number;
  sheetCount?: number;
  truncated?: boolean;
};

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".log"]);
const JSON_EXTENSIONS = new Set([".json"]);
const CSV_EXTENSIONS = new Set([".csv", ".tsv"]);

export function detectProjectFileKind(fileName: string, mimeType = ""): ProjectFileKind {
  const ext = path.extname(fileName).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return ext === ".md" || ext === ".markdown" ? "markdown" : "text";
  if (JSON_EXTENSIONS.has(ext)) return "json";
  if (CSV_EXTENSIONS.has(ext)) return "csv";
  if (ext === ".pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === ".docx") return "word";
  if (ext === ".xlsx" || ext === ".xls") return "excel";
  return "unsupported";
}

export function truncateExtractedText(text: string): {
  text: string;
  characterCount: number;
  truncated: boolean;
} {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const truncated = normalized.length > EXTRACTED_TEXT_LIMIT;
  const next = truncated ? normalized.slice(0, EXTRACTED_TEXT_LIMIT) : normalized;
  return { text: next, characterCount: next.length, truncated };
}

export function isReadableProjectFile(file: ProjectFile): boolean {
  if (file.extractionStatus) {
    return file.extractionStatus === "available" && file.status === "available" && Boolean(file.textPath);
  }
  return file.status === "available" && Boolean(file.textPath);
}

export async function extractFileText(input: ExtractFileTextInput): Promise<ExtractFileTextResult> {
  const kind = detectProjectFileKind(input.fileName, input.mimeType);
  if (kind === "unsupported") {
    return {
      kind,
      extractionStatus: "unsupported",
      extractionError: "暂不支持该文件格式",
    };
  }

  try {
    if (kind === "pdf") return await extractPdfText(input.buffer);
    if (kind === "word") return await extractDocxText(input.buffer);
    if (kind === "excel") return await extractWorkbookText(input.buffer);
    return extractPlainText(kind, input.buffer);
  } catch (e) {
    // Surface the real cause server-side; the user-facing string stays generic.
    console.warn("[file-extraction] parse failed", {
      kind,
      name: e instanceof Error ? e.name : undefined,
      message: e instanceof Error ? e.message : String(e),
    });
    return {
      kind,
      extractionStatus: "failed",
      extractionError: "文件解析失败",
    };
  }
}

function extractPlainText(kind: ProjectFileKind, buffer: Buffer): ExtractFileTextResult {
  const decoded = buffer.toString("utf8");
  if (!decoded.trim()) {
    return {
      kind,
      extractionStatus: "failed",
      extractionError: "文件没有可读取文本",
    };
  }
  return {
    kind,
    extractionStatus: "available",
    ...truncateExtractedText(decoded),
  };
}

async function extractPdfText(buffer: Buffer): Promise<ExtractFileTextResult> {
  // pdf-parse v2 exposes a PDFParse class while @types/pdf-parse still
  // describes the older function API.
  type PdfParseResult = { text: string; total: number };
  type PdfParser = {
    getText: () => Promise<PdfParseResult>;
    destroy: () => Promise<void>;
  };
  type PdfParseCtor = new (options: { data: Buffer }) => PdfParser;
  const { PDFParse } = await import("pdf-parse") as unknown as { PDFParse: PdfParseCtor };
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  await parser.destroy();
  const text = parsed.text.trim();
  if (!text) {
    return {
      kind: "pdf",
      extractionStatus: "failed",
      extractionError: "PDF 未包含可提取文本",
      pageCount: parsed.total,
    };
  }
  return {
    kind: "pdf",
    extractionStatus: "available",
    pageCount: parsed.total,
    ...truncateExtractedText(text),
  };
}

async function extractDocxText(buffer: Buffer): Promise<ExtractFileTextResult> {
  const mammoth = await import("mammoth");
  const parsed = await mammoth.extractRawText({ buffer });
  const text = parsed.value.trim();
  if (!text) {
    return {
      kind: "word",
      extractionStatus: "failed",
      extractionError: "Word 文档没有可提取文本",
    };
  }
  return {
    kind: "word",
    extractionStatus: "available",
    ...truncateExtractedText(text),
  };
}

async function extractWorkbookText(buffer: Buffer): Promise<ExtractFileTextResult> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sections = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
    });
    const body = rows
      .map((row) => row.map((cell) => String(cell ?? "").trim()).filter(Boolean).join("\t"))
      .filter(Boolean)
      .join("\n");
    return body ? `# Sheet: ${sheetName}\n${body}` : "";
  }).filter(Boolean);

  if (sections.length === 0) {
    return {
      kind: "excel",
      extractionStatus: "failed",
      extractionError: "Excel 工作簿没有可提取文本",
      sheetCount: workbook.SheetNames.length,
    };
  }

  return {
    kind: "excel",
    extractionStatus: "available",
    sheetCount: workbook.SheetNames.length,
    ...truncateExtractedText(sections.join("\n\n")),
  };
}
