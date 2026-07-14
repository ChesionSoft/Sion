import {
  AlignmentType,
  BorderStyle,
  convertInchesToTwip,
  Document,
  Footer,
  Header,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  SectionType,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { WORKFLOW_NODES } from "./nodes";
import {
  CJK_FONT,
  ORDERED_LIST_REFERENCE,
  collectTocHeadings,
  parseMarkdownToMdast,
  renderBlock,
  renderMdastBody,
  type TocHeadingEntry,
} from "./markdown-to-docx";
import type { DocxBlockElement, MdastBlock } from "./markdown-to-docx";
import type { Project, ProjectNode } from "./types";

const today = (): string => new Date().toISOString().slice(0, 10);

/** Shared numbering config for ordered lists in both document builders. */
function orderedListNumbering() {
  return {
    config: [
      {
        reference: ORDERED_LIST_REFERENCE,
        levels: [0, 1, 2, 3].map((lvl) => ({
          level: lvl,
          format: LevelFormat.DECIMAL,
          text: `%${lvl + 1}.`,
          alignment: AlignmentType.START,
          style: {
            paragraph: {
              indent: {
                left: convertInchesToTwip(0.5 + lvl * 0.3),
                hanging: convertInchesToTwip(0.25),
              },
            },
          },
        })),
      },
    ],
  };
}

/**
 * Built-in heading styles with outlineLevel (required for TOC) and optional
 * CJK eastAsia font. IDs must stay "Heading1"…"Heading3" so Word maps them.
 */
function headingParagraphStyles(withCjk: boolean) {
  const font = withCjk ? { font: { ...CJK_FONT } } : {};
  return [
    {
      id: "Heading1",
      name: "Heading 1",
      basedOn: "Normal",
      next: "Normal",
      quickFormat: true,
      run: { size: 32, bold: true, color: "17324D", ...font },
      paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
    },
    {
      id: "Heading2",
      name: "Heading 2",
      basedOn: "Normal",
      next: "Normal",
      quickFormat: true,
      run: { size: 28, bold: true, color: "1F3A5F", ...font },
      paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 },
    },
    {
      id: "Heading3",
      name: "Heading 3",
      basedOn: "Normal",
      next: "Normal",
      quickFormat: true,
      run: { size: 24, bold: true, color: "334155", ...font },
      paragraph: { spacing: { before: 220, after: 120 }, outlineLevel: 2 },
    },
  ];
}

/**
 * Prefill TOC so entries are visible without Word "Update Field".
 * Page numbers stay blank until Word/WPS refreshes the field (updateFields).
 */
function buildPrefetchedToc(entries: TocHeadingEntry[], withCjk: boolean) {
  const font = withCjk ? { font: { ...CJK_FONT } } : {};
  return [
    new Paragraph({
      spacing: { after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: "17324D", space: 4 } },
      children: [new TextRun({ text: "目录", bold: true, size: 32, color: "17324D", ...font })],
    }),
    new TableOfContents("目录", {
      hyperlink: true,
      headingStyleRange: "1-3",
      beginDirty: true,
      cachedEntries: entries.map((e) => ({
        title: e.title,
        level: e.level,
        href: e.bookmarkId,
      })),
    }),
    new Paragraph({
      spacing: { before: 120 },
      children: [
        new TextRun({
          text: "提示：页码在 Word / WPS 中打开后会自动更新；点击条目可跳转到对应章节。",
          size: 16,
          color: "6B7280",
          italics: true,
          ...font,
        }),
      ],
    }),
  ];
}

function headingBookmarkResolver(entries: TocHeadingEntry[], headingOffset: number) {
  let index = 0;
  return (depth: number): string | undefined => {
    const level = depth - headingOffset;
    if (level < 1 || level > 3) return undefined;
    const entry = entries[index];
    index += 1;
    return entry?.bookmarkId;
  };
}

/**
 * Build the `项目开发设计文档` as a docx `Document`. 有 `masterMarkdown` 时正文渲染
 * master(`##`->H1、章节前分页);否则按结构化节点逐章渲染。Pure(不碰磁盘/不打包)。
 */
