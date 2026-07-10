import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import {
  AlignmentType,
  BorderStyle,
  ExternalHyperlink,
  HeadingLevel,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";

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
 * 避免事后重建 TextRun。
 */
export function renderInline(
  inlines: MdastInline[],
  inherited: RunStyle = {},
): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  for (const node of inlines) {
    switch (node.type) {
      case "text":
        out.push(new TextRun({ text: node.value, ...inherited }));
        break;
      case "strong":
        out.push(...renderInline(node.children, { ...inherited, bold: true }));
        break;
      case "emphasis":
        out.push(...renderInline(node.children, { ...inherited, italics: true }));
        break;
      case "delete":
        out.push(...renderInline(node.children, { ...inherited, strike: true }));
        break;
      case "inlineCode":
        out.push(new TextRun({ text: node.value, font: "Consolas", ...inherited }));
        break;
      case "link": {
        const text = collectText(node.children);
        out.push(
          new ExternalHyperlink({
            link: node.url,
            children: [new TextRun({ text, color: "0563C1", underline: {} })],
          }),
        );
        break;
      }
      case "image":
        out.push(new TextRun({ text: `[${node.alt || "图片"}]`, italics: true }));
        break;
      default:
        out.push(new TextRun({ text: collectText([node as MdastInline]) }));
        break;
    }
  }
  return out;
}

/** 收集行内节点数组的纯文本（用于链接显示文本等）。 */
function collectText(inlines: MdastInline[]): string {
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

// 后续 Task 实现：renderBlock / renderMdastBody / renderTable 等。

// ---- 块 ----

export type DocxBlockElement = Paragraph | Table;

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/** 把单个 mdast 块节点渲染为 docx 块元素数组。 */
export function renderBlock(node: MdastBlock): DocxBlockElement[] {
  switch (node.type) {
    case "heading": {
      const children = renderInline(node.children);
      const level = HEADING_LEVELS[node.depth];
      if (!level) {
        // 超界（remark 不会产生 depth>6，防御性回落）：粗体普通段落
        return [new Paragraph({ children: renderInline(node.children, { bold: true }) })];
      }
      return [new Paragraph({ heading: level, children })];
    }
    case "paragraph":
      return [new Paragraph({ children: renderInline(node.children) })];
    case "list": {
      const out: DocxBlockElement[] = [];
      node.children.forEach((item) => {
        out.push(...renderListItem(item, node.ordered, 0));
      });
      return out;
    }
    case "table":
      return [renderTable(node)];
    default:
      return [];
  }
}

/** 有序列表 numbering 引用名；Document 级需声明同名 numbering config。 */
export const ORDERED_LIST_REFERENCE = "ordered-list";

/** 渲染一个列表项：段落用 bullet/numbering，嵌套 list 递归并 level+1。 */
function renderListItem(item: MdastListItem, ordered: boolean, level: number): DocxBlockElement[] {
  const out: DocxBlockElement[] = [];
  for (const child of item.children) {
    if (child.type === "list") {
      child.children.forEach((sub) => {
        out.push(...renderListItem(sub, child.ordered, level + 1));
      });
    } else if (child.type === "paragraph") {
      out.push(
        new Paragraph({
          children: renderInline(child.children),
          ...(ordered
            ? { numbering: { reference: ORDERED_LIST_REFERENCE, level } }
            : { bullet: { level } }),
        }),
      );
    } else {
      out.push(...renderBlock(child));
    }
  }
  return out;
}

/** GFM 表格 -> docx Table：首行表头加粗 + 底纹，列按 align 对齐，全边框。 */
function renderTable(node: Extract<MdastBlock, { type: "table" }>): Table {
  const rows = node.children.map((row, rowIndex) => {
    const isHeader = rowIndex === 0;
    const cells = row.children.map((cell, colIndex) => {
      const align = node.align[colIndex] ?? null;
      return new TableCell({
        children: [
          new Paragraph({
            alignment: alignToAlignment(align),
            children: renderInline(cell.children, isHeader ? { bold: true } : {}),
          }),
        ],
        ...(isHeader
          ? { shading: { type: ShadingType.SOLID, color: "auto", fill: "F2F2F2" } }
          : {}),
        verticalAlign: VerticalAlign.CENTER,
      });
    });
    return new TableRow({ children: cells, tableHeader: isHeader });
  });
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: singleBorders(),
  });
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
