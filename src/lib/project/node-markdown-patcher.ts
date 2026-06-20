import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Heading, Root, Table, Text } from "mdast";
import { getDeliverySchema, getDeliverySection } from "./node-delivery-schemas";
import type { DeliverySection } from "./node-delivery-schemas";
import type { NodeMarkdownPatch, PatchKind, WorkflowNodeId } from "./types";

// ---------------------------------------------------------------------------
// UnpatchableError
// ---------------------------------------------------------------------------

export class UnpatchableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpatchableError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively extract text from a heading's children. */
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

/** Collect all headings from the mdast root. */
function collectHeadings(root: Root): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  for (const child of root.children) {
    if (child.type === "heading") {
      headings.push({ heading: child, text: getHeadingText(child) });
    }
  }
  return headings;
}

/** Parse markdown with GFM extensions. */
function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Root;
}

// ---------------------------------------------------------------------------
// Section location
// ---------------------------------------------------------------------------

interface SectionLocation {
  /** The heading node. */
  heading: Heading;
  /** Offset (in the full markdown) where the body starts (after the heading line). */
  bodyStart: number;
  /** Offset (in the full markdown) where the body ends (start of next heading or EOF). */
  bodyEnd: number;
}

/**
 * Find a section by heading text and level in the parsed markdown.
 * Throws UnpatchableError if ambiguous (two headings with same text and depth).
 * Returns null if the section is not found.
 */
function locateSection(
  root: Root,
  markdown: string,
  headingText: string,
  level: number,
): SectionLocation | null {
  const headings = collectHeadings(root);

  // Find matching headings (keep as array for ambiguity detection)
  const matching = headings.filter((h) => h.text === headingText && h.heading.depth === level);

  if (matching.length > 1) {
    throw new UnpatchableError(`ambiguous heading: ${headingText}`);
  }

  if (matching.length === 0) {
    return null;
  }

  const heading = matching[0].heading;
  const bodyStart = heading.position!.end.offset!;
  const headingIndex = headings.findIndex((h) => h.heading === heading);

  // Find the next heading at same or higher level
  let bodyEnd = markdown.length;
  for (let i = headingIndex + 1; i < headings.length; i++) {
    if (headings[i].heading.depth <= level) {
      bodyEnd = headings[i].heading.position!.start.offset!;
      break;
    }
  }

  return { heading, bodyStart, bodyEnd };
}

// ---------------------------------------------------------------------------
// Body manipulation helpers
// ---------------------------------------------------------------------------

/**
 * Find the offset (within the body string) of the end of the last bullet line.
 * Returns 0 if no bullets found.
 */
function findLastBulletEndInBody(body: string): number {
  const lines = body.split("\n");
  let lastBulletLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[-*+]\s/.test(lines[i])) {
      lastBulletLineIndex = i;
    }
  }
  if (lastBulletLineIndex === -1) return 0;

  // Compute the offset of the end of the last bullet line (including its trailing newline)
  let offset = 0;
  for (let i = 0; i <= lastBulletLineIndex; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  return offset;
}

/** Extract normalized bullet texts from a body string. */
function extractBulletTexts(body: string): string[] {
  const lines = body.split("\n");
  const bullets: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*[-*+]\s+(.*)/);
    if (match) {
      bullets.push(match[1].trim());
    }
  }
  return bullets;
}

/** Extract block texts (paragraphs separated by blank lines) from a body string. */
function extractBlockTexts(body: string): string[] {
  // Split by blank lines (two or more newlines)
  const blocks = body.split(/\n\n+/);
  return blocks.map((b) => b.trim()).filter((b) => b.length > 0);
}

/**
 * Find a Table node within a body interval of the full markdown.
 * Returns the table node and its position info, or null.
 */
function findTableInBody(
  root: Root,
  bodyStart: number,
  bodyEnd: number,
): { table: Table; lastRowEnd: number } | null {
  for (const child of root.children) {
    if (child.type === "table" && child.position) {
      const tStart = child.position.start.offset!;
      const tEnd = child.position.end.offset!;
      // Check if the table is within the body interval
      if (tStart >= bodyStart && tEnd <= bodyEnd) {
        const rows = child.children;
        if (rows.length > 0) {
          const lastRow = rows[rows.length - 1];
          const lastRowEnd = lastRow.position?.end.offset ?? tEnd;
          return { table: child, lastRowEnd };
        }
        return { table: child, lastRowEnd: tEnd };
      }
    }
  }
  return null;
}

