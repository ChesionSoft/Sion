import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertInchesToTwip,
} from "docx";

/**
 * Explicit CJK-aware run font for the formal PRD renderer. Applied to every
 * renderer-created run so Chinese text renders with PingFang SC and Latin runs
 * fall back to Aptos, via the `eastAsia` slot.
 */
export const CJK_FONT = {
  ascii: "Aptos",
  hAnsi: "Aptos",
  eastAsia: "PingFang SC",
  cs: "Aptos",
} as const;

export type RunFontAttributes = {
  ascii: string;
  hAnsi: string;
  eastAsia: string;
  cs: string;
};

// A valid 1x1 transparent PNG used as the raster fallback required by docx for
// embedded SVG images. LibreOffice renders the SVG directly; the fallback only
// matters for legacy renderers.
const PNG_FALLBACK_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const TABLE_CELL_MAX_CHARS = 120;

// ---- 本地 mdast 类型（@types/mdast 不可用，按 remark-parse + remark-gfm 实测形状） ----

export type MdastInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: MdastInline[] }
  | { type: "emphasis"; children: MdastInline[] }
  | { type: "delete"; children: MdastInline[] }
  | { type: "inlineCode"; value: string }
  | { type: "link"; url: string; title?: string | null; children: MdastInline[] }
  | { type: "image"; url: string; alt?: string | null };

export type MdastBlock =
  | { type: "heading"; depth: number; children: MdastInline[] }
  | { type: "paragraph"; children: MdastInline[] }
  | { type: "list"; ordered: boolean; start?: number | null; children: MdastListItem[] }
  | { type: "table"; align: ("left" | "center" | "right" | null)[]; children: MdastRow[] }
  | { type: "code"; value: string; lang?: string | null }
  | { type: "blockquote"; children: MdastBlock[] }
  | { type: "thematicBreak" }
  | { type: "html"; value: string };

export type MdastListItem = { type: "listItem"; children: MdastBlock[] };
export type MdastRow = { type: "tableRow"; children: MdastCell[] };
export type MdastCell = { type: "tableCell"; children: MdastInline[] };
export type MdastNode = { type: string; children?: unknown[] } & Record<string, unknown>;

export function parseMarkdownToMdast(markdown: string): MdastNode {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  return tree as unknown as MdastNode;
}

// ---- 行内 ----

export type RunStyle = { bold?: boolean; italics?: boolean; strike?: boolean };

/**
 * 把 mdast 行内节点数组渲染为 docx 行内子元素（TextRun / ExternalHyperlink）。
 * `inherited` 携带从父节点（strong/emphasis/delete）继承的粗/斜/删除线样式，
 * 避免事后重建 TextRun。`font`（可选）为正式 PRD 渲染器注入 CJK 字体。
 */
export function renderInline(
  inlines: MdastInline[],
  inherited: RunStyle = {},
  font?: RunFontAttributes,
): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  for (const node of inlines) {
    switch (node.type) {
      case "text":
        out.push(new TextRun({ text: node.value, ...(font ? { font } : {}), ...inherited }));
        break;
      case "strong":
        out.push(...renderInline(node.children, { ...inherited, bold: true }, font));
        break;
      case "emphasis":
        out.push(...renderInline(node.children, { ...inherited, italics: true }, font));
        break;
      case "delete":
        out.push(...renderInline(node.children, { ...inherited, strike: true }, font));
        break;
      case "inlineCode":
        out.push(
          new TextRun({
            text: node.value,
            font: font ? { ...font, ascii: "Consolas", hAnsi: "Consolas", cs: "Consolas" } : "Consolas",
            ...inherited,
          }),
        );
        break;
      case "link": {
        const text = collectText(node.children);
        out.push(
          new ExternalHyperlink({
            link: node.url,
            children: [new TextRun({ text, color: "0563C1", underline: {}, ...(font ? { font } : {}) })],
          }),
        );
        break;
      }
      case "image":
        out.push(new TextRun({ text: `[${node.alt || "图片"}]`, italics: true, ...(font ? { font } : {}) }));
        break;
      default:
        out.push(new TextRun({ text: collectText([node as MdastInline]), ...(font ? { font } : {}) }));
        break;
    }
  }
  return out;
}

