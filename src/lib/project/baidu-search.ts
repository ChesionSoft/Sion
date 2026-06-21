import * as cheerio from "cheerio";
import { dedupeAndRank, normalizeResultUrl, type SearchEngineAdapter } from "./search-engine";

/**
 * Baidu search adapter. Baidu wraps result links in `/link?url=<token>`
 * redirects; the real URL is shown in a `<cite>` element, which the parser
 * uses as the result URL. Sponsored results carry a `data-tuiguang` marker;
 * internal baidu.com links are filtered.
 */
export const baiduSearchAdapter: SearchEngineAdapter = {
  id: "baidu",

  resultSelector: "div.result, div.c-container",

  buildUrl(query: string): string {
    return `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
  },

  parseHtml(html: string) {
    const $ = cheerio.load(html);
    const raw: { title: string; url: string; snippet?: string }[] = [];

    $("div.result, div.c-container").each((_i, el) => {
      const $el = $(el);
      if ($el.attr("data-tuiguang") || $el.attr("data-sponsored")) return; // ad

      const cite = $el.find("cite").first().text().trim();
      const url = normalizeResultUrl(cite);
      if (!url) return;

      const title = $el.find("h3 a").first().text().trim() || $el.find("h3").first().text().trim();
      if (!title) return;

      const host = safeHost(url);
      if (host && isBaiduInternal(host)) return; // internal link

      const snippet = $el.find(".content-right_8Zs40, .c-span-last, span.st").first().text().trim() || undefined;
      raw.push({ title, url, snippet });
    });

    return dedupeAndRank(raw);
  },

  detectVerification(html: string): boolean {
    const $ = cheerio.load(html);
    if ($("#captcha").length) return true;
    const text = $("body").text();
    return /验证码|captcha|请输入验证/i.test(text);
  },
};

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isBaiduInternal(host: string): boolean {
  return host === "www.baidu.com" || host === "baidu.com";
}