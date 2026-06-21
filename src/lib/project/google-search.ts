import * as cheerio from "cheerio";
import { dedupeAndRank, normalizeResultUrl, type SearchEngineAdapter } from "./search-engine";

/**
 * Google search adapter. Google wraps result links in `/url?q=<real>&sa=...`;
 * the real URL is restored from the `q` parameter. Sponsored results carry a
 * `data-sponsored` marker; internal google.com links are filtered.
 */
export const googleSearchAdapter: SearchEngineAdapter = {
  id: "google",

  buildUrl(query: string): string {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  },

  parseHtml(html: string) {
    const $ = cheerio.load(html);
    const raw: { title: string; url: string; snippet?: string }[] = [];

    $("div.g").each((_i, el) => {
      const $el = $(el);
      if ($el.attr("data-sponsored")) return; // ad

      const anchor = $el.find("a").first();
      const href = anchor.attr("href") ?? "";
      const url = unwrapGoogleUrl(href);
      if (!url) return;

      const title = $el.find("h3").first().text().trim();
      if (!title) return;

      const host = safeHost(url);
      if (host && isGoogleInternal(host)) return; // internal link

      const snippet = $el.find("span.st").first().text().trim() || undefined;
      raw.push({ title, url, snippet });
    });

    return dedupeAndRank(raw);
  },

  detectVerification(html: string): boolean {
    const $ = cheerio.load(html);
    if ($("#captcha").length) return true;
    const text = $("body").text();
    return /unusual traffic|our systems have detected|captcha/i.test(text);
  },
};

function unwrapGoogleUrl(href: string): string | null {
  if (!href) return null;
  // Google redirect wrapper: /url?q=<real>&sa=...
  if (href.startsWith("/url?") || href.includes("/url?")) {
    try {
      const u = new URL(href, "https://www.google.com");
      const q = u.searchParams.get("q");
      if (q) return normalizeResultUrl(q);
    } catch {
      return null;
    }
  }
  return normalizeResultUrl(href);
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isGoogleInternal(host: string): boolean {
  return host === "www.google.com" || host === "google.com";
}