/** 收集行内节点数组的纯文本（用于链接显示文本、目录条目等）。 */
export function collectText(inlines: MdastInline[]): string {
  let s = "";
  for (const n of inlines) {
    switch (n.type) {
      case "text":
      case "inlineCode":
        s += n.value;
        break;
      case "strong":
      case "emphasis":
      case "delete":
      case "link":
        s += collectText(n.children);
        break;
      case "image":
        s += n.alt || "图片";
        break;
      default:
        break;
    }
  }
  return s;
}

/** One auto-generated table-of-contents entry (docx Heading level 1–3). */
export type TocHeadingEntry = {
  title: string;
  /** Word TOC level: 1 = H1, 2 = H2, 3 = H3. */
  level: number;
  bookmarkId: string;
};

/**
 * Walk mdast blocks and collect H1–H3 after `headingOffset` (same mapping as
 * `renderBlock`). Used to prefill a visible TOC and attach matching bookmarks.
 */
export function collectTocHeadings(
  blocks: MdastBlock[],
  headingOffset = 0,
  maxLevel = 3,
): TocHeadingEntry[] {
  const entries: TocHeadingEntry[] = [];
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    const level = block.depth - headingOffset;
    if (level < 1 || level > maxLevel) continue;
    const title = collectText(block.children).trim();
    if (!title) continue;
    entries.push({
      title,
      level,
      bookmarkId: `toc-${entries.length + 1}`,
    });
  }
  return entries;
}

// 后续 Task 实现：renderBlock / renderMdastBody / renderTable 等。

// ---- 块 ----

export type DocxBlockElement = Paragraph | Table;

export type RenderBlockOptions = {
  headingOffset?: number;
  /** CJK-aware run font applied to text runs (formal PRD renderer). */
  font?: RunFontAttributes;
  /**
   * Formal PRD mode: a constrained ```flow block becomes an SVG diagram image,
   * other fenced code blocks are omitted (internal-only, never in the formal
   * draft), and tables get exact geometry + a prose-stuffing lint check.
   */
  formal?: boolean;
  /**
   * Optional bookmark id for a heading. Return a stable id so TOC hyperlinks
   * can jump to the same paragraph. Called only for headings that map to a
   * HeadingLevel style (depth − offset ∈ 1..6).
   */
  headingBookmarkId?: (depth: number, title: string) => string | undefined;
};

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/** 把单个 mdast 块节点渲染为 docx 块元素数组。 */
export function renderBlock(node: MdastBlock, opts: RenderBlockOptions = {}): DocxBlockElement[] {
  const offset = opts.headingOffset ?? 0;
  switch (node.type) {
    case "heading": {
      const children = renderInline(node.children, {}, opts.font);
      const level = HEADING_LEVELS[node.depth - offset];
      if (!level) {
        // 超界（remark 不会产生 depth>6，防御性回落）：粗体普通段落
        return [new Paragraph({ children: renderInline(node.children, { bold: true }, opts.font) })];
      }
      const title = collectText(node.children);
      const bookmarkId = opts.headingBookmarkId?.(node.depth, title);
      if (bookmarkId) {
        return [
          new Paragraph({
            heading: level,
            children: [new Bookmark({ id: bookmarkId, children })],
          }),
        ];
      }
      return [new Paragraph({ heading: level, children })];
    }
    case "paragraph":
      return [new Paragraph({ children: renderInline(node.children, {}, opts.font) })];
    case "list": {
      const out: DocxBlockElement[] = [];
      node.children.forEach((item) => {
        out.push(...renderListItem(item, node.ordered, 0, opts));
      });
      return out;
    }
    case "table":
      return [renderTable(node, opts)];
    case "code":
      if (opts.formal) {
        if (node.lang === "flow") return [renderFlowDiagram(node.value)];
        // Non-flow code is internal working content and must not appear in the
        // formal PRD draft.
        return [];
      }
      return [renderCodeBlock(node)];
    case "blockquote": {
      const out: DocxBlockElement[] = [];
      for (const child of node.children) {
        if (child.type === "paragraph") {
          out.push(
            new Paragraph({
              indent: { left: convertInchesToTwip(0.25) },
              border: { left: { style: BorderStyle.SINGLE, size: 12, color: "999999", space: 10 } },
              children: renderInline(child.children, {}, opts.font),
            }),
          );
        } else {
          out.push(...renderBlock(child, opts));
        }
      }
      return out;
    }
    case "thematicBreak":
      return [
        new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "auto", space: 1 } },
        }),
      ];
    case "html":
      return [];
    default:
      return [];
  }
}