export function buildProjectDesignDocument(
  project: Project,
  nodes: ProjectNode[],
  masterMarkdown?: string,
): Document {
  const { tocEntries, bodyChildren } = buildLegacyBody(project, nodes, masterMarkdown);

  return new Document({
    creator: project.authorName || "Sion",
    title: `${project.name}项目开发设计文档`,
    description: "项目开发设计文档",
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { size: 21 } },
      },
      paragraphStyles: headingParagraphStyles(false),
    },
    numbering: orderedListNumbering(),
    sections: [
      coverSection(project),
      {
        properties: { type: SectionType.NEXT_PAGE },
        children: buildPrefetchedToc(tocEntries, false),
      },
      {
        properties: { type: SectionType.NEXT_PAGE },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: `${project.name} · ${project.version}`, size: 18, color: "999999" }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ children: ["第 ", PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES, " 页"] }),
                ],
              }),
            ],
          }),
        },
        children: bodyChildren,
      },
    ],
  });
}

/** 生成 `项目开发设计文档.docx` 的二进制 Buffer。 */
export async function createProjectDesignDocx(
  project: Project,
  nodes: ProjectNode[],
  masterMarkdown?: string,
): Promise<Buffer> {
  return Buffer.from(await Packer.toBuffer(buildProjectDesignDocument(project, nodes, masterMarkdown)));
}

/**
 * Build the formal PRD Word document from the **approved formal draft Markdown
 * only** — never raw workflow nodes. Uses explicit CJK-aware styles (PingFang SC
 * via the `eastAsia` slot), a formal cover, a prefetched table of contents with
 * bookmarks, and a body rendered in formal mode (```flow -> SVG diagram,
 * non-flow code omitted, table geometry + prose lint). Pure (no disk, no packing).
 */
export function buildFormalPrdDocument(project: Project, draftMarkdown: string): Document {
  const body = stripFirstHeading(draftMarkdown);
  const root = parseMarkdownToMdast(body) as { children: MdastBlock[] };
  const bodyToc = collectTocHeadings(root.children, 1, 3).map((e, i) => ({
    ...e,
    bookmarkId: `toc-${i + 2}`,
  }));
  const tocEntries: TocHeadingEntry[] = [
    { title: "修订记录", level: 1, bookmarkId: "toc-1" },
    ...bodyToc,
  ];
  const bookmarkId = headingBookmarkResolver(bodyToc, 1);

  const children: DocxBlockElement[] = [
    ...renderBlock(
      { type: "heading", depth: 1, children: [{ type: "text", value: "修订记录" }] },
      {
        headingOffset: 0,
        font: { ...CJK_FONT },
        headingBookmarkId: () => "toc-1",
      },
    ),
    revisionTable(project, true),
    new Paragraph({ children: [], spacing: { after: 200 } }),
  ];

  for (const block of root.children) {
    if (block.type === "heading" && block.depth === 2) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    children.push(
      ...renderBlock(block, {
        headingOffset: 1,
        font: { ...CJK_FONT },
        formal: true,
        headingBookmarkId: bookmarkId,
      }),
    );
  }

  return new Document({
    creator: project.authorName || "Sion",
    title: `${project.name} 正式产品需求文档（PRD）`,
    description: "正式产品需求文档（PRD）",
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: { font: { ...CJK_FONT }, size: 21 },
        },
      },
      paragraphStyles: [
        {
          id: "PrdTitle",
          name: "PrdTitle",
          basedOn: "Normal",
          next: "Normal",
          run: { font: { ...CJK_FONT }, size: 44, bold: true, color: "17324D" },
        },
        {
          id: "PrdBody",
          name: "PrdBody",
          basedOn: "Normal",
          next: "Normal",
          run: { font: { ...CJK_FONT }, size: 21, color: "1F2937" },
          paragraph: { spacing: { after: 140, line: 330 } },
        },
        ...headingParagraphStyles(true),
      ],
    },
    numbering: orderedListNumbering(),
    sections: [
      formalCoverSection(project),
      {
        properties: { type: SectionType.NEXT_PAGE },
        children: buildPrefetchedToc(tocEntries, true),
      },
      {
        properties: { type: SectionType.NEXT_PAGE },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `${project.name} · ${project.version}`,
                    size: 18,
                    color: "999999",
                    font: { ...CJK_FONT },
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: ["第 ", PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES, " 页"],
                    font: { ...CJK_FONT },
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
}

function formalCoverSection(project: Project) {
  const meta = (text: string) =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      children: [new TextRun({ text, font: { ...CJK_FONT }, size: 24 })],
    });
  return {
    properties: { type: SectionType.NEXT_PAGE },
    children: [
      new Paragraph({ children: [], spacing: { before: 2400 } }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 240 },
        children: [
          new TextRun({
            text: "正式产品需求文档（PRD）",
            bold: true,
            size: 44,
            color: "17324D",
            font: { ...CJK_FONT },
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 360 },
        children: [new TextRun({ text: project.name, bold: true, size: 32, font: { ...CJK_FONT } })],
      }),
      ...(project.customerName ? [meta(`客户名称：${project.customerName}`)] : []),
      ...(project.authorName ? [meta(`编制方：${project.authorName}`)] : []),
      meta(`版本号：${project.version}`),
      meta(`生成日期：${today()}`),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 480 },
        children: [
          new TextRun({
            text: "含封面 · 目录 · 修订记录 · 正文章节",
            size: 18,
            color: "6B7280",
            font: { ...CJK_FONT },
          }),
        ],
      }),
    ],
  };
}

