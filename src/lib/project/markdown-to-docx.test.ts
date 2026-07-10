import { describe, expect, it } from "vitest";
import { ExternalHyperlink, TextRun } from "docx";
import { parseMarkdownToMdast, renderInline } from "./markdown-to-docx";
import type { MdastBlock, MdastInline } from "./markdown-to-docx";

/** 取一段 markdown 第一个段落（或块）的行内子节点。 */
function inlineOf(md: string): MdastInline[] {
  const root = parseMarkdownToMdast(md) as { children: MdastBlock[] };
  const block = root.children[0];
  if (!block || block.type !== "paragraph") return [];
  return block.children;
}

const xml = (o: unknown): string => JSON.stringify(o);

describe("renderInline", () => {
  it("renders plain text as a single TextRun", () => {
    const runs = renderInline(inlineOf("hello"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBeInstanceOf(TextRun);
    expect(xml(runs)).toContain("hello");
  });

  it("renders strong as a bold TextRun (w:b)", () => {
    const runs = renderInline(inlineOf("正文 **粗**"));
    expect(xml(runs)).toContain("粗");
    expect(xml(runs)).toContain("w:b");
  });

  it("renders emphasis as italic (w:i)", () => {
    const runs = renderInline(inlineOf("正文 *斜*"));
    expect(xml(runs)).toContain("w:i");
  });

  it("renders strikethrough as w:strike", () => {
    const runs = renderInline(inlineOf("~~删~~"));
    expect(xml(runs)).toContain("删");
    expect(xml(runs)).toContain("w:strike");
  });

  it("renders inlineCode with a monospace font", () => {
    const runs = renderInline(inlineOf("代码 `code`"));
    expect(xml(runs)).toContain("code");
    expect(xml(runs)).toContain("Consolas");
  });

  it("renders a link as an ExternalHyperlink", () => {
    const runs = renderInline(inlineOf("[l](https://x)"));
    expect(runs.some((r) => r instanceof ExternalHyperlink)).toBe(true);
    expect(xml(runs)).toContain("0563C1");
  });

  it("renders an image as bracketed alt text", () => {
    const runs = renderInline(inlineOf("![alt text](https://i/x.png)"));
    expect(xml(runs)).toContain("[alt text]");
  });
});
