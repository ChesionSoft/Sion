import type { SearchEngineId, SearchResult } from "./types";

/**
 * Provider-neutral search engine adapter. Each engine supplies how to build a
 * search URL, how to parse its results HTML into {@link SearchResult}s, and
 * how to detect a verification/challenge page that needs a human.
 */
export type SearchEngineAdapter = {
  id: SearchEngineId;
  buildUrl(query: string): string;
  parseHtml(html: string): SearchResult[];
  detectVerification(html: string): boolean;
  /** Selector to wait for (rather than sleeping) before reading page content. */
  resultSelector?: string;
};

export const MAX_RESULTS = 5;

/**
 * Normalize a raw href into a canonical http(s) URL. Returns null for
 * non-HTTP(S) protocols, parse failures, or empty input. Engine redirect
 * wrappers (Google `/url?q=`, Baidu `/link?url=`) are NOT unwrapped here —
 * the caller passes the already-unwrapped target URL.
 */
export function normalizeResultUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Dedupe by canonical URL (keeping first occurrence), assign stable 1-based
 * ranks in order, and cap at {@link MAX_RESULTS}.
 */
export function dedupeAndRank(results: { title: string; url: string; snippet?: string }[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ title: r.title, url: r.url, snippet: r.snippet, rank: out.length + 1 });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}