function coverSection(project: Project) {
  const meta = (text: string) =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      children: [new TextRun({ text, size: 24 })],
    });
  return {
    properties: { type: SectionType.NEXT_PAGE },
    children: [
      new Paragraph({ children: [], spacing: { before: 2400 } }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 240 },
        children: [new TextRun({ text: `${project.name}项目开发设计文档`, bold: true, size: 44 })],
      }),
      meta(`客户名称：${project.customerName || "未填写"}`),
      meta(`编制方：${project.authorName || "未填写"}`),
      meta(`版本号：${project.version}`),
      meta(`生成日期：${today()}`),
    ],
  };
}

function buildLegacyBody(
  project: Project,
  nodes: ProjectNode[],
  masterMarkdown?: string,
): { tocEntries: TocHeadingEntry[]; bodyChildren: DocxBlockElement[] } {
  const children: DocxBlockElement[] = [
    ...renderBlock(
      { type: "heading", depth: 1, children: [{ type: "text", value: "修订记录" }] },
      { headingOffset: 0, headingBookmarkId: () => "toc-1" },
    ),
    revisionTable(project, false),
  ];

  const tocEntries: TocHeadingEntry[] = [{ title: "修订记录", level: 1, bookmarkId: "toc-1" }];

  if (masterMarkdown && masterMarkdown.trim()) {
    const body = stripFirstHeading(masterMarkdown);
    const root = parseMarkdownToMdast(body) as { children: MdastBlock[] };
    const bodyToc = collectTocHeadings(root.children, 1, 3).map((e, i) => ({
      ...e,
      bookmarkId: `toc-${i + 2}`,
    }));
    tocEntries.push(...bodyToc);
    const bookmarkId = headingBookmarkResolver(bodyToc, 1);
    for (const block of root.children) {
      if (block.type === "heading" && block.depth === 2) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      }
      children.push(...renderBlock(block, { headingOffset: 1, headingBookmarkId: bookmarkId }));
    }
  } else {
    const ordered = [...nodes].sort(
      (a, b) =>
        WORKFLOW_NODES.findIndex((n) => n.id === a.id) - WORKFLOW_NODES.findIndex((n) => n.id === b.id),
    );
    let chapterIndex = 0;
    for (const node of ordered) {
      if (node.id === "final-export") continue;
      const def = WORKFLOW_NODES.find((n) => n.id === node.id);
      const heading = def?.documentHeading ?? node.id;
      chapterIndex += 1;
      const bookmarkId = `toc-ch-${chapterIndex}`;
      tocEntries.push({ title: heading, level: 1, bookmarkId });
      children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(
        ...renderBlock(
          {
            type: "heading",
            depth: 1,
            children: [{ type: "text", value: heading }],
          },
          {
            headingOffset: 0,
            headingBookmarkId: () => bookmarkId,
          },
        ),
      );
      children.push(...renderMdastBody(stripFirstHeading(node.markdown)));
    }
  }

  return { tocEntries, bodyChildren: children };
}

function revisionTable(project: Project, withCjk: boolean): Table {
  const font = withCjk ? { font: { ...CJK_FONT } } : {};
  const headerCell = (text: string) =>
    new TableCell({
      shading: { type: ShadingType.CLEAR, fill: "E8EEF5" },
      width: { size: 2340, type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [
        new Paragraph({
          children: [new TextRun({ text, bold: true, size: 20, ...font })],
        }),
      ],
    });
  const cell = (text: string) =>
    new TableCell({
      width: { size: 2340, type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: [new TextRun({ text, size: 20, ...font })] })],
    });
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [2340, 2340, 2340, 2340],
    rows: [
      new TableRow({
        tableHeader: true,
        children: [headerCell("版本"), headerCell("日期"), headerCell("修改说明"), headerCell("修改人")],
      }),
      new TableRow({
        children: [
          cell(project.version),
          cell(today()),
          cell("初版"),
          cell(project.authorName || "—"),
        ],
      }),
    ],
  });
}

function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^# .+\n*/, "").trim();
}
