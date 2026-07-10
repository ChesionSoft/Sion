import type { NodeMarkdownPatch, PatchKind, WorkflowNodeId } from "./types";
import { getDeliverySchema } from "./node-delivery-schemas";

const CLOSED_FENCE_RE = /```delivery\s*([\s\S]*?)```/g;
const UNCLOSED_FENCE_RE = /```delivery\s*([\s\S]*)$/;

/**
 * Extract the first balanced `{...}` JSON object from `text`, tolerating prose
 * or thinking tags around it. Tracks brace depth while respecting string
 * literals and escapes so braces inside strings don't break the count. Moved
 * here from node-fact-judge.ts.
 */
export function extractFirstJsonObject(text: string): string | null {
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
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
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
  const jsons: string[] = [];
  for (const m of content.matchAll(CLOSED_FENCE_RE)) {
    jsons.push(m[1]);
  }
  // Trailing unclosed fence (model never closed it): parse from the last
  // ```delivery to end, on content with closed fences removed so a closed
  // block is never double-counted.
  const withoutClosed = content.replace(CLOSED_FENCE_RE, "");
  const unclosed = UNCLOSED_FENCE_RE.exec(withoutClosed);
  if (unclosed) jsons.push(unclosed[1]);

  const patches: NodeMarkdownPatch[] = [];
  for (const raw of jsons) {
    const parsed = parseJsonLenient(raw);
    if (!parsed || typeof parsed !== "object") continue;
    const changes = (parsed as { changes?: unknown[] }).changes;
    if (!Array.isArray(changes)) continue;
    for (const item of changes) {
      const patch = toPatch(item);
      if (patch) patches.push(patch);
    }
  }
  return patches;
}

/**
 * Remove every ```delivery fenced block from `content` (used to keep the
 * model's chat history free of structured noise). Collapses 3+ blank lines
 * left behind and trims trailing whitespace.
 */
export function stripDeliveryBlock(content: string): string {
  return content
    .replace(CLOSED_FENCE_RE, "")
    .replace(UNCLOSED_FENCE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
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
