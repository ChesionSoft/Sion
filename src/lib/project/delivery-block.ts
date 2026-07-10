import type { NodeMarkdownPatch, PatchKind, WorkflowNodeId } from "./types";
import { getDeliverySchema } from "./node-delivery-schemas";

// The ```delivery block is JSON, and `markdown` field values can themselves
// contain triple-backtick fences (e.g. an ASCII topology diagram). A non-greedy
// fence regex closes at that inner ```, truncating the JSON. So we don't rely
// on the closing fence for the boundary: the opening ```delivery is just a
// marker, and the object body is read by brace-balanced, string-aware
// `findJsonObjectRange`, which treats ``` / { / } inside JSON strings as
// ordinary characters. A fresh regex instance is created per call so its
// lastIndex never leaks across invocations.
const DELIVERY_OPEN = "```delivery";

/**
 * Find the byte range of the first balanced `{...}` JSON object in `text`,
 * tolerating prose or thinking tags before/after it. Tracks brace depth while
 * respecting string literals and escapes so braces inside strings don't break
 * the count. Moved here from node-fact-judge.ts.
 */
function findJsonObjectRange(text: string): { start: number; end: number } | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
      if (depth < 0) return null;
    }
  }
  return null;
}

/**
 * Extract the first balanced `{...}` JSON object from `text`, tolerating prose
 * or thinking tags around it.
 */
export function extractFirstJsonObject(text: string): string | null {
  const range = findJsonObjectRange(text);
  return range ? text.slice(range.start, range.end) : null;
}

/** Parse a raw fence body as JSON, tolerating prose/thinking-tag wrapping. */
function parseJsonLenient(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const innerFence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates = [
      innerFence ? innerFence[1].trim() : null,
      extractFirstJsonObject(trimmed),
    ].filter((s): s is string => !!s);
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // try the next candidate
      }
    }
    return null;
  }
}

/** Build one NodeMarkdownPatch from a parsed change item, or null if malformed. */
function toPatch(item: unknown): NodeMarkdownPatch | null {
  if (!item || typeof item !== "object") return null;
  const p = item as Record<string, unknown>;
  const sectionKey =
    typeof p.sectionKey === "string"
      ? p.sectionKey
      : typeof p.targetSectionKey === "string"
        ? p.targetSectionKey
        : null;
  const patchKind = typeof p.patchKind === "string" ? (p.patchKind as PatchKind) : null;
  const markdown = typeof p.markdown === "string" ? p.markdown : null;
  if (!sectionKey || !patchKind || !markdown) return null;
  return {
    category: "assumption",
    targetSectionKey: sectionKey,
    patchKind,
    markdown,
    evidence: { source: "assistant", quote: markdown.slice(0, 80) || "(generated)" },
  };
}

/**
 * Parse every ```delivery fenced block in `content` into NodeMarkdownPatch[].
 * Synthesizes neutral `category`/`evidence` defaults (the delivery document
 * never reads them). Section/patchKind/column validation is deferred to
 * applyPatches, which skips invalid patches via validateNodeMarkdownPatch.
 */
export function parseDeliveryBlock(content: string): NodeMarkdownPatch[] {
  const patches: NodeMarkdownPatch[] = [];
  const re = new RegExp(DELIVERY_OPEN, "g");
  // Find each ```delivery marker; read the full JSON object after it by brace
  // balance (string-aware), so inner ``` / braces in `markdown` values don't
  // truncate the object. An incomplete object (still streaming) yields null
  // and is skipped — the UI shows the streaming placeholder in that case.
  for (let open = re.exec(content); open !== null; open = re.exec(content)) {
    const after = content.slice(open.index + open[0].length);
    const range = findJsonObjectRange(after);
    if (range == null) {
      // No object after this marker: advance just past it so we don't loop
      // forever on a lone ```delivery.
      re.lastIndex = open.index + open[0].length;
      continue;
    }
    const parsed = parseJsonLenient(after.slice(range.start, range.end));
    if (parsed && typeof parsed === "object") {
      const changes = (parsed as { changes?: unknown[] }).changes;
      if (Array.isArray(changes)) {
        for (const item of changes) {
          const patch = toPatch(item);
          if (patch) patches.push(patch);
        }
      }
    }
    // Advance past this object so a subsequent ```delivery block is found.
    re.lastIndex = open.index + open[0].length + range.end;
  }
  return patches;
}

/**
 * Remove every ```delivery fenced block from `content` (used to keep the
 * model's chat history free of structured noise). Each block is taken as the
 * ```delivery marker plus the balanced JSON object after it, plus an optional
 * closing ``` fence; the body is read by brace balance so inner ``` in a
 * `markdown` value doesn't leave a fragment behind. Collapses 3+ blank lines
 * left behind and trims trailing whitespace.
 */
export function stripDeliveryBlock(content: string): string {
  const re = new RegExp(DELIVERY_OPEN, "g");
  let out = "";
  let cursor = 0;
  for (let open = re.exec(content); open !== null; open = re.exec(content)) {
    out += content.slice(cursor, open.index);
    const after = content.slice(open.index + open[0].length);
    const range = findJsonObjectRange(after);
    if (range == null) {
      // No object to bound the block: drop to end of content.
      cursor = content.length;
      break;
    }
    let blockEnd = open.index + open[0].length + range.end;
    // Also consume an optional closing ``` fence (and the whitespace/newline
    // right before it) so it doesn't linger in the stripped history.
    const closeMatch = /^\s*```/.exec(content.slice(blockEnd));
    if (closeMatch) blockEnd += closeMatch[0].length;
    cursor = blockEnd;
    re.lastIndex = blockEnd;
  }
  out += content.slice(cursor);
  return out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

/**
 * Build the "available sections" list for the node's system prompt so the
 * model emits valid sectionKey / patchKind in its delivery block.
 */
export function buildDeliverySectionsList(nodeId: WorkflowNodeId): string {
  const schema = getDeliverySchema(nodeId);
  if (!schema) return "(未知节点)";
  return schema.sections
    .map(
      (s) =>
        `- sectionKey: "${s.key}", heading: "${s.heading}", allowedPatchKinds: [${s.allowedPatchKinds
          .map((k) => `"${k}"`)
          .join(", ")}]${s.tableColumns ? `, tableColumns: [${s.tableColumns.map((c) => `"${c}"`).join(", ")}]` : ""}`,
    )
    .join("\n");
}