/** Get the column count from a table's first row. */
function getTableColumnCount(table: Table): number {
  if (table.children.length === 0) return 0;
  return table.children[0].children.length;
}

/** Normalize a table row string for dedup comparison. */
function normalizeTableRow(row: string): string {
  return row.trim();
}

/** Check if a table row already exists in the table. */
function isTableRowDuplicate(table: Table, patchRow: string): boolean {
  const normalizedPatch = normalizeTableRow(patchRow);
  // Skip the first row (header) for dedup
  for (let i = 1; i < table.children.length; i++) {
    const row = table.children[i];
    // Reconstruct the row string from the mdast nodes
    const cells = row.children.map((cell) => {
      // Extract text from cell children
      const textParts: string[] = [];
      function walk(nodes: typeof cell.children): void {
        for (const n of nodes) {
          if (n.type === "text") {
            textParts.push((n as Text).value);
          } else if ("children" in n) {
            walk(n.children as typeof cell.children);
          }
        }
      }
      walk(cell.children);
      return textParts.join("").trim();
    });
    const rowStr = `| ${cells.join(" | ")} |`;
    if (normalizeTableRow(rowStr) === normalizedPatch) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Schema-order insertion point
// ---------------------------------------------------------------------------

/**
 * Find the offset in the markdown where a new section should be inserted,
 * based on schema section order. Returns the offset before the next existing
 * schema section, or markdown.length (EOF) if none found.
 */
function findSchemaInsertionPoint(
  root: Root,
  markdown: string,
  nodeId: WorkflowNodeId,
  sectionKey: string,
): number {
  const schema = getDeliverySchema(nodeId);
  if (!schema) return markdown.length;

  const sectionIndex = schema.sections.findIndex((s) => s.key === sectionKey);
  if (sectionIndex === -1) return markdown.length;

  // Look for the next schema section (by index) that exists in the markdown
  const headings = collectHeadings(root);

  for (let i = sectionIndex + 1; i < schema.sections.length; i++) {
    const nextSection = schema.sections[i];
    // Find this section's heading in the markdown
    const matching = headings.find(
      (h) => h.text === nextSection.heading && h.heading.depth === nextSection.level,
    );
    if (matching) {
      return matching.heading.position!.start.offset!;
    }
  }

  return markdown.length;
}

// ---------------------------------------------------------------------------
// Section creation
// ---------------------------------------------------------------------------

/**
 * Create a new section markdown string.
 * For table sections, includes the table structure.
 */
function createSectionContent(
  section: DeliverySection,
  patch: NodeMarkdownPatch,
  fullContent?: string,
): string {
  const heading = `${"#".repeat(section.level)} ${section.heading}`;

  if (patch.patchKind === "append_table_row" && section.tableColumns) {
    const headerRow = `| ${section.tableColumns.join(" | ")} |`;
    const separatorRow = `| ${section.tableColumns.map(() => "---").join(" | ")} |`;
    const dataRow = fullContent ?? patch.markdown;
    return `\n${heading}\n\n${headerRow}\n${separatorRow}\n${dataRow}\n`;
  }

  const content = fullContent ?? patch.markdown;
  if (patch.patchKind === "append_bullet") {
    const bulletText = content.startsWith("- ") ? content : `- ${content}`;
    return `\n${heading}\n\n${bulletText}\n`;
  }

  return `\n${heading}\n\n${content}\n`;
}

// ---------------------------------------------------------------------------
// Patch application helpers
// ---------------------------------------------------------------------------

/** Format partial patch content for preview. */
function formatPartialContent(
  patch: NodeMarkdownPatch,
  visibleCharacterCount: number,
): string {
  if (patch.patchKind === "append_bullet") {
    const text = patch.markdown.startsWith("- ") ? patch.markdown.slice(2) : patch.markdown;
    const visible = text.slice(0, visibleCharacterCount);
    return `- ${visible}`;
  }
  if (patch.patchKind === "append_table_row") {
    return patch.markdown.slice(0, visibleCharacterCount);
  }
  // append_block
  return patch.markdown.slice(0, visibleCharacterCount);
}

// ---------------------------------------------------------------------------
// applyPatches
// ---------------------------------------------------------------------------

/**
 * Apply patches to a markdown string.
 * Returns the updated markdown and the list of patches that were actually applied
 * (excluding deduped skips).
 */
export function applyPatches(
  nodeId: WorkflowNodeId,
  markdown: string,
  patches: NodeMarkdownPatch[],
): { markdown: string; applied: NodeMarkdownPatch[] } {
  if (patches.length === 0) {
    return { markdown, applied: [] };
  }

  const schema = getDeliverySchema(nodeId);
  if (!schema) {
    throw new UnpatchableError(`No delivery schema for node: ${nodeId}`);
  }

  let result = markdown;
  const applied: NodeMarkdownPatch[] = [];

  for (const patch of patches) {
    // Schema-level validation — errors propagate to the caller. The /patch
    // endpoint pre-validates and returns 422; direct callers get the throw.
    const validated = validateNodeMarkdownPatch(nodeId, patch);

    try {
    // Get section schema
    const section = getDeliverySection(nodeId, validated.targetSectionKey);
    if (!section) {
      throw new UnpatchableError(`Unknown section: ${validated.targetSectionKey}`);
    }

    // Parse current markdown
    const root = parseMarkdown(result);

    // Locate the section
    const location = locateSection(root, result, section.heading, section.level);

    if (!location) {
      // Section doesn't exist — create it
      if (section.required || validated.markdown.length > 0) {
        const insertPoint = findSchemaInsertionPoint(root, result, nodeId, validated.targetSectionKey);
        const newSection = createSectionContent(section, validated);
        result = result.slice(0, insertPoint) + newSection + result.slice(insertPoint);
        applied.push(validated);
      }
      continue;
    }

    const { bodyStart, bodyEnd } = location;
    const body = result.slice(bodyStart, bodyEnd);

    // Apply based on patch kind
    if (validated.patchKind === "append_bullet") {
      const bulletText = validated.markdown.startsWith("- ")
        ? validated.markdown.slice(2)
        : validated.markdown;
      const normalizedBullet = bulletText.trim();

      // Dedup
      const existingBullets = extractBulletTexts(body);
      if (existingBullets.includes(normalizedBullet)) {
        continue; // Skip duplicate
      }

      const formattedBullet = `- ${bulletText}`;
      const lastBulletEnd = findLastBulletEndInBody(body);
      const newBody =
        body.slice(0, lastBulletEnd) + formattedBullet + "\n" + body.slice(lastBulletEnd);
      result = result.slice(0, bodyStart) + newBody + result.slice(bodyEnd);
      applied.push(validated);
    } else if (validated.patchKind === "append_block") {
      const normalizedBlock = validated.markdown.trim();

      // Dedup
      const existingBlocks = extractBlockTexts(body);
      if (existingBlocks.includes(normalizedBlock)) {
        continue; // Skip duplicate
      }

      const trimmedBody = body.replace(/\n+$/, "");
      const newBody = trimmedBody + "\n\n" + validated.markdown;
      result = result.slice(0, bodyStart) + newBody + result.slice(bodyEnd);
      applied.push(validated);
    } else if (validated.patchKind === "append_table_row") {
      const tableInfo = findTableInBody(root, bodyStart, bodyEnd);

      if (tableInfo) {
        // Existing table — validate column count
        const colCount = getTableColumnCount(tableInfo.table);
        const patchCols = validated.markdown.split("|").filter((c) => c.trim().length > 0).length;
        if (patchCols !== colCount) {
          throw new UnpatchableError(
            `Column count mismatch: patch has ${patchCols} columns, table has ${colCount} columns`,
          );
        }

        // Dedup
        if (isTableRowDuplicate(tableInfo.table, validated.markdown)) {
          continue; // Skip duplicate
        }

        // Insert after the last row
        const insertPoint = tableInfo.lastRowEnd;
        const newRow = "\n" + validated.markdown;
        result = result.slice(0, insertPoint) + newRow + result.slice(insertPoint);
        applied.push(validated);
      } else {
        // No existing table — create one
        if (!section.tableColumns) {
          throw new UnpatchableError(
            `Section ${validated.targetSectionKey} has no tableColumns defined`,
          );
        }

        // Validate column count against schema
        const patchCols = validated.markdown.split("|").filter((c) => c.trim().length > 0).length;
        if (patchCols !== section.tableColumns.length) {
          throw new UnpatchableError(
            `Column count mismatch: patch has ${patchCols} columns, schema expects ${section.tableColumns.length}`,
          );
        }

        const headerRow = `| ${section.tableColumns.join(" | ")} |`;
        const separatorRow = `| ${section.tableColumns.map(() => "---").join(" | ")} |`;
        const tableContent = `\n${headerRow}\n${separatorRow}\n${validated.markdown}\n`;

        // Insert at the end of the body
        const newBody = body + tableContent;
        result = result.slice(0, bodyStart) + newBody + result.slice(bodyEnd);
        applied.push(validated);
      }
    }
    } catch (error) {
      // Tolerate per-patch runtime failures (column-count mismatch against
      // an existing table, ambiguous heading, section can't be located):
      // skip this patch and keep applying the rest. Schema-level invalid
      // patches are still rejected upstream by the /patch endpoint's
      // pre-validation (422), so this only catches document-state issues.
      if (error instanceof UnpatchableError) continue;
      throw error;
    }
  }

  return { markdown: result, applied };
}

// ---------------------------------------------------------------------------
// applyPartialPatchForPreview
// ---------------------------------------------------------------------------

/**
 * Apply a single patch partially for preview animation.
 * Shows only the first `visibleCharacterCount` characters of the patch content
 * at the insertion point. The rest of the markdown stays as the base.
 *
 * Semantics by patch kind:
 * - append_table_row: when the section already has a table, only the new row
 *   types out (existing table stays fixed); when creating a new table, the
 *   header+separator appear at frame 0 and the data row types out.
 * - append_bullet: the `- ` prefix appears at frame 0, then the text types out.
 * - append_block: the block text types out from frame 0.
 */
export function applyPartialPatchForPreview(
  nodeId: WorkflowNodeId,
  markdown: string,
  patch: NodeMarkdownPatch,
  visibleCharacterCount: number,
): string {
  const validated = validateNodeMarkdownPatch(nodeId, patch);
  const section = getDeliverySection(nodeId, validated.targetSectionKey);
  if (!section) {
    throw new UnpatchableError(`Unknown section: ${validated.targetSectionKey}`);
  }

  const root = parseMarkdown(markdown);
  const location = locateSection(root, markdown, section.heading, section.level);

  if (!location) {
    // Section doesn't exist — create it with partial content
    const insertPoint = findSchemaInsertionPoint(root, markdown, nodeId, validated.targetSectionKey);
    const partialContent = formatPartialContent(validated, visibleCharacterCount);

    if (validated.patchKind === "append_table_row" && section.tableColumns) {
      const headerRow = `| ${section.tableColumns.join(" | ")} |`;
      const separatorRow = `| ${section.tableColumns.map(() => "---").join(" | ")} |`;
      const heading = `${"#".repeat(section.level)} ${section.heading}`;

      if (visibleCharacterCount === 0) {
        // Just the heading and table structure, no data row
        const newSection = `\n${heading}\n\n${headerRow}\n${separatorRow}\n`;
        return markdown.slice(0, insertPoint) + newSection + markdown.slice(insertPoint);
      }

      const dataRow = partialContent;
      const newSection = `\n${heading}\n\n${headerRow}\n${separatorRow}\n${dataRow}\n`;
      return markdown.slice(0, insertPoint) + newSection + markdown.slice(insertPoint);
    }

    if (validated.patchKind === "append_bullet") {
      const newSection = createSectionContent(section, validated, partialContent);
      return markdown.slice(0, insertPoint) + newSection + markdown.slice(insertPoint);
    }

    // append_block
    const heading = `${"#".repeat(section.level)} ${section.heading}`;
    const newSection = `\n${heading}\n\n${partialContent}\n`;
    return markdown.slice(0, insertPoint) + newSection + markdown.slice(insertPoint);
  }

  const { bodyStart, bodyEnd } = location;
  const body = markdown.slice(bodyStart, bodyEnd);
  const partialContent = formatPartialContent(validated, visibleCharacterCount);

  if (validated.patchKind === "append_bullet") {
    const lastBulletEnd = findLastBulletEndInBody(body);
    const newBody = body.slice(0, lastBulletEnd) + partialContent + "\n" + body.slice(lastBulletEnd);
    return markdown.slice(0, bodyStart) + newBody + markdown.slice(bodyEnd);
  }

  if (validated.patchKind === "append_block") {
    const trimmedBody = body.replace(/\n+$/, "");
    const newBody = trimmedBody + "\n\n" + partialContent;
    return markdown.slice(0, bodyStart) + newBody + markdown.slice(bodyEnd);
  }

  if (validated.patchKind === "append_table_row") {
    const tableInfo = findTableInBody(root, bodyStart, bodyEnd);

    if (tableInfo) {
      if (visibleCharacterCount === 0) {
        // No row content — return markdown unchanged
        return markdown;
      }
      const insertPoint = tableInfo.lastRowEnd;
      const newRow = "\n" + partialContent;
      return markdown.slice(0, insertPoint) + newRow + markdown.slice(insertPoint);
    }

    // No existing table — create one
    if (!section.tableColumns) {
      throw new UnpatchableError(
        `Section ${validated.targetSectionKey} has no tableColumns defined`,
      );
    }

    const headerRow = `| ${section.tableColumns.join(" | ")} |`;
    const separatorRow = `| ${section.tableColumns.map(() => "---").join(" | ")} |`;

    if (visibleCharacterCount === 0) {
      // Just the table structure, no data row
      const tableContent = `\n${headerRow}\n${separatorRow}\n`;
      const newBody = body + tableContent;
      return markdown.slice(0, bodyStart) + newBody + markdown.slice(bodyEnd);
    }

    const tableContent = `\n${headerRow}\n${separatorRow}\n${partialContent}\n`;
    const newBody = body + tableContent;
    return markdown.slice(0, bodyStart) + newBody + markdown.slice(bodyEnd);
  }

  return markdown;
}

// ---------------------------------------------------------------------------
// validateNodeMarkdownPatch
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as a NodeMarkdownPatch.
 * Throws UnpatchableError if invalid.
 */
export function validateNodeMarkdownPatch(
  nodeId: WorkflowNodeId,
  patch: unknown,
): NodeMarkdownPatch {
  if (patch === null || patch === undefined || typeof patch !== "object") {
    throw new UnpatchableError("Patch must be a non-null object");
  }

  const p = patch as Record<string, unknown>;

  // Validate category
  const validCategories = ["confirmed_fact", "assumption", "open_question"];
  if (!validCategories.includes(p.category as string)) {
    throw new UnpatchableError(
      `Invalid category: ${String(p.category)}. Must be one of: ${validCategories.join(", ")}`,
    );
  }

  // Validate targetSectionKey
  if (typeof p.targetSectionKey !== "string" || p.targetSectionKey.length === 0) {
    throw new UnpatchableError("targetSectionKey must be a non-empty string");
  }
  const section = getDeliverySection(nodeId, p.targetSectionKey);
  if (!section) {
    throw new UnpatchableError(`Unknown section key: ${p.targetSectionKey}`);
  }

  // Validate patchKind
  const validPatchKinds: PatchKind[] = ["append_bullet", "append_block", "append_table_row"];
  if (!validPatchKinds.includes(p.patchKind as PatchKind)) {
    throw new UnpatchableError(
      `Invalid patchKind: ${String(p.patchKind)}. Must be one of: ${validPatchKinds.join(", ")}`,
    );
  }
  if (!section.allowedPatchKinds.includes(p.patchKind as PatchKind)) {
    throw new UnpatchableError(
      `patchKind "${String(p.patchKind)}" is not allowed for section "${p.targetSectionKey}"`,
    );
  }

  // Validate markdown
  if (typeof p.markdown !== "string" || p.markdown.length === 0) {
    throw new UnpatchableError("markdown must be a non-empty string");
  }
  // Check for heading lines in the fragment
  const lines = p.markdown.split("\n");
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      throw new UnpatchableError("Patch markdown must not contain heading lines");
    }
  }

  // Validate evidence
  if (!p.evidence || typeof p.evidence !== "object") {
    throw new UnpatchableError("evidence must be an object");
  }
  const evidence = p.evidence as Record<string, unknown>;
  if (evidence.source !== "user" && evidence.source !== "assistant") {
    throw new UnpatchableError('evidence.source must be "user" or "assistant"');
  }
  if (typeof evidence.quote !== "string" || evidence.quote.length === 0) {
    throw new UnpatchableError("evidence.quote must be a non-empty string");
  }

  return {
    category: p.category as NodeMarkdownPatch["category"],
    targetSectionKey: p.targetSectionKey,
    patchKind: p.patchKind as PatchKind,
    markdown: p.markdown,
    evidence: { source: evidence.source as "user" | "assistant", quote: evidence.quote },
  };
}
