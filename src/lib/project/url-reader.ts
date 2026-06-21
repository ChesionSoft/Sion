import { createExternalSource } from "./external-source";
import {
  assertPublicHttpTarget,
  NetworkPolicyError,
  resolvePublicTarget,
  type DnsLookup,
} from "./network-policy";
import { extractPageText } from "./url-content";
import type { ExternalSource } from "./types";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARACTERS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];

export type UrlReadErrorCode =
  | "blocked_address"
  | "invalid_url"
  | "redirect_loop"
  | "unsupported_content_type"
  | "too_large"
  | "timeout"
  | "aborted"
  | "fetch_failed";

export class UrlReadError extends Error {
  constructor(public readonly code: UrlReadErrorCode, message: string) {
    super(message);
    this.name = "UrlReadError";
  }
}

export type UrlReaderDeps = {
  lookup?: DnsLookup;
  fetchOnce?: (
    url: string,
    init: { signal: AbortSignal; pinnedAddress: string; pinnedFamily: number },
  ) => Promise<{
    status: number;
    headers: { location?: string; "content-type"?: string };
    body: Uint8Array;
  }>;
  signal?: AbortSignal;
};

export type UrlReadSuccess = {
  ok: true;
  requestedUrl: string;
  source: ExternalSource;
  content: string;
};

export type UrlReadFailure = {
  ok: false;
  requestedUrl: string;
  error: string;
  code: UrlReadErrorCode;
};

export type UrlReadResult = UrlReadSuccess | UrlReadFailure;

function mapPolicyError<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    if (error instanceof NetworkPolicyError) {
      throw new UrlReadError(error.code, error.message);
    }
    throw error;
  });
}

function toPublicHttpTarget(raw: string): URL {
  try {
    return assertPublicHttpTarget(raw);
  } catch (error) {
    if (error instanceof NetworkPolicyError) {
      throw new UrlReadError(error.code, error.message);
    }
    throw error;
  }
}

async function defaultFetchOnce(
  url: string,
  init: { signal: AbortSignal; pinnedAddress: string; pinnedFamily: number },
): Promise<{
  status: number;
  headers: { location?: string; "content-type"?: string };
  body: Uint8Array;
}> {
  // Lazy import so the test environment doesn't need undici loaded for the
  // pure-address tests.
  const { Agent, request } = await import("undici");
  const agent = new Agent({
    connect: {
      lookup: (_hostname, _opts, cb) => {
        const address = { address: init.pinnedAddress, family: init.pinnedFamily };
        if (_opts.all) {
          cb(null, [address], init.pinnedFamily);
        } else {
          cb(null, init.pinnedAddress, init.pinnedFamily);
        }
      },
    },
  });
  try {
    const response = await request(url, {
      method: "GET",
      signal: init.signal,
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
      dispatcher: agent,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        throw new UrlReadError("too_large", "响应体过大");
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    return {
      status: response.statusCode,
      headers: {
        location: response.headers.location as string | undefined,
        "content-type": response.headers["content-type"] as string | undefined,
      },
      body: new Uint8Array(body),
    };
  } finally {
    await agent.close().catch(() => {});
  }
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export async function readPublicUrl(
  rawUrl: string,
  deps: UrlReaderDeps = {},
): Promise<{ ok: true; source: ExternalSource; content: string }> {
  const initialUrl = toPublicHttpTarget(rawUrl);

  const callerSignal = deps.signal;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const combinedSignal = combineSignals([callerSignal, timeoutController.signal].filter(Boolean) as AbortSignal[]);

  try {
    let currentUrl: URL = initialUrl;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (combinedSignal.aborted) throw new UrlReadError("aborted", "请求已取消");

      // Re-resolve and revalidate on each hop (including the first).
      const pinned = await mapPolicyError(resolvePublicTarget(currentUrl.hostname, deps.lookup));

      const fetchOnce = deps.fetchOnce ?? defaultFetchOnce;
      const response = await fetchOnce(currentUrl.toString(), {
        signal: combinedSignal,
        pinnedAddress: pinned.address,
        pinnedFamily: pinned.family,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (!location) throw new UrlReadError("fetch_failed", "重定向缺少 Location");
        if (i === MAX_REDIRECTS) throw new UrlReadError("redirect_loop", "重定向次数过多");
        const nextUrl = new URL(location, currentUrl);
        currentUrl = nextUrl;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new UrlReadError("fetch_failed", `请求失败（状态 ${response.status}）`);
      }

      const contentType = response.headers["content-type"] ?? "";
      const ct = contentType.toLowerCase().split(";")[0].trim();
      if (!ALLOWED_CONTENT_TYPES.includes(ct)) {
        throw new UrlReadError("unsupported_content_type", "仅支持 HTML 与纯文本");
      }

      const text = new TextDecoder("utf-8", { fatal: false }).decode(response.body);
      const extracted = extractPageText(contentType, text);
      const snippet = extracted.text.slice(0, 200);
      const source = createExternalSource({
        kind: "provided_url",
        url: currentUrl.toString(),
        title: extracted.title || currentUrl.hostname,
        snippet,
        retrievedAt: new Date().toISOString(),
      });
      const content = extracted.text.slice(0, MAX_PAGE_CHARACTERS);
      return { ok: true as const, source, content };
    }
    throw new UrlReadError("redirect_loop", "重定向次数过多");
  } catch (error) {
    if (error instanceof UrlReadError) throw error;
    if (error instanceof Error) {
      if (error.name === "AbortError" || combinedSignal.aborted) {
        if (callerSignal?.aborted) throw new UrlReadError("aborted", "请求已取消");
        throw new UrlReadError("timeout", "请求超时");
      }
      throw new UrlReadError("fetch_failed", error.message || "请求失败");
    }
    throw new UrlReadError("fetch_failed", "请求失败");
  } finally {
    clearTimeout(timeout);
  }
}

function toFailure(requestedUrl: string, error: unknown): UrlReadFailure {
  if (error instanceof UrlReadError) {
    return { ok: false, requestedUrl, error: error.message, code: error.code };
  }
  const message = error instanceof Error ? error.message : "请求失败";
  return { ok: false, requestedUrl, error: message, code: "fetch_failed" };
}

export async function readPublicUrls(urls: string[], deps: UrlReaderDeps = {}): Promise<UrlReadResult[]> {
  return Promise.all(
    urls.map(async (url) => {
      try {
        const result = await readPublicUrl(url, deps);
        const success: UrlReadSuccess = {
          ok: true,
          requestedUrl: url,
          source: result.source,
          content: result.content,
        };
        return success;
      } catch (error) {
        return toFailure(url, error);
      }
    }),
  );
}
