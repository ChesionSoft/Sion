import ipaddr from "ipaddr.js";
import { createExternalSource } from "./external-source";
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

export function assertPublicAddress(address: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new UrlReadError("blocked_address", "不允许访问非公网地址");
  }
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  if (parsed.range() !== "unicast") {
    throw new UrlReadError("blocked_address", "不允许访问非公网地址");
  }
}

export type UrlReaderDeps = {
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  fetchOnce?: (
    url: string,
    init: { signal: AbortSignal; pinnedAddress: string },
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

function assertValidRequestUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlReadError("invalid_url", "URL 格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlReadError("invalid_url", "仅支持 http/https 协议");
  }
  if (url.username || url.password) {
    throw new UrlReadError("invalid_url", "URL 不允许包含用户名密码");
  }
  return url;
}

async function resolveAndValidate(
  hostname: string,
  deps: UrlReaderDeps,
): Promise<string> {
  const lookup = deps.lookup ?? defaultLookup;
  const answers = await lookup(hostname);
  if (!answers.length) {
    throw new UrlReadError("fetch_failed", "未能解析域名");
  }
  for (const answer of answers) {
    assertPublicAddress(answer.address);
  }
  return answers[0].address;
}

async function defaultLookup(hostname: string): Promise<{ address: string; family: number }[]> {
  const { promises } = await import("node:dns");
  const results = await promises.lookup(hostname, { all: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
}

async function defaultFetchOnce(
  url: string,
  init: { signal: AbortSignal; pinnedAddress: string },
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
        cb(null, [{ address: init.pinnedAddress, family: 4 }], 4);
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
  const initialUrl = assertValidRequestUrl(rawUrl);

  const callerSignal = deps.signal;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const combinedSignal = combineSignals([callerSignal, timeoutController.signal].filter(Boolean) as AbortSignal[]);

  try {
    let currentUrl: URL = initialUrl;
    let pinnedAddress: string | undefined;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (combinedSignal.aborted) throw new UrlReadError("aborted", "请求已取消");

      // Re-resolve and revalidate on each hop (including the first).
      pinnedAddress = await resolveAndValidate(currentUrl.hostname, deps);

      const fetchOnce = deps.fetchOnce ?? defaultFetchOnce;
      const response = await fetchOnce(currentUrl.toString(), {
        signal: combinedSignal,
        pinnedAddress,
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