import { describe, expect, it } from "vitest";
import {
  parseWebSearchArguments,
  parseWebFetchArguments,
  parseToolCall,
  toolDefinitions,
  type ModelToolCall,
} from "./model-tools";

describe("parseWebSearchArguments", () => {
  it("parses a valid query", () => {
    expect(parseWebSearchArguments(JSON.stringify({ query: "hello world" }))).toEqual({
      ok: true,
      tool: "web_search",
      query: "hello world",
    });
  });

  it("rejects malformed JSON with a structured error", () => {
    const result = parseWebSearchArguments("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tool).toBe("web_search");
      expect(result.code).toBe("invalid_arguments");
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects extra keys", () => {
    const result = parseWebSearchArguments(JSON.stringify({ query: "x", extra: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_arguments");
  });

  it("rejects a blank query", () => {
    const result = parseWebSearchArguments(JSON.stringify({ query: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_arguments");
  });

  it("rejects an overlong query", () => {
    const result = parseWebSearchArguments(JSON.stringify({ query: "x".repeat(300) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_arguments");
  });

  it("rejects a missing query", () => {
    const result = parseWebSearchArguments(JSON.stringify({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_arguments");
  });
});

describe("parseWebFetchArguments", () => {
  it("parses a valid http(s) url without credentials", () => {
    const result = parseWebFetchArguments(JSON.stringify({ url: "https://example.com/page" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("https://example.com/page");
  });

  it("rejects a non-http(s) url", () => {
    const result = parseWebFetchArguments(JSON.stringify({ url: "file:///etc/passwd" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_arguments");
  });

  it("rejects a url with embedded credentials", () => {
    const result = parseWebFetchArguments(JSON.stringify({ url: "https://user:pass@example.com/" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_arguments");
  });

  it("rejects extra keys", () => {
    const result = parseWebFetchArguments(JSON.stringify({ url: "https://example.com/", x: 1 }));
    expect(result.ok).toBe(false);
  });
});

describe("parseToolCall", () => {
  it("parses a web_search call", () => {
    const call: ModelToolCall = { id: "c1", name: "web_search", argumentsJson: JSON.stringify({ query: "q" }) };
    const result = parseToolCall(call);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tool).toBe("web_search");
  });

  it("returns a structured error for an unknown tool", () => {
    const call: ModelToolCall = { id: "c2", name: "delete_db", argumentsJson: "{}" };
    const result = parseToolCall(call);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_tool");
  });

  it("returns a structured error for invalid arguments", () => {
    const call: ModelToolCall = { id: "c3", name: "web_search", argumentsJson: "bad" };
    const result = parseToolCall(call);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_arguments");
  });
});

describe("toolDefinitions", () => {
  it("exposes web_search and web_fetch definitions", () => {
    const names = toolDefinitions.map((d) => d.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
  });
});