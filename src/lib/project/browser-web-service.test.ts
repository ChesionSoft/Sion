import { describe, expect, it, vi } from "vitest";
import {
  createBrowserWebService,
  type BrowserManagerLike,
  type BrowserPageLike,
} from "./browser-web-service";
import { BrowserVerificationStore } from "./browser-verification";
import type { SearchEngineId, SearchResult } from "./types";
import type { UrlReadOutcome } from "./url-reader";

function fakePage(overrides: Partial<BrowserPageLike> = {}): BrowserPageLike {
  return {
    goto: vi.fn(async () => {}),
    content: vi.fn(async () => "<html></html>"),
    url: vi.fn(() => "https://www.google.com/search?q=test"),
    waitForSelector: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakeManager(page: BrowserPageLike, opts: { throwOnEnter?: Error } = {}): BrowserManagerLike {
  const withPersistentContext = vi.fn(
    async <T,>(work: (ctx: { newPage(): Promise<BrowserPageLike> }) => Promise<T>): Promise<T> => {
      if (opts.throwOnEnter) throw opts.throwOnEnter;
      return work({ newPage: async () => page });
    },
  );
  return { withPersistentContext } as unknown as BrowserManagerLike;
}

function fakeAdapter(opts: {
  parseHtml?: (html: string) => SearchResult[];
  detectVerification?: (html: string) => boolean;
  buildUrl?: (q: string) => string;
}) {
  return {
    id: "google" as SearchEngineId,
    buildUrl: opts.buildUrl ?? ((q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`),
    parseHtml:
      opts.parseHtml ?? (() => [{ title: "R1", url: "https://example.com/1", rank: 1 }] as SearchResult[]),
    detectVerification: opts.detectVerification ?? (() => false),
    resultSelector: "div.g",
  };
}

describe("BrowserWebService/search", () => {
  it("trims and rejects an empty query with empty results", async () => {
    const svc = createBrowserWebService({ browserManager: fakeManager(fakePage()) });
    const result = await svc.search({ projectId: "p", sessionId: "s", engine: "google", query: "   " });
    expect(result).toEqual({ ok: true, results: [] });
  });

  it("rejects an overlong query", async () => {
    const svc = createBrowserWebService({ browserManager: fakeManager(fakePage()) });
    const result = await svc.search({
      projectId: "p",
      sessionId: "s",
      engine: "google",
      query: "x".repeat(300),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("search_page_unrecognized");
  });

  it("uses the selected engine's adapter and returns its results (<=5)", async () => {
    const adapter = fakeAdapter({
      parseHtml: () =>
        Array.from({ length: 5 }, (_, i) => ({
          title: `R${i}`,
          url: `https://example.com/${i}`,
          rank: i + 1,
        })) as SearchResult[],
    });
    const page = fakePage();
    const svc = createBrowserWebService({
      browserManager: fakeManager(page),
      adapters: { google: adapter, baidu: fakeAdapter({}) },
    });
    const result = await svc.search({ projectId: "p", sessionId: "s", engine: "google", query: "hello" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(5);
      expect(result.results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    }
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.google.com/search?q=hello",
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("creates a verification challenge and returns verification_required", async () => {
    const challengeStore = new BrowserVerificationStore({ now: () => 1, id: () => "ch-1" });
    const adapter = fakeAdapter({ detectVerification: () => true });
    const page = fakePage({ url: () => "https://www.google.com/sorry?continue=x" });
    const svc = createBrowserWebService({
      browserManager: fakeManager(page),
      adapters: { google: adapter, baidu: fakeAdapter({}) },
      challengeStore,
    });
    const result = await svc.search({ projectId: "p", sessionId: "s", engine: "google", query: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("verification_required");
      expect(result.verificationId).toBe("ch-1");
    }
  });

  it("maps a navigation timeout to search_timeout", async () => {
    const page = fakePage({ goto: vi.fn(async () => { throw new Error("Timeout 10000ms exceeded"); }) });
    const svc = createBrowserWebService({
      browserManager: fakeManager(page),
      adapters: { google: fakeAdapter({}), baidu: fakeAdapter({}) },
    });
    const result = await svc.search({ projectId: "p", sessionId: "s", engine: "google", query: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("search_timeout");
  });

  it("maps a launch failure to browser_launch_failed", async () => {
    const { BrowserLaunchError } = await import("./browser-manager");
    const svc = createBrowserWebService({
      browserManager: fakeManager(fakePage(), { throwOnEnter: new BrowserLaunchError("browser_launch_failed", "x") }),
      adapters: { google: fakeAdapter({}), baidu: fakeAdapter({}) },
    });
    const result = await svc.search({ projectId: "p", sessionId: "s", engine: "google", query: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("browser_launch_failed");
  });

  it("closes the page and returns aborted when the signal aborts", async () => {
    const page = fakePage({ goto: vi.fn(async () => { throw new Error("aborted"); }) });
    const svc = createBrowserWebService({
      browserManager: fakeManager(page),
      adapters: { google: fakeAdapter({}), baidu: fakeAdapter({}) },
    });
    const controller = new AbortController();
    controller.abort();
    const result = await svc.search({
      projectId: "p",
      sessionId: "s",
      engine: "google",
      query: "hello",
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("aborted");
  });

  it("does not leak raw exception text or paths", async () => {
    const page = fakePage({ goto: vi.fn(async () => { throw new Error("boom at /Users/secret/profile"); }) });
    const svc = createBrowserWebService({
      browserManager: fakeManager(page),
      adapters: { google: fakeAdapter({}), baidu: fakeAdapter({}) },
    });
    const result = await svc.search({ projectId: "p", sessionId: "s", engine: "google", query: "hello" });
    const text = JSON.stringify(result);
    expect(text).not.toContain("/Users/secret");
    expect(text).not.toContain("boom at");
  });

  it("returns search_page_unrecognized when the page has no results", async () => {
    const adapter = fakeAdapter({ parseHtml: () => [] });
    const svc = createBrowserWebService({
      browserManager: fakeManager(fakePage()),
      adapters: { google: adapter, baidu: fakeAdapter({}) },
    });
    const result = await svc.search({ projectId: "p", sessionId: "s", engine: "google", query: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("search_page_unrecognized");
  });
});

describe("BrowserWebService/fetch", () => {
  function outcome(o: Partial<UrlReadOutcome> & { ok: boolean }): UrlReadOutcome {
    return o as unknown as UrlReadOutcome;
  }

  it("returns the safe URL reader content when it has a sufficient body", async () => {
    const readUrlOutcome = vi.fn(async () =>
      outcome({
        ok: true,
        url: "https://example.com/page",
        content: "main body text",
        contentType: "text/html",
        isEmpty: false,
        source: {} as never,
      }),
    );
    const svc = createBrowserWebService({ browserManager: fakeManager(fakePage()), readUrlOutcome });
    const result = await svc.fetch({ url: "https://example.com/page" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("main body text");
  });

  it("falls back to the browser for a successful HTML page with an empty body", async () => {
    const readUrlOutcome = vi.fn(async () =>
      outcome({
        ok: true,
        url: "https://example.com/spa",
        content: "",
        contentType: "text/html",
        isEmpty: true,
        source: {} as never,
      }),
    );
    const page = fakePage({ content: vi.fn(async () => "<main>rendered by JS</main>") });
    const extractText = vi.fn(() => ({ text: "rendered by JS", title: "SPA" }));
    const svc = createBrowserWebService({
      browserManager: fakeManager(page),
      readUrlOutcome,
      extractText,
    });
    const result = await svc.fetch({ url: "https://example.com/spa" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("rendered by JS");
    expect(page.goto).toHaveBeenCalledWith("https://example.com/spa", expect.any(Object));
  });

  it("does not fall back to the browser for a blocked/network failure", async () => {
    const readUrlOutcome = vi.fn(async () =>
      outcome({ ok: false, code: "blocked_address", message: "blocked" }),
    );
    const page = fakePage();
    const manager = fakeManager(page);
    const svc = createBrowserWebService({ browserManager: manager, readUrlOutcome });
    const result = await svc.fetch({ url: "https://bad.test/" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("blocked_address");
    expect(manager.withPersistentContext).not.toHaveBeenCalled();
  });

  it("falls back to the browser when the URL reader fails with a recoverable fetch_failed (e.g. 403)", async () => {
    const readUrlOutcome = vi.fn(async () =>
      outcome({ ok: false, code: "fetch_failed", message: "请求失败（状态 403）" }),
    );
    const page = fakePage({ content: vi.fn(async () => "<main>real browser content</main>") });
    const extractText = vi.fn(() => ({ text: "real browser content", title: "Site" }));
    const svc = createBrowserWebService({
      browserManager: fakeManager(page),
      readUrlOutcome,
      extractText,
    });
    const result = await svc.fetch({ url: "https://site.test/article" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("real browser content");
    expect(page.goto).toHaveBeenCalledWith("https://site.test/article", expect.any(Object));
  });

  it("falls back to the browser when the URL reader times out", async () => {
    const readUrlOutcome = vi.fn(async () =>
      outcome({ ok: false, code: "timeout", message: "请求超时" }),
    );
    const page = fakePage({ content: vi.fn(async () => "<main>slow site</main>") });
    const extractText = vi.fn(() => ({ text: "slow site", title: "Slow" }));
    const svc = createBrowserWebService({
      browserManager: fakeManager(page),
      readUrlOutcome,
      extractText,
    });
    const result = await svc.fetch({ url: "https://slow.test/" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("slow site");
  });

  it("does not fall back to the browser for a too_large failure", async () => {
    const readUrlOutcome = vi.fn(async () =>
      outcome({ ok: false, code: "too_large", message: "响应体过大" }),
    );
    const manager = fakeManager(fakePage());
    const svc = createBrowserWebService({ browserManager: manager, readUrlOutcome });
    const result = await svc.fetch({ url: "https://big.test/" });
    expect(result.ok).toBe(false);
    expect(manager.withPersistentContext).not.toHaveBeenCalled();
  });

  it("returns a sanitized failure when both the URL reader and browser fallback fail", async () => {
    const readUrlOutcome = vi.fn(async () =>
      outcome({ ok: false, code: "fetch_failed", message: "请求失败（状态 403）" }),
    );
    const page = fakePage({ goto: vi.fn(async () => { throw new Error("nav failed /Users/secret"); }) });
    const svc = createBrowserWebService({ browserManager: fakeManager(page), readUrlOutcome });
    const result = await svc.fetch({ url: "https://site.test/article" });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain("/Users/secret");
  });

  it("caps returned text at 20000 characters", async () => {
    const long = "x".repeat(30000);
    const readUrlOutcome = vi.fn(async () =>
      outcome({
        ok: true,
        url: "https://example.com/big",
        content: long,
        contentType: "text/html",
        isEmpty: false,
        source: {} as never,
      }),
    );
    const svc = createBrowserWebService({ browserManager: fakeManager(fakePage()), readUrlOutcome });
    const result = await svc.fetch({ url: "https://example.com/big" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.length).toBe(20000);
  });

  it("maps a browser fallback failure to a sanitized failure", async () => {
    const readUrlOutcome = vi.fn(async () =>
      outcome({
        ok: true,
        url: "https://example.com/spa",
        content: "",
        contentType: "text/html",
        isEmpty: true,
        source: {} as never,
      }),
    );
    const page = fakePage({ goto: vi.fn(async () => { throw new Error("nav failed /Users/secret"); }) });
    const svc = createBrowserWebService({ browserManager: fakeManager(page), readUrlOutcome });
    const result = await svc.fetch({ url: "https://example.com/spa" });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain("/Users/secret");
  });
});