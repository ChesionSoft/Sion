import { describe, expect, it } from "vitest";
import { extractHttpUrls, extractPageText } from "./url-content";

describe("url-content", () => {
  describe("extractHttpUrls", () => {
    it("extracts plain http(s) urls", () => {
      expect(extractHttpUrls("看 https://a.test/x 和 http://b.test/y")).toEqual([
        "https://a.test/x",
        "http://b.test/y",
      ]);
    });

    it("strips trailing ASCII punctuation", () => {
      expect(extractHttpUrls("see https://a.test/x.")).toEqual(["https://a.test/x"]);
      expect(extractHttpUrls("see https://a.test/x,")).toEqual(["https://a.test/x"]);
      expect(extractHttpUrls("see https://a.test/x;")).toEqual(["https://a.test/x"]);
      expect(extractHttpUrls("see https://a.test/x)")).toEqual(["https://a.test/x"]);
    });

    it("strips trailing Chinese punctuation", () => {
      expect(extractHttpUrls("看 https://a.test/x，另见 https://a.test/x。和 https://b.test")).toEqual([
        "https://a.test/x",
        "https://b.test/",
      ]);
    });

    it("deduplicates urls preserving order", () => {
      expect(extractHttpUrls("https://a.test/x https://a.test/x https://b.test")).toEqual([
        "https://a.test/x",
        "https://b.test/",
      ]);
    });

    it("caps to the limit", () => {
      expect(
        extractHttpUrls("https://a.test https://b.test https://c.test https://d.test"),
      ).toHaveLength(3);
    });

    it("accepts a custom limit", () => {
      expect(
        extractHttpUrls("https://a.test https://b.test https://c.test https://d.test", 2),
      ).toHaveLength(2);
    });

    it("ignores code blocks", () => {
      const text = "```\nhttps://code.test/x\n```\nhttps://real.test/y";
      expect(extractHttpUrls(text)).toEqual(["https://real.test/y"]);
    });

    it("ignores inline code spans", () => {
      const text = "see `https://inline.test/x` then https://real.test/y";
      expect(extractHttpUrls(text)).toEqual(["https://real.test/y"]);
    });
  });

  describe("extractPageText", () => {
    it("removes script, style, nav, footer and extracts main content", () => {
      const html = "<title>A</title><nav>菜单</nav><main>正文 <b>内容</b></main><footer>页脚</footer>";
      expect(extractPageText("text/html", html)).toEqual({ title: "A", text: "正文 内容" });
    });

    it("falls back to body when no main/article", () => {
      const html = "<title>T</title><body>页面 <p>内容</p></body>";
      expect(extractPageText("text/html", html)).toEqual({ title: "T", text: "页面 内容" });
    });

    it("truncates to the max character budget", () => {
      const long = "a".repeat(50_000);
      const html = `<title>T</title><main>${long}</main>`;
      const { text } = extractPageText("text/html", html);
      expect(text.length).toBeLessThanOrEqual(20_000);
    });

    it("treats plain text as already-extracted", () => {
      expect(extractPageText("text/plain", "  hello   world  ")).toEqual({ title: "", text: "hello world" });
    });

    it("returns empty text for unknown content types", () => {
      expect(extractPageText("application/pdf", "binary stuff")).toEqual({ title: "", text: "" });
    });
  });
});