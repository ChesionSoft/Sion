import { z } from "zod";
import type { SearchResult } from "./types";

/**
 * Provider-neutral tool contracts. Tool arguments are assembled by protocol
 * adapters but parsed and validated only here (and by the orchestrator's
 * budget). Tool results are stable JSON envelopes — never thrown stacks.
 */

export type ModelToolName = "web_search" | "web_fetch";

export type ModelToolDefinition = {
  name: ModelToolName;
  description: string;
  parameters: Record<string, unknown>;
};

export type ModelToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type ModelConversationItem =
  | { type: "message"; role: "system" | "user" | "assistant"; content: string }
  | { type: "tool_call"; call: ModelToolCall }
  | { type: "tool_result"; callId: string; name: string; output: string };

export type ModelTurnEvent =
  | { type: "content"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: ModelToolCall };

export const MAX_QUERY_LENGTH = 200;

const webSearchSchema = z
  .object({ query: z.string().trim().min(1).max(MAX_QUERY_LENGTH) })
  .strict();

const webFetchSchema = z
  .object({ url: z.string().trim().min(1) })
  .strict()
  .refine((v) => {
    try {
      const u = new URL(v.url);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "url must be http(s) without credentials");

export type ToolParseError = {
  ok: false;
  tool: string;
  code: "invalid_arguments" | "unknown_tool";
  error: string;
};

export type ToolParseSearch = { ok: true; tool: "web_search"; query: string };
export type ToolParseFetch = { ok: true; tool: "web_fetch"; url: string };

export function parseWebSearchArguments(argsJson: string): ToolParseSearch | ToolParseError {
  try {
    const parsed = webSearchSchema.parse(JSON.parse(argsJson));
    return { ok: true, tool: "web_search", query: parsed.query };
  } catch {
    return { ok: false, tool: "web_search", code: "invalid_arguments", error: "web_search 参数不合法" };
  }
}

export function parseWebFetchArguments(argsJson: string): ToolParseFetch | ToolParseError {
  try {
    const parsed = webFetchSchema.parse(JSON.parse(argsJson));
    return { ok: true, tool: "web_fetch", url: parsed.url };
  } catch {
    return { ok: false, tool: "web_fetch", code: "invalid_arguments", error: "web_fetch 参数不合法" };
  }
}

export function parseToolCall(
  call: ModelToolCall,
): ToolParseSearch | ToolParseFetch | ToolParseError {
  if (call.name === "web_search") return parseWebSearchArguments(call.argumentsJson);
  if (call.name === "web_fetch") return parseWebFetchArguments(call.argumentsJson);
  return { ok: false, tool: call.name, code: "unknown_tool", error: `未知工具：${call.name}` };
}

export const toolDefinitions: ModelToolDefinition[] = [
  {
    name: "web_search",
    description: "Search the public web via a safe browser. Returns up to 5 results with title, url, and snippet.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch the text content of a public HTTP(S) page. Use for pages surfaced by web_search.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The absolute http(s) URL to fetch." } },
      required: ["url"],
    },
  },
];

export type ToolResultEnvelope =
  | { ok: true; tool: ModelToolName; results?: SearchResult[]; content?: string; url?: string }
  | { ok: false; tool: ModelToolName; code: string; error: string };

export function toolResultJson(envelope: ToolResultEnvelope): string {
  return JSON.stringify(envelope);
}