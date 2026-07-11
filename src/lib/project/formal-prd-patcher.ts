import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Heading, Root, Text } from "mdast";
import { UnpatchableError } from "./node-markdown-patcher";
import type { DraftPatch, DraftPatchOp, DraftPatchResult } from "./formal-prd";

/**
 * mdast-backed section patching for formal PRD draft Markdown.
 *
 * The formal draft is plain Markdown whose top-level structure is `## ` (H2)
 * sections. This patcher applies `replace` / `remove` / `insert` ops against
 * H2 sections only: a section's body spans from its heading to the next heading
 * of depth <= 2 (or EOF), so nested H3+ content stays with its parent H2.
 *
 * Each op is applied sequentially against the running Markdown. A per-op
 * `UnpatchableError` (missing target, ambiguous heading, H2 smuggled into a
 * replacement body) skips only that op; every input op yields one result entry.
 * Malformed parser/runtime failures are rethrown.
 */

/** A CommonMark H2 line, allowing up to three leading spaces but not H3+. */
const H2_LINE_PATTERN = /^(?: {0,3})##(?!#)[\t ]+/m;

function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Root;
}

/** Recursively extract the visible text of a heading. */
function getHeadingText(heading: Heading): string {
  const parts: string[] = [];
  function walk(nodes: Heading["children"]): void {
    for (const node of nodes) {
      if (node.type === "text") {
        parts.push((node as Text).value);
      } else if ("children" in node) {
        walk(node.children as Heading["children"]);
      }
    }
  }
  walk(heading.children);
  return parts.join("");
}

interface HeadingInfo {
  heading: Heading;
  text: string;
}

function collectHeadings(root: Root): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  for (const child of root.children) {
    if (child.type === "heading") {
      headings.push({ heading: child, text: getHeadingText(child) });
    }
  }
  return headings;
}

interface SectionRange {
  /** Offset where the `## ` line starts. */
  headingStart: number;
  /** Offset immediately after the heading text (before its trailing newline). */
  bodyStart: number;
  /** Offset where the body ends: next depth<=2 heading start, or EOF. */
  bodyEnd: number;
}

/**
 * Locate an H2 section by exact heading text. Returns null if no H2 matches;
 * throws `UnpatchableError` if two H2s share the text (ambiguous target).
 */
function locateH2Section(root: Root, markdown: string, headingText: string): SectionRange | null {
  const headings = collectHeadings(root);
  const matching = headings.filter((h) => h.text === headingText && h.heading.depth === 2);
  if (matching.length > 1) {
    throw new UnpatchableError(`章节标题重复，无法定位：${headingText}`);
  }
  if (matching.length === 0) {
    return null;
  }
  const heading = matching[0].heading;
  const headingStart = heading.position!.start.offset!;
  const bodyStart = heading.position!.end.offset!;
  const headingIndex = headings.findIndex((h) => h.heading === heading);

  let bodyEnd = markdown.length;
  for (let i = headingIndex + 1; i < headings.length; i++) {
    if (headings[i].heading.depth <= 2) {
      bodyEnd = headings[i].heading.position!.start.offset!;
      break;
    }
  }
  return { headingStart, bodyStart, bodyEnd };
}

/** Trim leading/trailing blank lines and normalize newlines. */
function normalizeBody(body: string): string {
  return body.replace(/\r?\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/** Collapse 3+ consecutive newlines to a single blank line and trim trailing blanks to one newline. */
function collapseBlankLines(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").replace(/\n+$/g, "\n");
}

function replaceBody(markdown: string, range: SectionRange, body: string): string {
  assertNoH2Body(body);
  const normalized = normalizeBody(body);
  const atEnd = range.bodyEnd >= markdown.length;
  // One blank line after the H2; one blank line before the next section (or a
  // single trailing newline at EOF).
  const replacement = atEnd ? `\n\n${normalized}\n` : `\n\n${normalized}\n\n`;
  return markdown.slice(0, range.bodyStart) + replacement + markdown.slice(range.bodyEnd);
}

function assertNoH2Body(body: string): void {
  if (H2_LINE_PATTERN.test(body)) {
    throw new UnpatchableError("章节正文不得包含二级标题（##）行");
  }
}

function removeSection(markdown: string, range: SectionRange): string {
  return collapseBlankLines(markdown.slice(0, range.headingStart) + markdown.slice(range.bodyEnd));
}

function insertSection(
  markdown: string,
  anchorEnd: number | null,
  heading: string,
  body: string,
): string {
  assertNoH2Body(body);
  const normalized = normalizeBody(body);
  const section = `## ${heading}\n\n${normalized}`;

  if (anchorEnd === null) {
    // Append at EOF: ensure exactly one blank line before the new section.
    const trimmedBefore = markdown.replace(/\n+$/, "");
    return `${trimmedBefore}\n\n${section}\n`;
  }

  const before = markdown.slice(0, anchorEnd);
  const after = markdown.slice(anchorEnd);
  const trimmedBefore = before.replace(/\n+$/, "");
  const trimmedAfter = after.replace(/^\n+/, "");
  const lead = trimmedBefore.length > 0 ? "\n\n" : "";
  const trail = trimmedAfter.length > 0 ? "\n\n" : "\n";
  return trimmedBefore + lead + section + trail + trimmedAfter;
}

function applyDraftOp(markdown: string, op: DraftPatchOp): string {
  const root = parseMarkdown(markdown);

  if (op.op === "replace") {
    const range = locateH2Section(root, markdown, op.heading);
    if (!range) throw new UnpatchableError(`未找到章节：${op.heading}`);
    return replaceBody(markdown, range, op.body);
  }

  if (op.op === "remove") {
    const range = locateH2Section(root, markdown, op.heading);
    if (!range) throw new UnpatchableError(`未找到章节：${op.heading}`);
    return removeSection(markdown, range);
  }

  // op.op === "insert"
  let anchorEnd: number | null = null;
  if (op.afterHeading) {
    const range = locateH2Section(root, markdown, op.afterHeading);
    if (!range) throw new UnpatchableError(`未找到锚点章节：${op.afterHeading}`);
    anchorEnd = range.bodyEnd;
  }
  return insertSection(markdown, anchorEnd, op.heading, op.body);
}

export function applyDraftPatches(
  markdown: string,
  patch: DraftPatch,
): { markdown: string; applied: DraftPatchResult[] } {
  let result = markdown;
  const applied: DraftPatchResult[] = [];
  for (const op of patch.ops) {
    try {
      result = applyDraftOp(result, op);
      applied.push({ op, status: "applied" });
    } catch (err) {
      if (err instanceof UnpatchableError) {
        applied.push({ op, status: "skipped", reason: err.message });
        continue;
      }
      throw err;
    }
  }
  return { markdown: result, applied };
}
