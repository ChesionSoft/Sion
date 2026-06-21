import * as cheerio from "cheerio";

const DEFAULT_URL_LIMIT = 3;
const MAX_PAGE_CHARACTERS = 20_000;

const URL_REGEX = /https?:\/\/[!-~]+/g;

// Markdown code fences and inline code can contain example URLs we don't want
// to fetch. Strip them before scanning.
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

function stripTrailingPunctuation(url: string): string {
  let s = url;
  // ASCII punctuation commonly trailing a pasted URL.
  s = s.replace(/[.,;:!?)\]"'<>]+$/u, "");
  // Chinese full-width punctuation.
  s = s.replace(/[。，；：！？、）】》”’]+$/u, "");
  return s;
}

export function extractHttpUrls(message: string, limit: number = DEFAULT_URL_LIMIT): string[] {
  if (!message) return [];
  const cleaned = stripCodeBlocks(message);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of cleaned.matchAll(URL_REGEX)) {
    const candidate = stripTrailingPunctuation(match[0]);
    if (!candidate) continue;
    try {
      const normalized = new URL(candidate).toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= limit) break;
    } catch {
      // not a valid URL — skip
    }
  }
  return out;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

export function extractPageText(contentType: string, body: string): { title: string; text: string } {
  if (!contentType) return { title: "", text: "" };
  const ct = contentType.toLowerCase().split(";")[0].trim();

  if (ct === "text/plain") {
    const text = truncate(collapseWhitespace(body), MAX_PAGE_CHARACTERS);
    return { title: "", text };
  }

  if (ct !== "text/html" && ct !== "application/xhtml+xml") {
    return { title: "", text: "" };
  }

  const $ = cheerio.load(body);
  const title = ($("title").first().text() ?? "").trim();
  $("script,style,noscript,nav,header,footer,form,svg,iframe,template").remove();

  const root = $("main,article,[role=main]").first()[0];
  const textNode = root ? $(root) : $("body");
  const text = collapseWhitespace(textNode.text() ?? "");
  return { title, text: truncate(text, MAX_PAGE_CHARACTERS) };
}