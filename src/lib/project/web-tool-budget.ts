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

export class WebToolBudget {
  private searchesUsed = 0;
  private successfulFetches = 0;
  private toolRounds = 0;
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