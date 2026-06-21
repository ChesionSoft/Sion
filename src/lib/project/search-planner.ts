import { z } from "zod";
import { canonicalizeUrl } from "./web-tool-budget";
import { MAX_QUERY_LENGTH } from "./model-tools";
import type { SearchResult } from "./types";

/**
 * Fallback search planning for models without function-tool support. One
 * strict, non-streaming JSON call with no tools: the model is asked only for
 * {"queries":[...]} and told that zero queries is valid. Parsing uses JSON.parse
 * plus strict Zod; fenced JSON is rejected (not extracted). On any failure the
 * result is [] plus a sanitized diagnostic. No retry, no second model call.
 *
 * Page selection is deterministic: results are merged in query order, deduped
 * by canonical URL, kept in rank order, and the first three are selected. No
 * model call chooses pages in v1.
 */

const MAX_PLANNER_QUERIES = 2;

const plannerSchema = z
  .object({ queries: z.array(z.string()) })
  .strict();

export type SearchPlannerInput = {
  userMessage: string;
  callText: (prompt: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
};

export type SearchPlannerResult = {
  queries: string[];
  diagnostic?: string;
};

export async function planSearchQueries(input: SearchPlannerInput): Promise<SearchPlannerResult> {
  const prompt = buildPlannerPrompt(input.userMessage);
  let raw: string;
  try {
    raw = await input.callText(prompt, input.signal);
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))) {
      return { queries: [] };
    }
    return { queries: [], diagnostic: "搜索规划失败" };
  }

  // Reject fenced JSON — only bare JSON is accepted.
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return { queries: [], diagnostic: "搜索规划返回格式错误" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { queries: [], diagnostic: "搜索规划返回格式错误" };
  }

  const safe = plannerSchema.safeParse(parsed);
  if (!safe.success) {
    return { queries: [], diagnostic: "搜索规划返回格式错误" };
  }

  const queries: string[] = [];
  const seen = new Set<string>();
  for (const q of safe.data.queries) {
    const cleaned = q.trim();
    if (!cleaned) continue;
    if (cleaned.length > MAX_QUERY_LENGTH) continue;
    if (seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    queries.push(cleaned);
    if (queries.length >= MAX_PLANNER_QUERIES) break;
  }
  return { queries };
}

function buildPlannerPrompt(userMessage: string): string {
  return [
    "你是一个搜索规划器。根据用户消息判断是否需要联网搜索，并输出 0 到 2 条搜索关键词。",
    "只输出严格的 JSON，不要包含任何解释、前后文或代码块标记。",
    '格式：{"queries":["关键词1","关键词2"]}',
    "如果不需要搜索，输出 {\"queries\":[]}。",
    "每条关键词不超过 200 个字符，且互不重复。",
    "",
    `用户消息：${userMessage}`,
  ].join("\n");
}

/**
 * Deterministically select up to `limit` pages from per-query result lists.
 * Merge in query order, dedupe by canonical URL (keep first), re-rank 1..N in
 * selection order, and take the first `limit`.
 */
export function selectPages(perQuery: SearchResult[][], limit = 3): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const results of perQuery) {
    for (const r of results) {
      const key = canonicalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
  }
  return merged.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
}