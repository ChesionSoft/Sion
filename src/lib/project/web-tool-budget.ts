import type { ModelToolName, ToolResultEnvelope } from "./model-tools";
import type { SearchResult } from "./types";

/**
 * Per-turn budget for model-initiated browser tools. Created fresh per
 * assistant request — no global state. Limits: at most 2 searches, 5 results
 * per search, 3 successful fetched pages, and 2 model tool rounds. Repeated
 * canonical URLs are not refetched. Invalid tool calls return errors but
 * cannot bypass the round cap.
 */

export const MAX_SEARCHES_PER_TURN = 2;
export const MAX_RESULTS_PER_SEARCH = 5;
export const MAX_FETCHED_PAGES = 3;
export const MAX_TOOL_ROUNDS = 2;

/**
 * Strict total cap on fetched-page text that may be returned to the model
 * across a single turn (direct URLs, tool results, and fallback-search
 * context all share it). Intentionally lower than the three-page x 20k
 * UI/page cap: the UI may still show safely extracted page text, but the
 * model-facing payload is bounded.
 */
export const MAX_MODEL_WEB_CONTENT_CHARS = 24_000;
const WEB_TRUNCATION_MARKER = "\n\n…（网页内容已截断）";

export class WebToolBudget {
  private searchesUsed = 0;
  private successfulFetches = 0;
  private toolRounds = 0;
  private modelWebChars = 0;
  private readonly fetchedUrls = new Set<string>();

  canSearch(): boolean {
    return this.searchesUsed < MAX_SEARCHES_PER_TURN;
  }

  recordSearch(): void {
    this.searchesUsed += 1;
  }

  clipResults(results: SearchResult[]): SearchResult[] {
    return results.slice(0, MAX_RESULTS_PER_SEARCH).map((r, i) => ({ ...r, rank: i + 1 }));
  }

  canFetch(url: string): boolean {
    if (this.successfulFetches >= MAX_FETCHED_PAGES) return false;
    return !this.fetchedUrls.has(canonicalizeUrl(url));
  }

  recordFetch(url: string, success: boolean): void {
    this.fetchedUrls.add(canonicalizeUrl(url));
    if (success) this.successfulFetches += 1;
  }

  canStartToolRound(): boolean {
    return this.toolRounds < MAX_TOOL_ROUNDS;
  }

  recordToolRound(): void {
    this.toolRounds += 1;
  }

  searchResultEnvelope(results: SearchResult[]): ToolResultEnvelope {
    return { ok: true, tool: "web_search", results: this.clipResults(results) };
  }

  fetchResultEnvelope(url: string, content: string): ToolResultEnvelope {
    return { ok: true, tool: "web_fetch", url, content };
  }

  /**
   * Clip fetched-page text to the remaining per-turn model budget, adding a
   * truncation marker when cut. Returns "" once the budget is exhausted so
   * callers can omit the content from model-facing context. The running total
   * (`modelWebChars`) never exceeds MAX_MODEL_WEB_CONTENT_CHARS.
   */
  clipFetchedContent(content: string): string {
    const remaining = MAX_MODEL_WEB_CONTENT_CHARS - this.modelWebChars;
    if (remaining <= 0) return "";
    const clipped =
      content.length <= remaining
        ? content
        : remaining <= WEB_TRUNCATION_MARKER.length
          ? WEB_TRUNCATION_MARKER.slice(0, remaining)
          : content.slice(0, remaining - WEB_TRUNCATION_MARKER.length) + WEB_TRUNCATION_MARKER;
    this.modelWebChars += clipped.length;
    return clipped;
  }

  errorEnvelope(tool: ModelToolName | string, code: string, error: string): ToolResultEnvelope {
    return { ok: false, tool: tool as ModelToolName, code, error };
  }
}

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url;
  }
}