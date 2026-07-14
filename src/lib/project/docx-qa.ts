import { readFile } from "node:fs/promises";
import { unzipSync, type Unzipped } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Server-side DOCX structural + content QA. This is a pure-Node quality gate:
 * it never shells out to LibreOffice (`soffice`) or Poppler (`pdftoppm` /
 * `pdftotext`). It reads the OOXML package in memory, validates that it is a
 * real ZIP package with the required parts, parses `word/document.xml` with a
 * real XML parser, extracts `w:t` text, and checks for outline-level headings
 * plus a pluggable content contract (the Chinese formal-PRD profile requires
 * CJK text). It does not verify pixel-accurate layout - real typography and
 * pagination stay Word/WPS's responsibility.
 *
 * The gate runs before `项目开发设计文档.docx` is downloadable; on failure the
 * DOCX is removed and the API returns 422 with `formal-prd-qa-report.md`.
 */

export type DocxQaIssueCode =
  // Active codes (structural + content QA path).
  | "invalid_docx"
  | "parse_failed"
  | "empty_document"
  | "missing_structure"
  | "missing_cjk_text"
  // Deprecated: retained for one release so persisted state / legacy callers
  // still type-check. The new path never emits these.
  | "empty_page"
  | "renderer_unavailable"
  | "render_failed"
  | "no_pages";

export type DocxQaIssue = {
  code: DocxQaIssueCode;
  message: string;
};

export type DocxQaReport = {
  passed: boolean;
  /** Outline-level headings detected in `document.xml` (min 1 when QA passes). */
  structuralUnitCount: number;
  issues: DocxQaIssue[];
  checkedAt: string;
};

/**
 * A named content contract applied after the universal structural checks. The
 * Chinese formal-PRD profile requires CJK text; a multilingual profile
 * demonstrates the same valid package can pass without CJK. Content profiles
 * are not package-validity rules - a package can be structurally valid yet fail
 * a profile.
 */
export type DocxQaContentIssue = { code: DocxQaIssueCode; message: string };

export type DocxQaProfile = {
  id: string;
  /** Validate extracted plain text; return an issue or null when acceptable. */
  validateContent?(text: string): DocxQaContentIssue | null;
};

export const CHINESE_FORMAL_PRD_PROFILE: DocxQaProfile = {
  id: "chinese-formal-prd",
  validateContent(text) {
    return /[一-鿿]/.test(text)
      ? null
      : { code: "missing_cjk_text", message: "正式 PRD 正文未检出中文字符" };
  },
};

/** Multilingual profile: no CJK requirement; any non-empty body text passes. */
export const MULTILINGUAL_PROFILE: DocxQaProfile = {
  id: "multilingual",
};

export type DocxQaDeps = {
  /** Content contract; defaults to the Chinese formal-PRD profile. */
  profile?: DocxQaProfile;
};

// Size boundaries for the in-memory parser. The generated artifact is local
// and small; these guards exist so a malformed / zip-bomb-like package cannot
// exhaust memory before parsing is rejected.
const MIN_DOCX_BYTES = 1024;
const MAX_DOCX_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 64 * 1024 * 1024;

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_ARCHIVE = [0x50, 0x4b, 0x05, 0x06];
const DOCUMENT_XML_PATH = "word/document.xml";
const CONTENT_TYPES_PATH = "[Content_Types].xml";

const nowIso = (): string => new Date().toISOString();

const fail = (code: DocxQaIssueCode, message: string, structuralUnitCount = 0): DocxQaReport => ({
  passed: false,
  structuralUnitCount,
  issues: [{ code, message }],
  checkedAt: nowIso(),
});

