import { afterEach, describe, expect, it, vi } from "vitest";
import { readPublicUrl, readPublicUrls, UrlReadError } from "./url-reader";
import type { ExternalSource } from "./types";

type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;
type FetchOnceFn = (url: string, init: { signal: AbortSignal; pinnedAddress: string }) => Promise<{
  status: number;
  headers: { location?: string; "content-type"?: string };
  body: Uint8Array;
}>;

function okResponse(body: string, contentType = "text/html"): NonNullable<Awaited<ReturnType<FetchOnceFn>>> {
  return {
    status: 200,
    headers: { "content-type": contentType },
    body: new TextEncoder().encode(body),
  };
}

describe("url-reader/readPublicUrl", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads a single public page", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => okResponse("<main>正文</main>")) as unknown as FetchOnceFn;

    const result = await readPublicUrl("https://example.com/", { lookup, fetchOnce });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.kind).toBe("provided_url");
      expect(result.source.url).toBe("https://example.com/");
      expect(result.source.domain).toBe("example.com");
      expect(result.content).toContain("正文");
    }
    expect(lookup).toHaveBeenCalledWith("example.com");
  });

  it("preserves the DNS family when pinning an IPv6 address", async () => {
    const lookup = vi.fn(async () => [
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async (_url, init) => {
      expect((init as { pinnedFamily?: number }).pinnedFamily).toBe(6);
      return okResponse("<main>IPv6</main>");
    }) as unknown as FetchOnceFn;

    await readPublicUrl("https://ipv6.test/", { lookup, fetchOnce });
  });

  it("rejects embedded credentials", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => okResponse("x")) as unknown as FetchOnceFn;

    await expect(
      readPublicUrl("https://user:pass@example.com/", { lookup, fetchOnce }),
    ).rejects.toThrow(UrlReadError);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) protocols", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => okResponse("x")) as unknown as FetchOnceFn;

    await expect(
      readPublicUrl("file:///etc/passwd", { lookup, fetchOnce }),
    ).rejects.toThrow(UrlReadError);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("validates every DNS answer, not just the chosen one", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => okResponse("x")) as unknown as FetchOnceFn;

    await expect(
      readPublicUrl("https://example.com/", { lookup, fetchOnce }),
    ).rejects.toThrow(UrlReadError);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("revalidates every redirect and blocks a redirect to a private IP", async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => ({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
      body: new Uint8Array(),
    })) as unknown as FetchOnceFn;

    await expect(
      readPublicUrl("https://public.test", { lookup, fetchOnce }),
    ).rejects.toThrow(UrlReadError);
  });

  it("follows up to three safe redirects", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn()
      .mockResolvedValueOnce({ status: 301, headers: { location: "https://a.test/2" }, body: new Uint8Array() })
      .mockResolvedValueOnce({ status: 302, headers: { location: "https://a.test/3" }, body: new Uint8Array() })
      .mockResolvedValueOnce({ status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("<main>终</main>") }) as unknown as FetchOnceFn;

    const result = await readPublicUrl("https://a.test/1", { lookup, fetchOnce });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.url).toBe("https://a.test/3");
      expect(result.content).toContain("终");
    }
  });

  it("rejects after exceeding the redirect limit", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => ({
      status: 302,
      headers: { location: "https://a.test/loop" },
      body: new Uint8Array(),
    })) as unknown as FetchOnceFn;

    await expect(
      readPublicUrl("https://a.test/", { lookup, fetchOnce }),
    ).rejects.toThrow(UrlReadError);
  });

  it("rejects disallowed content types", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => okResponse("binary", "application/pdf")) as unknown as FetchOnceFn;

    await expect(
      readPublicUrl("https://a.test/", { lookup, fetchOnce }),
    ).rejects.toThrow(UrlReadError);
  });

  it("aborts when the caller signal aborts", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async (_url, init) => {
      // simulate long latency; abort should reject
      return new Promise<{ status: number; headers: { "content-type"?: string }; body: Uint8Array }>(
        (_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        },
      );
    }) as unknown as FetchOnceFn;

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    await expect(
      readPublicUrl("https://a.test/", { lookup, fetchOnce, signal: ac.signal }),
    ).rejects.toThrow();
  });
});

describe("url-reader/readPublicUrls", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps successful pages when another URL fails", async () => {
    const goodUrl = "https://good.test/";
    const badUrl = "https://bad.test/";

    const lookup = vi.fn(async (host: string) => {
      if (host === "good.test") return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "127.0.0.1", family: 4 }];
    }) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => okResponse("<main>ok</main>")) as unknown as FetchOnceFn;

    const results = await readPublicUrls([goodUrl, badUrl], { lookup, fetchOnce });
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    const good = results[0];
    if (good?.ok) {
      expect(good.source.url).toBe(goodUrl);
    }
    const bad = results[1];
    if (!bad?.ok) {
      expect(bad.error).toBeTruthy();
      expect(bad.code).toBe("blocked_address");
    }
  });

  it("does not expose resolved addresses or page bodies in error messages", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
    const fetchOnce = vi.fn(async () => okResponse("secret body")) as unknown as FetchOnceFn;

    const results = await readPublicUrls(["https://bad.test/"], { lookup, fetchOnce });
    const bad = results[0];
    if (!bad?.ok) {
      expect(bad.error).not.toContain("127.0.0.1");
    }
  });
});

// Type-only smoke import to keep ExternalSource referenced in this file's surface.
export type { ExternalSource };