/** fenced code block -> 等宽字体 + 底纹 + 左边框的单段落（多行用 break）。 */
function renderCodeBlock(node: Extract<MdastBlock, { type: "code" }>): Paragraph {
  const lines = node.value.replace(/\n$/, "").split("\n");
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    shading: { type: ShadingType.SOLID, color: "auto", fill: "F2F2F2" },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: "BFBFBF", space: 8 } },
    children: lines.map((line, i) =>
      new TextRun({ text: line, font: "Consolas", ...(i > 0 ? { break: 1 } : {}) }),
    ),
  });
}

/**
 * Formal PRD flow diagram: exactly one line of 2–6 labels separated by `->`
 * (ASCII) or common Unicode arrows (`→` / `⇒` / `➜` / `➞`) that Chinese drafts
 * often emit. Rendered as a horizontal SVG with rounded nodes and arrows,
 * embedded via an SVG ImageRun. The SVG carries a `data:image/svg+xml` marker
 * comment so the embedded artifact is self-identifying; arbitrary multi-line
 * or out-of-range flow blocks are rejected (they are not a diagram).
 */
function renderFlowDiagram(value: string): Paragraph {
  const trimmed = value.trim();
  if (trimmed.includes("\n")) {
    throw new Error("flow 代码块只能是一行 2–6 个以 -> 或 → 分隔的节点");
  }
  // Prefer multi-char ASCII first so "A-->B" still splits on "->".
  const labels = trimmed
    .split(/\s*(?:->|→|⇒|➜|➞)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (labels.length < 2 || labels.length > 6) {
    throw new Error("flow 代码块只能是一行 2–6 个以 -> 或 → 分隔的节点");
  }

  const nodeW = 130;
  const nodeH = 56;
  const gap = 36;
  const padX = 20;
  const totalW = padX * 2 + labels.length * nodeW + (labels.length - 1) * gap;
  const totalH = nodeH + 30;

  const svg = buildFlowSvg(labels, { nodeW, nodeH, gap, padX, totalW, totalH });
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    children: [
      new ImageRun({
        type: "svg",
        data: Buffer.from(svg, "utf8"),
        altText: { name: "flow-diagram", description: "data:image/svg+xml flow diagram" },
        fallback: {
          type: "png",
          data: PNG_FALLBACK_1X1,
        },
        transformation: { width: totalW, height: totalH },
      }),
    ],
  });
}

