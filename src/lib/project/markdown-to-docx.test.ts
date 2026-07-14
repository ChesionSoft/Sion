import { describe, expect, it } from "vitest";
import { ExternalHyperlink, Paragraph, Table, TextRun } from "docx";
import {
  collectTocHeadings,
  parseMarkdownToMdast,
  renderBlock,
  renderInline,
  renderMdastBody,
} from "./markdown-to-docx";
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

/** 取一段 markdown 的第一个顶层块。 */
function firstBlockOf(md: string): MdastBlock {
  const root = parseMarkdownToMdast(md) as { children: MdastBlock[] };
  return root.children[0];
}

describe("renderBlock (paragraph + heading)", () => {
  it("renders a paragraph with its inline runs", () => {
    const els = renderBlock(firstBlockOf("正文 **粗**"));
    expect(els).toHaveLength(1);
    expect(els[0]).toBeInstanceOf(Paragraph);
    expect(xml(els)).toContain("粗");
  });

  it("maps heading depth 2 to Heading2", () => {
    const els = renderBlock(firstBlockOf("## 子小节"));
    expect(els[0]).toBeInstanceOf(Paragraph);
    expect(xml(els)).toContain("子小节");
    expect(xml(els)).toContain("Heading2");
  });

  it("wraps a heading in a bookmark when headingBookmarkId is provided", () => {
    const els = renderBlock(firstBlockOf("## 章节"), {
      headingOffset: 1,
      headingBookmarkId: () => "toc-1",
    });
    expect(xml(els)).toContain("toc-1");
    expect(xml(els)).toContain("Heading1");
  });

  it("maps heading depth 3 to Heading3", () => {
    const els = renderBlock(firstBlockOf("### 更深"));
    expect(xml(els)).toContain("Heading3");
  });

  it("maps heading depth 6 to Heading6", () => {
    const els = renderBlock(firstBlockOf("###### 最深"));
    expect(xml(els)).toContain("Heading6");
  });
});

describe("renderBlock lists", () => {
  it("renders an unordered list with bullet numbering at level 0", () => {
    const els = renderBlock(firstBlockOf("- a\n- b"));
    expect(els.every((e) => e instanceof Paragraph)).toBe(true);
    expect(els).toHaveLength(2);
    expect(xml(els)).toContain("a");
    expect(xml(els)).toContain("b");
    expect(xml(els)).toContain("w:numPr");
    expect(xml(els)).not.toContain("ordered-list");
  });

  it("renders an ordered list referencing the ordered-list numbering", () => {
    const els = renderBlock(firstBlockOf("1. one\n2. two"));
    expect(els).toHaveLength(2);
    expect(xml(els)).toContain("one");
    expect(xml(els)).toContain("ordered-list");
  });

  it("renders nested list items at level 1", () => {
    const els = renderBlock(firstBlockOf("- a\n  - nested\n- b"));
    expect(els).toHaveLength(3);
    expect(xml(els)).toContain("nested");
    // ilvl=1 出现一次（嵌套项）
    expect(xml(els)).toContain('"w:ilvl","root":[{"rootKey":"_attr","root":{"val":1}');
  });
});

describe("renderBlock table", () => {
  it("renders a GFM table as a docx Table with header + data rows", () => {
    const els = renderBlock(firstBlockOf("| A | B |\n| --- | ---: |\n| 1 | 2 |"));
    expect(els[0]).toBeInstanceOf(Table);
    const serialized = xml(els);
    expect(serialized).toContain("A");
    expect(serialized).toContain("B");
    expect(serialized).toContain("1");
    expect(serialized).toContain("2");
    // 两行（表头 + 数据）
    expect(serialized.match(/"rootKey":"w:tr"/g)).toHaveLength(2);
  });

  it("bolds and shades header cells", () => {
    const serialized = xml(renderBlock(firstBlockOf("| H |\n| --- |\n| v |")));
    expect(serialized).toContain("w:b");
    expect(serialized.toUpperCase()).toContain("F2F2F2");
  });

  it("applies right alignment to a right-aligned column", () => {
    const serialized = xml(renderBlock(firstBlockOf("| A |\n| ---: |\n| 1 |")));
    expect(serialized).toContain('"right"');
  });
});

describe("renderBlock misc + renderMdastBody", () => {
  it("renders a fenced code block as a shaded monospace paragraph", () => {
    const els = renderBlock(firstBlockOf("```js\nconst x = 1\n```"));
    expect(els).toHaveLength(1);
    expect(els[0]).toBeInstanceOf(Paragraph);
    const serialized = xml(els);
    expect(serialized).toContain("const x = 1");
    expect(serialized).toContain("Consolas");
    expect(serialized.toUpperCase()).toContain("F2F2F2");
  });

  it("renders a blockquote with a left border", () => {
    const els = renderBlock(firstBlockOf("> 引用文字"));
    const serialized = xml(els);
    expect(serialized).toContain("引用文字");
    expect(serialized).toContain("w:pBdr");
    expect(serialized).toContain("single");
  });

  it("renders a thematic break as a bottom-border paragraph", () => {
    const els = renderBlock(firstBlockOf("---"));
    expect(els[0]).toBeInstanceOf(Paragraph);
    expect(xml(els)).toContain("bottom");
  });

  it("skips raw html blocks", () => {
    // remark treats short inline-ish html as a paragraph; a true html block is
    // rare in these docs. Test the branch directly with a constructed node.
    const htmlBlock = { type: "html", value: '<a name="x"></a>' } as MdastBlock;
    expect(renderBlock(htmlBlock)).toHaveLength(0);
  });

  it("renderMdastBody renders multiple blocks in order", () => {
    const els = renderMdastBody("## 标题\n\n正文\n\n- 项");
    expect(els.length).toBeGreaterThanOrEqual(3);
    const serialized = xml(els);
    expect(serialized).toContain("标题");
    expect(serialized).toContain("正文");
    expect(serialized).toContain("项");
  });
});

describe("renderMdastBody headingOffset", () => {
  it("shifts heading levels down by headingOffset", () => {
    const els = renderMdastBody("## a\n\n### b", { headingOffset: 1 });
    const serialized = xml(els);
    // ## -> Heading1, ### -> Heading2
    expect(serialized).toContain("Heading1");
    expect(serialized).toContain("Heading2");
  });

  it("defaults to no offset (## -> Heading2)", () => {
    const els = renderMdastBody("## a");
    expect(xml(els)).toContain("Heading2");
  });
});

describe("collectTocHeadings", () => {
  it("collects H1–H3 after headingOffset with stable bookmark ids", () => {
    // With headingOffset=1: ##→1, ###→2, ####→3, #####→4 (excluded by maxLevel 3)
    const root = parseMarkdownToMdast(
      "## 章一\n\n正文\n\n### 节 A\n\n## 章二\n\n##### 更深不收录",
    ) as { children: MdastBlock[] };
    const entries = collectTocHeadings(root.children, 1, 3);
    expect(entries).toEqual([
      { title: "章一", level: 1, bookmarkId: "toc-1" },
      { title: "节 A", level: 2, bookmarkId: "toc-2" },
      { title: "章二", level: 1, bookmarkId: "toc-3" },
    ]);
  });
});