export async function runDocxQa(docxPath: string, deps: DocxQaDeps = {}): Promise<DocxQaReport> {
  const profile = deps.profile ?? CHINESE_FORMAL_PRD_PROFILE;
  try {
    const buffer = await readFile(docxPath);

    // #1 File readable and size >= 1 KB (guards empty / truncated writes).
    if (buffer.length < MIN_DOCX_BYTES) {
      return fail("invalid_docx", "DOCX 文件过小或为空");
    }
    if (buffer.length > MAX_DOCX_BYTES) {
      return fail("invalid_docx", "DOCX 文件过大");
    }

    // #2 ZIP local header magic (DOCX is an OOXML zip).
    const magic = [buffer[0], buffer[1], buffer[2], buffer[3]];
    if (!sameBytes(magic, ZIP_LOCAL_HEADER) && !sameBytes(magic, ZIP_EMPTY_ARCHIVE)) {
      return fail("invalid_docx", "DOCX 不是有效的 ZIP 包");
    }

    // #3 ZIP contains word/document.xml and [Content_Types].xml.
    let entries: Unzipped;
    try {
      entries = unzipSync(new Uint8Array(buffer), {
        filter: (file) => file.originalSize <= MAX_ENTRY_BYTES,
      });
    } catch {
      return fail("invalid_docx", "DOCX 包解析失败");
    }
    if (!entries[DOCUMENT_XML_PATH] || !entries[CONTENT_TYPES_PATH]) {
      return fail("invalid_docx", "DOCX 缺少 word/document.xml 或 [Content_Types].xml");
    }

    const documentXmlBytes = entries[DOCUMENT_XML_PATH];
    if (documentXmlBytes.length > MAX_DOCUMENT_XML_BYTES) {
      return fail("invalid_docx", "word/document.xml 过大");
    }
    const xml = Buffer.from(documentXmlBytes).toString("utf8");

    // #4 document.xml parses with a real XML parser (never a regex validator).
    const validation = XMLValidator.validate(xml);
    if (validation !== true) {
      return fail("parse_failed", "word/document.xml 解析失败");
    }

    let parsed: unknown;
    try {
      parsed = new XMLParser({
        removeNSPrefix: true,
        ignoreAttributes: false,
        parseTagValue: false,
        parseAttributeValue: false,
      }).parse(xml);
    } catch {
      return fail("parse_failed", "word/document.xml 解析失败");
    }

    const { text, headingCount } = extractDocument(parsed);

    // #5 Extracted plain text non-empty (after stripping whitespace).
    if (!text) {
      return fail("empty_document", "未提取到正文文本", headingCount);
    }

    const issues: DocxQaIssue[] = [];

    // #6 At least one outline-level heading is present.
    if (headingCount < 1) {
      issues.push({ code: "missing_structure", message: "未检出大纲级标题（Heading 1–3）" });
    }

    // #7 Configured content contract.
    const contentIssue = profile.validateContent?.(text);
    if (contentIssue) {
      issues.push(contentIssue);
    }

    const passed = issues.length === 0;
    const structuralUnitCount = passed ? Math.max(1, headingCount) : headingCount;
    return { passed, structuralUnitCount, issues, checkedAt: nowIso() };
  } catch (err) {
    // Unexpected exception -> single safe parse_failed issue (no stack to client).
    void err;
    return fail("parse_failed", "DOCX 解析失败");
  }
}

type XmlNode = string | number | boolean | XmlNode[] | { [key: string]: XmlNode };

function sameBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function toArray(value: XmlNode | undefined): XmlNode[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read the text content of a `w:t` element value (string, object, or array). */
function readTextNode(value: XmlNode | undefined): string {
  let out = "";
  for (const item of toArray(value)) {
    if (typeof item === "string") {
      out += item;
    } else if (typeof item === "number" || typeof item === "boolean") {
      out += String(item);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      out += readTextNode(item["#text"]);
    }
  }
  return out;
}

/** A paragraph is an outline-level heading if it carries Heading1–3 or outlineLvl 0–2. */
function isHeadingParagraph(para: XmlNode): boolean {
  if (!para || typeof para !== "object" || Array.isArray(para)) return false;
  for (const pPr of toArray(para["pPr"])) {
    if (!pPr || typeof pPr !== "object" || Array.isArray(pPr)) continue;
    for (const pStyle of toArray(pPr["pStyle"])) {
      const val = attrValue(pStyle, "val");
      if (typeof val === "string" && /^Heading[1-3]$/.test(val)) return true;
    }
    for (const outlineLvl of toArray(pPr["outlineLvl"])) {
      const val = attrValue(outlineLvl, "val");
      if (val === "0" || val === "1" || val === "2") return true;
    }
  }
  return false;
}

function attrValue(node: XmlNode, name: string): string | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  const raw = node[`@_${name}`];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Walk the parsed `document.xml` tree collecting `w:t` text and counting
 * outline-level heading paragraphs. Namespace prefixes are already stripped by
 * the parser, so tags are `t` / `p` / `pPr` / `pStyle` / `outlineLvl`.
 */
function extractDocument(parsed: unknown): { text: string; headingCount: number } {
  const texts: string[] = [];
  let headingCount = 0;

  const walk = (value: XmlNode | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as { [key: string]: XmlNode };
    const t = record["t"];
    if (t !== undefined) {
      const fragment = readTextNode(t);
      if (fragment) texts.push(fragment);
    }
    const p = record["p"];
    if (p !== undefined) {
      for (const para of toArray(p)) {
        if (isHeadingParagraph(para)) headingCount += 1;
      }
    }
    for (const child of Object.values(record)) walk(child);
  };

  walk(parsed as XmlNode);

  const text = texts.join(" ").replace(/\s+/g, " ").trim();
  return { text, headingCount };
}