function buildFlowSvg(
  labels: string[],
  geom: { nodeW: number; nodeH: number; gap: number; padX: number; totalW: number; totalH: number },
): string {
  const { nodeW, nodeH, gap, padX, totalW, totalH } = geom;
  const cy = 15 + nodeH / 2;
  const parts: string[] = [
    `<!-- data:image/svg+xml -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">`,
    `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#17324D"/></marker></defs>`,
  ];
  let x = padX;
  for (let i = 0; i < labels.length; i++) {
    parts.push(
      `<rect x="${x}" y="15" width="${nodeW}" height="${nodeH}" rx="12" ry="12" fill="#EEF4FB" stroke="#17324D" stroke-width="1.5"/>`,
    );
    parts.push(
      `<text x="${x + nodeW / 2}" y="${cy + 5}" font-family="PingFang SC, sans-serif" font-size="14" fill="#1F2937" text-anchor="middle">${escapeXml(labels[i])}</text>`,
    );
    x += nodeW;
    if (i < labels.length - 1) {
      parts.push(
        `<line x1="${x}" y1="${cy}" x2="${x + gap}" y2="${cy}" stroke="#17324D" stroke-width="1.5" marker-end="url(#arrow)"/>`,
      );
      x += gap;
    }
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 把一段 markdown 的所有顶层块渲染为 docx 块元素数组（按顺序）。 */
export function renderMdastBody(markdown: string, opts: RenderBlockOptions = {}): DocxBlockElement[] {
  const root = parseMarkdownToMdast(markdown) as { children: MdastBlock[] };
  const out: DocxBlockElement[] = [];
  for (const block of root.children) {
    out.push(...renderBlock(block, opts));
  }
  return out;
}

/** 有序列表 numbering 引用名；Document 级需声明同名 numbering config。 */
export const ORDERED_LIST_REFERENCE = "ordered-list";

/** 渲染一个列表项：段落用 bullet/numbering，嵌套 list 递归并 level+1。 */
function renderListItem(item: MdastListItem, ordered: boolean, level: number, opts: RenderBlockOptions): DocxBlockElement[] {
  const out: DocxBlockElement[] = [];
  for (const child of item.children) {
    if (child.type === "list") {
      child.children.forEach((sub) => {
        out.push(...renderListItem(sub, child.ordered, level + 1, opts));
      });
    } else if (child.type === "paragraph") {
      out.push(
        new Paragraph({
          children: renderInline(child.children, {}, opts.font),
          ...(ordered
            ? { numbering: { reference: ORDERED_LIST_REFERENCE, level } }
            : { bullet: { level } }),
        }),
      );
    } else {
      out.push(...renderBlock(child, opts));
    }
  }
  return out;
}

/** GFM 表格 -> docx Table：首行表头加粗 + 底纹，列按 align 对齐，全边框。 */
function renderTable(node: Extract<MdastBlock, { type: "table" }>, opts: RenderBlockOptions = {}): Table {
  if (opts.formal) {
    lintFormalTable(node);
  }

  const columnCount = node.children[0]?.children.length ?? 1;
  const columnWidths = opts.formal ? formalColumnWidths(node, columnCount) : undefined;

  const rows = node.children.map((row, rowIndex) => {
    const isHeader = rowIndex === 0;
    const cells = row.children.map((cell, colIndex) => {
      const align = node.align[colIndex] ?? null;
      return new TableCell({
        children: [
          new Paragraph({
            alignment: alignToAlignment(align),
            children: renderInline(cell.children, isHeader ? { bold: true } : {}, opts.font),
          }),
        ],
        ...(isHeader
          ? { shading: { type: ShadingType.SOLID, color: "auto", fill: "F2F2F2" } }
          : {}),
        ...(opts.formal && columnWidths
          ? { margins: { top: 60, bottom: 60, left: 100, right: 100 }, width: { size: columnWidths[colIndex], type: WidthType.DXA } }
          : {}),
        verticalAlign: VerticalAlign.CENTER,
      });
    });
    return new TableRow({ children: cells, tableHeader: isHeader });
  });

  return new Table({
    rows,
    ...(columnWidths
      ? { columnWidths, width: { size: columnWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA } }
      : { width: { size: 100, type: WidthType.PERCENTAGE } }),
    borders: singleBorders(),
  });
}

/**
 * Reject a prose-stuffed table before DOCX construction: if more than half of
 * the cells exceed {@link TABLE_CELL_MAX_CHARS}, the table is really prose in
 * disguise and must be rewritten as paragraphs or a list.
 */
function lintFormalTable(node: Extract<MdastBlock, { type: "table" }>): void {
  const cells = node.children.flatMap((row) => row.children);
  if (cells.length === 0) return;
  const tooLong = cells.filter((cell) => collectText(cell.children).length > TABLE_CELL_MAX_CHARS).length;
  if (tooLong > cells.length / 2) {
    throw new Error("表格内容过长，请改为正文段落或列表，不要把大段文字塞进表格");
  }
}

/** Even twip column widths from the usable page width (A4 minus margins). */
function formalColumnWidths(node: Extract<MdastBlock, { type: "table" }>, columnCount: number): number[] {
  const usableTwips = 9000;
  const base = Math.floor(usableTwips / columnCount);
  return new Array(columnCount).fill(base);
}

function alignToAlignment(
  align: "left" | "center" | "right" | null,
): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  if (align === "center") return AlignmentType.CENTER;
  if (align === "right") return AlignmentType.RIGHT;
  if (align === "left") return AlignmentType.LEFT;
  return undefined;
}

function singleBorders() {
  const edge = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
  return {
    top: edge,
    bottom: edge,
    left: edge,
    right: edge,
    insideHorizontal: edge,
    insideVertical: edge,
  };
}
