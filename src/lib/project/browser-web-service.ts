import { googleSearchAdapter } from "./google-search";
import { baiduSearchAdapter } from "./baidu-search";
import { BrowserLaunchError } from "./browser-manager";
import { BrowserVerificationStore } from "./browser-verification";
import { extractPageText } from "./url-content";
import { readPublicUrlOutcome, type UrlReadOutcome } from "./url-reader";
import type { BrowserWebErrorCode, SearchEngineId, SearchResult } from "./types";
import type { SearchEngineAdapter } from "./search-engine";

/**
 * The only project-domain entry point consumed by the orchestration plan. It
 * performs a single search or fetch per call (no turn budgets — those live in
 * the orchestrator). Browser page content is treated as untrusted data. No
 * model/provider imports live here.
 */

export type { BrowserWebErrorCode };

export type BrowserWebSearchResult =
  | { ok: true; results: SearchResult[] }
  | { ok: false; code: BrowserWebErrorCode; message: string; verificationId?: string };

export type WebFetchResult =
  | { ok: true; url: string; content: string }
  | { ok: false; code: BrowserWebErrorCode; message: string };

export interface BrowserWebService {
  search(input: {
    projectId: string;
    sessionId: string;
    engine: SearchEngineId;
    query: string;
    signal?: AbortSignal;
  }): Promise<BrowserWebSearchResult>;
  fetch(input: { url: string; signal?: AbortSignal }): Promise<WebFetchResult>;
}

export type BrowserPageLike = {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<void>;
  content(): Promise<string>;
  url(): string;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
};

type BrowserContextLike = { newPage(): Promise<unknown> };

export type BrowserManagerLike = {
  withPersistentContext<T>(
    work: (ctx: BrowserContextLike) => Promise<T>,
    opts?: { signal?: AbortSignal; launchOptions?: Record<string, unknown> },
  ): Promise<T>;
};

export type BrowserWebServiceDeps = {
  browserManager: BrowserManagerLike;
  adapters?: Record<SearchEngineId, SearchEngineAdapter>;
  challengeStore?: BrowserVerificationStore;
  readUrlOutcome?: (url: string, signal?: AbortSignal) => Promise<UrlReadOutcome>;
  extractText?: (contentType: string, html: string) => { text: string; title: string };
  searchTimeoutMs?: number;
  maxQueryLength?: number;
  maxFetchChars?: number;
};

const DEFAULT_SEARCH_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_QUERY_LENGTH = 200;
const DEFAULT_MAX_FETCH_CHARS = 20_000;

function defaultAdapters(): Record<SearchEngineId, SearchEngineAdapter> {
  return { google: googleSearchAdapter, baidu: baiduSearchAdapter };
}

