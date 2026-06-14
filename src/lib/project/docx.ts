import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { Project } from "./types";

export async function createProjectDesignDocx(project: Project, markdown: string): Promise<Buffer> {
  const paragraphs = markdown.split("\n").map((line) => {
    if (line.startsWith("# ")) {
      return new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: line.replace("# ", ""), bold: true })],
      });
    }

    if (line.startsWith("## ")) {
      return new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: line.replace("## ", ""), bold: true })],
      });
    }

    if (line.startsWith("### ")) {
      return new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: line.replace("### ", ""), bold: true })],
      });
    }

    return new Paragraph({
      children: [new TextRun(line)],
    });
  });

  const document = new Document({
    creator: project.authorName || "AI Project Docs",
    title: `${project.name}项目开发设计文档`,
    description: "小型外包项目开发设计文档",
    sections: [
      {
        children: paragraphs,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(document));
}
