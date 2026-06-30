import { z } from "zod";
import { callModelChat, type ModelUsageContext } from "./model-chat";
import { getDeliverySchema, getDeliverySection } from "./node-delivery-schemas";
import type {
  ApiUrlMode,
  ExternalSource,
  ModelProviderProtocol,
  NodeFactDecision,
  NodeMarkdownPatch,
  WorkflowNodeId,
} from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JudgeNodeFactsResult =
  | { ok: true; decision: NodeFactDecision }
  | { ok: false; error: string };

export type JudgeNodeFactsInput = {
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  model: string;
  protocol?: ModelProviderProtocol;
  nodeId: WorkflowNodeId;
  userMessage: string;
  assistantContent: string;
  externalSources?: ExternalSource[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Whole-turn identity + callback for reporting the judge's token usage. */
  turnId?: string;
  providerId?: string;
  onUsage?: (usage: import("./types").ModelCallUsage) => void;
};

// ---------------------------------------------------------------------------
// Per-item Zod schema
// ---------------------------------------------------------------------------

const patchSchema = z.object({
  category: z.enum(["confirmed_fact", "assumption", "open_question"]),
  targetSectionKey: z.string(),
  patchKind: z.enum(["append_bullet", "append_block", "append_table_row"]),
  markdown: z.string(),
  evidence: z.discriminatedUnion("source", [
    z.object({
      source: z.enum(["user", "assistant"]),
      quote: z.string(),
    }),
    z.object({
      source: z.literal("external"),
      quote: z.string(),
      sourceId: z.string(),
    }),
  ]),
});

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(nodeId: WorkflowNodeId, externalSources: ExternalSource[] | undefined): string {
  const schema = getDeliverySchema(nodeId);
  if (!schema) {
    throw new Error(`Unknown node id: ${nodeId}`);
  }

  const sectionsList = schema.sections
    .map(
      (s) =>
        `- sectionKey: "${s.key}", heading: "${s.heading}", allowedPatchKinds: [${s.allowedPatchKinds.map((k) => `"${k}"`).join(", ")}]${s.tableColumns ? `, tableColumns: [${s.tableColumns.map((column) => `"${column}"`).join(", ")}]` : ""}`,
    )
    .join("\n");

  const externalList = (externalSources ?? [])
    .map((s) => `- sourceId: "${s.id}", title: "${s.title}", url: "${s.url}"`)
    .join("\n");

  return `You are a fact-checking judge. Analyze the user's message and the assistant's response to extract structured facts and write them into the node's content sections.

Output strict JSON only, with this shape:
{"changes":[{"category":"confirmed_fact|assumption|open_question","targetSectionKey":"<sectionKey>","patchKind":"append_bullet|append_block|append_table_row","markdown":"<markdown content>","evidence":{"source":"user|assistant|external","quote":"<exact quote>","sourceId":"<external source id, only when source=external>"}}]}

Rules:
- confirmed_fact: The user explicitly stated this. Requires evidence.source="user" and evidence.quote must be a verbatim substring from the user's message. Write it into the content section it belongs to.
- assumption: Anything the assistant inferred, analyzed, or generated (including from web search). It is NOT a separate "assumptions" bucket — write it directly into the content section it belongs to, as normal content. evidence.source should be "assistant" (or "external" when sourced from a fetched URL).
- open_question: Something that needs clarification from the user. DO NOT emit a change for this — open questions belong in the chat conversation, never in the delivery document.
- external: A claim sourced from an external URL the user pasted. Use evidence.source="external" with evidence.sourceId set to one of the listed external source ids. External evidence is never a confirmed fact; emit it as an assumption written into the relevant content section.
- If there are no changes, return {"changes":[]}.

markdown format by patchKind:
- append_bullet: a single bullet line, e.g. "- 客户管理". Do not include a heading.
- append_block: a short paragraph. Do not include a heading.
- append_table_row: a single GFM table data row. The number of pipe-separated cells MUST exactly equal the section's tableColumns length. Example: if tableColumns is ["模块名","职责","优先级"], the row MUST be "| 客户管理 | 管理客户档案 | P0 |" (3 cells). Do NOT emit fewer or more cells. Do not include a header or separator row — only the data row.

Available sections for this node (these are the ONLY sections you may write into — there is no "confirmed", "assumptions", or "open_questions" section):
${sectionsList}

External sources referenced this turn (never treat as confirmed facts):
${externalList || "(none)"}`;
}

// ---------------------------------------------------------------------------
// Main judge function
// ---------------------------------------------------------------------------

export async function judgeNodeFacts(
  input: JudgeNodeFactsInput,
): Promise<JudgeNodeFactsResult> {
  const externalSources = input.externalSources ?? [];
  const systemPrompt = buildSystemPrompt(input.nodeId, externalSources);

  const usageContext: ModelUsageContext | undefined =
    input.turnId && input.providerId && input.onUsage
      ? { turnId: input.turnId, category: "fact_judge", providerId: input.providerId, onUsage: input.onUsage }
      : undefined;

  // 1. Call the LLM
  let responseContent: string;
  try {
    responseContent = await callModelChat({
      apiBaseUrl: input.apiBaseUrl,
      apiUrlMode: input.apiUrlMode,
      apiKey: input.apiKey,
      model: input.model,
      protocol: input.protocol ?? "chat_completions",
      reasoningEffort: "low",
      // Never enable Web Search for fact judging — the judge must reason only
      // over the user's own message and the assistant's reply.
      webSearchEnabled: false,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            "## User message",
            input.userMessage,
            "",
            "## Assistant response",
            input.assistantContent,
          ].join("\n"),
        },
      ],
      fetchImpl: input.fetchImpl,
      signal: input.signal,
      usageContext,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Parse JSON. Reasoning models (e.g. minimax m3 via Ollama) often prepend
  //    prose or thinking tags before the JSON and may not use a code fence, so
  //    try several recovery strategies before falling back.
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseContent);
  } catch {
    const fenceMatch = responseContent.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates = [
      fenceMatch ? fenceMatch[1].trim() : null,
      extractFirstJsonObject(responseContent),
    ].filter((s): s is string => !!s);
    let parsedOk = false;
    for (const candidate of candidates) {
      try {
        parsed = JSON.parse(candidate);
        parsedOk = true;
        break;
      } catch {
        // try the next candidate
      }
    }
    if (!parsedOk) {
      // No JSON object anywhere — typically the model concluded in prose that
      // there is nothing to record. Treat this as "no changes" rather than
      // erroring: the answer text is already shown to the user, and the
      // document simply isn't auto-updated this turn, identical to
      // {"changes":[]}. Surfacing a parse error here only scares the user.
      return { ok: true, decision: { changes: [] } };
    }
  }

  // 3. Validate top-level structure
  const topSchema = z.object({ changes: z.array(z.unknown()) });
  const topResult = topSchema.safeParse(parsed);
  if (!topResult.success) {
    return {
      ok: false,
      error: `judge response missing valid changes array: ${topResult.error.message}`,
    };
  }

  // 4. Per-item processing
  const rawChanges = topResult.data.changes;
  const changes: NodeMarkdownPatch[] = [];

  for (const item of rawChanges) {
    // 4a. Per-item Zod safeParse — drop on failure
    const itemResult = patchSchema.safeParse(item);
    if (!itemResult.success) continue;

    let patch = itemResult.data as NodeMarkdownPatch;

    // 4b. Section must exist
    const section = getDeliverySection(input.nodeId, patch.targetSectionKey);
    if (!section) continue;

    // 4c. patchKind must be allowed in the target section
    if (!section.allowedPatchKinds.includes(patch.patchKind)) continue;

    // 4d. markdown must be non-empty after trim
    if (!patch.markdown.trim()) continue;

    // 4e. markdown must NOT contain a heading line
    if (/^#{1,6}\s/.test(patch.markdown)) continue;

    // 4f. External evidence: must reference a known external source id, else drop.
    if (patch.evidence.source === "external") {
      const evidence = patch.evidence;
      const known = externalSources.some((s) => s.id === evidence.sourceId);
      if (!known) continue;
      // External evidence is never a confirmed fact — downgrade to assumption.
      if (patch.category === "confirmed_fact") {
        patch = { ...patch, category: "assumption" };
      }
    }

    // 4g. Evidence source rule: confirmed_fact with non-user source → assumption
    if (patch.category === "confirmed_fact" && patch.evidence.source !== "user") {
      patch = { ...patch, category: "assumption" };
    }

    // 4h. Quote substring rule: confirmed_fact with user source needs valid quote
    if (patch.category === "confirmed_fact" && patch.evidence.source === "user") {
      const quote = patch.evidence.quote.trim();
      if (!quote || !input.userMessage.includes(quote)) {
        patch = { ...patch, category: "assumption" };
      }
    }

    // 4i. open_question never enters the delivery document — it belongs in the
    // chat conversation. Drop it rather than writing it anywhere.
    if (patch.category === "open_question") continue;

    // confirmed_fact and assumption both keep the model's chosen targetSectionKey
    // (a real content section) and patchKind; re-validate against that section.
    const mappedSection = getDeliverySection(
      input.nodeId,
      patch.targetSectionKey,
    );
    if (!mappedSection) continue;
    if (!mappedSection.allowedPatchKinds.includes(patch.patchKind)) continue;

    changes.push(patch);
  }

  return { ok: true, decision: { changes } };
}

/**
 * Extract the first balanced `{...}` JSON object from `text`, tolerating prose
 * or thinking tags around it. Scans for the first `{`, then tracks brace depth
 * while respecting string literals and escapes so braces inside strings don't
 * break the count. Returns null if no balanced object is found. Used to recover
 * JSON that reasoning models wrap in prose or emit after thinking tags.
 */
function extractFirstJsonObject(text: string): string | null {
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
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      if (depth < 0) return null;
    }
  }
  return null;
}