export function createBrowserWebService(deps: BrowserWebServiceDeps): BrowserWebService {
  const browserManager = deps.browserManager;
  const adapters = deps.adapters ?? defaultAdapters();
  const challengeStore = deps.challengeStore ?? new BrowserVerificationStore();
  const readUrlOutcome = deps.readUrlOutcome ?? ((url, signal) => readPublicUrlOutcome(url, { signal }));
  const extractText = deps.extractText ?? extractPageText;
  const searchTimeoutMs = deps.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const maxQueryLength = deps.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH;
  const maxFetchChars = deps.maxFetchChars ?? DEFAULT_MAX_FETCH_CHARS;

  return {
    async search(input) {
      const query = input.query.trim();
      if (!query) return { ok: true, results: [] };
      if (query.length > maxQueryLength) {
        return { ok: false, code: "search_page_unrecognized", message: "查询过长" };
      }
      const adapter = adapters[input.engine];

      try {
        const outcome = await browserManager.withPersistentContext(
          async (ctx) => {
            const page = (await ctx.newPage()) as BrowserPageLike;
            try {
              await page.goto(adapter.buildUrl(query), {
                timeout: searchTimeoutMs,
                waitUntil: "domcontentloaded",
              });
              if (adapter.resultSelector) {
                await page.waitForSelector(adapter.resultSelector, { timeout: searchTimeoutMs }).catch(() => {});
              }
              const html = await page.content();
              if (adapter.detectVerification(html)) {
                const created = await challengeStore.create({
                  engine: input.engine,
                  challengeUrl: page.url(),
                  projectId: input.projectId,
                  sessionId: input.sessionId,
                });
                return { kind: "verification" as const, verificationId: created.verificationId };
              }
              const results = adapter.parseHtml(html);
              if (results.length === 0) return { kind: "unrecognized" as const };
              return { kind: "results" as const, results };
            } finally {
              await page.close().catch(() => {});
            }
          },
          { signal: input.signal },
        );

        if (outcome.kind === "verification") {
          return { ok: false, code: "verification_required", message: "需要浏览器验证", verificationId: outcome.verificationId };
        }
        if (outcome.kind === "unrecognized") {
          return { ok: false, code: "search_page_unrecognized", message: "未识别到搜索结果" };
        }
        return { ok: true, results: outcome.results };
      } catch (error) {
        return mapSearchError(error, input.signal);
      }
    },

    async fetch(input) {
      const outcome = await readUrlOutcome(input.url, input.signal);
      if (!outcome.ok) {
        return { ok: false, code: mapFetchCode(outcome.code), message: sanitize(outcome.message) };
      }
      const isHtml = outcome.contentType.toLowerCase().includes("html");
      if (isHtml && outcome.isEmpty) {
        try {
          const content = await browserManager.withPersistentContext(
            async (ctx) => {
              const page = (await ctx.newPage()) as BrowserPageLike;
              try {
                await page.goto(outcome.url, { timeout: searchTimeoutMs, waitUntil: "domcontentloaded" });
                const html = await page.content();
                const extracted = extractText("text/html", html);
                return extracted.text;
              } finally {
                await page.close().catch(() => {});
              }
            },
            { signal: input.signal },
          );
          return { ok: true, url: outcome.url, content: content.slice(0, maxFetchChars) };
        } catch (error) {
          return mapFetchError(error, input.signal);
        }
      }
      return { ok: true, url: outcome.url, content: outcome.content.slice(0, maxFetchChars) };
    },
  };
}

function mapSearchError(error: unknown, signal?: AbortSignal): BrowserWebSearchResult {
  if (signal?.aborted) return { ok: false, code: "aborted", message: "已取消" };
  if (error instanceof BrowserLaunchError) {
    return { ok: false, code: "browser_launch_failed", message: "浏览器启动失败" };
  }
  const msg = error instanceof Error ? error.message : "";
  if (/timeout|timed out|exceeded/i.test(msg)) {
    return { ok: false, code: "search_timeout", message: "搜索超时" };
  }
  if (isAbortError(error)) return { ok: false, code: "aborted", message: "已取消" };
  return { ok: false, code: "browser_unavailable", message: "浏览器不可用" };
}

function mapFetchError(error: unknown, signal?: AbortSignal): WebFetchResult {
  if (signal?.aborted) return { ok: false, code: "aborted", message: "已取消" };
  if (error instanceof BrowserLaunchError) {
    return { ok: false, code: "browser_launch_failed", message: "浏览器启动失败" };
  }
  const msg = error instanceof Error ? error.message : "";
  if (/timeout|timed out|exceeded/i.test(msg)) {
    return { ok: false, code: "aborted", message: "抓取超时" };
  }
  if (isAbortError(error)) return { ok: false, code: "aborted", message: "已取消" };
  return { ok: false, code: "browser_unavailable", message: "抓取失败" };
}

function mapFetchCode(code: string): BrowserWebErrorCode {
  if (code === "blocked_address") return "blocked_address";
  if (code === "too_large") return "response_too_large";
  if (code === "aborted") return "aborted";
  if (code === "timeout") return "aborted";
  return "blocked_address";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}

function sanitize(message: string): string {
  return message.replace(/(?:\/[\w.\-]+)+|[A-Za-z]:\\[^\s]*/g, "").slice(0, 120) || "请求失败";
}