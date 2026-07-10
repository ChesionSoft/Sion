import {
  AlignmentType,
  convertInchesToTwip,
  Document,
  Footer,
  Header,
  HeadingLevel,
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
import { ORDERED_LIST_REFERENCE, renderMdastBody } from "./markdown-to-docx";
import type { DocxBlockElement } from "./markdown-to-docx";
import type { Project, ProjectNode } from "./types";

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Build the `项目开发设计文档` as a docx `Document` from structured nodes:
 * 封面页 -> 自动目录 -> 修订记录表 -> 逐节点章节（页眉页脚 + 章节分页）。
 * Pure（不触碰磁盘、不打包），便于测试结构。
 */
export function buildProjectDesignDocument(project: Project, nodes: ProjectNode[]): Document {
  return new Document({
    creator: project.authorName || "Sion",
    title: `${project.name}项目开发设计文档`,
    description: "项目开发设计文档",
    numbering: {
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
    },
    sections: [coverSection(project), tocSection(), bodySection(project, nodes)],
  });
}

/** 生成 `项目开发设计文档.docx` 的二进制 Buffer。 */
export async function createProjectDesignDocx(project: Project, nodes: ProjectNode[]): Promise<Buffer> {
  return Buffer.from(await Packer.toBuffer(buildProjectDesignDocument(project, nodes)));
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

function tocSection() {
  return {
    properties: { type: SectionType.NEXT_PAGE },
    children: [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "目录", bold: true })],
      }),
      new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-3" }),
    ],
  };
}

function bodySection(project: Project, nodes: ProjectNode[]) {
  const header = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: `${project.name} · ${project.version}`, size: 18, color: "999999" })],
      }),
    ],
  });
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: ["第 ", PageNumber.CURRENT, " 页"] })],
      }),
    ],
  });

  const children: DocxBlockElement[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "修订记录", bold: true })] }),
    revisionTable(project),
  ];

  const ordered = [...nodes].sort(
    (a, b) =>
      WORKFLOW_NODES.findIndex((n) => n.id === a.id) - WORKFLOW_NODES.findIndex((n) => n.id === b.id),
  );
  for (const node of ordered) {
    if (node.id === "final-export") continue;
    const def = WORKFLOW_NODES.find((n) => n.id === node.id);
    const heading = def?.documentHeading ?? node.id;
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: heading, bold: true })] }),
    );
    children.push(...renderMdastBody(stripFirstHeading(node.markdown)));
  }

  return {
    properties: { type: SectionType.NEXT_PAGE },
    headers: { default: header },
    footers: { default: footer },
    children,
  };
}

function revisionTable(project: Project): Table {
  const headerCell = (text: string) =>
    new TableCell({
      shading: { type: ShadingType.SOLID, color: "auto", fill: "F2F2F2" },
      children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })],
    });
  const cell = (text: string) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text })] })] });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
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
          cell(project.authorName || "未填写"),
        ],
      }),
    ],
  });
}

function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^# .+\n*/, "").trim();
}
