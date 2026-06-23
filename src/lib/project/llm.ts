import type { ApiUrlMode, ProviderTokenUsage } from "./types";
import type { ModelConversationItem, ModelToolDefinition, ModelToolCall, ModelTurnEvent } from "./model-tools";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CallOpenAICompatibleChatInput = {
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  messages: LlmMessage[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

/** Non-stream result carrying exact provider usage when reported. */
export type ModelTextResult = { content: string; usage: ProviderTokenUsage | null };

type ChatCompletionsUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

/** Normalize an OpenAI Chat Completions usage object, or null if incomplete. */
function normalizeChatUsage(usage: ChatCompletionsUsage | undefined): ProviderTokenUsage | null {
  if (!usage) return null;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return null;
  }
  const value: ProviderTokenUsage = { inputTokens, outputTokens, totalTokens };
  // Validate totals add up; otherwise drop the bogus usage and let callers estimate.
  if (totalTokens !== inputTokens + outputTokens) return null;
  return value;
}

export async function callOpenAICompatibleChat(input: CallOpenAICompatibleChatInput): Promise<string> {
  const result = await callOpenAICompatibleChatDetailed(input);
  return result.content;
}

export async function callOpenAICompatibleChatDetailed(
  input: CallOpenAICompatibleChatInput,
): Promise<ModelTextResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(resolveChatCompletionsUrl(input.apiBaseUrl, input.apiUrlMode), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      temperature: 0.2,
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: ChatCompletionsUsage;
  };

  const content = json.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM response did not include message content");
  }

  return { content, usage: normalizeChatUsage(json.usage) };
}

export type StreamOpenAICompatibleChatInput = CallOpenAICompatibleChatInput & {
  signal?: AbortSignal;
};

export type LlmStreamPart =
  | { type: "content" | "reasoning"; content: string }
  | { type: "usage"; usage: ProviderTokenUsage };

export async function* streamOpenAICompatibleChat(
  input: StreamOpenAICompatibleChatInput,
): AsyncGenerator<LlmStreamPart, void, void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = resolveChatCompletionsUrl(input.apiBaseUrl, input.apiUrlMode);
  const baseBody = {
    model: input.model,
    messages: input.messages,
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
    temperature: 0.2,
    stream: true,
  };

  let response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...baseBody, stream_options: { include_usage: true } }),
    signal: input.signal,
  });

  // Some OpenAI-compatible providers reject stream_options. Retry once
  // without it only when the initial response is a 400 that mentions
  // stream_options in its body. The 400 body is consumed here; since we
  // either retry or throw, the original response is not reused.
  if (response.status === 400) {
    let mentionsStreamOptions = false;
    try {
      const text = await response.text();
      mentionsStreamOptions = text.includes("stream_options");
    } catch {
      mentionsStreamOptions = false;
    }
    if (mentionsStreamOptions) {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(baseBody),
        signal: input.signal,
      });
    }
  }

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  if (!response.body) {
    throw new Error("LLM response did not include a streaming body");
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning?: string;
              reasoning_content?: string;
              reasoningContent?: string;
            };
          }>;
          usage?: ChatCompletionsUsage;
        };
        const delta = parsed.choices?.[0]?.delta;
        const reasoning = delta?.reasoning_content ?? delta?.reasoningContent ?? delta?.reasoning;
        if (reasoning) yield { type: "reasoning", content: reasoning };
        if (delta?.content) yield { type: "content", content: delta.content };
        if (parsed.usage) {
          const usage = normalizeChatUsage(parsed.usage);
          if (usage) yield { type: "usage", usage };
        }
      } catch {
        // skip malformed chunks
      }
    }
  }
}

export function resolveChatCompletionsUrl(apiBaseUrl: string, apiUrlMode: ApiUrlMode = "base"): string {
  const trimmed = apiBaseUrl.trim();
  if (apiUrlMode === "full") return trimmed;
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  const withoutV1 = withoutTrailingSlash.replace(/\/v1$/i, "");
  return `${withoutV1}/v1/chat/completions`;
}

// ---------------------------------------------------------------------------
// Tool-aware model turn (Chat Completions). Assembles streamed tool_call
// fragments by index/id into complete ModelToolCall's; preserves content and
// reasoning deltas; closes the reader in finally; supports abort.
// ---------------------------------------------------------------------------

export type ChatCompletionsTurnInput = {
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  conversation: ModelConversationItem[];
  tools?: ModelToolDefinition[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

type OpenAIMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function buildMessages(conversation: ModelConversationItem[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  for (const item of conversation) {
    if (item.type === "message") {
      messages.push({ role: item.role, content: item.content });
    } else if (item.type === "tool_call") {
      // Merge consecutive tool calls into the preceding assistant message;
      // otherwise start a new assistant message carrying tool_calls.
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && last.tool_calls) {
        last.tool_calls.push({
          id: item.call.id,
          type: "function",
          function: { name: item.call.name, arguments: item.call.argumentsJson },
        });
      } else {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: item.call.id, type: "function", function: { name: item.call.name, arguments: item.call.argumentsJson } },
          ],
        });
      }
    } else {
      messages.push({ role: "tool", tool_call_id: item.callId, content: item.output });
    }
  }
  return messages;
}

export async function* streamChatCompletionsTurn(
  input: ChatCompletionsTurnInput,
): AsyncGenerator<ModelTurnEvent, void, void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const messages = buildMessages(input.conversation);
  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
    temperature: 0.2,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const url = resolveChatCompletionsUrl(input.apiBaseUrl, input.apiUrlMode);
  let response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: input.signal,
  });

  // Some OpenAI-compatible providers reject stream_options. Mirror the plain
  // streaming path: retry once without stream_options only for that specific
  // 400, preserving the tool payload and all other request fields.
  if (response.status === 400) {
    let mentionsStreamOptions = false;
    try {
      const text = await response.text();
      mentionsStreamOptions = text.includes("stream_options");
    } catch {
      mentionsStreamOptions = false;
    }
    if (mentionsStreamOptions) {
      const fallbackBody = { ...body };
      delete fallbackBody.stream_options;
      response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(fallbackBody),
        signal: input.signal,
      });
    }
  }

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error("LLM response did not include a streaming body");
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolBuffers = new Map<number, { id?: string; name?: string; arguments: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          for (const call of assembleToolCalls(toolBuffers)) yield { type: "tool_call", call };
          return;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning?: string;
                reasoning_content?: string;
                reasoningContent?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: ChatCompletionsUsage;
          };
          const delta = parsed.choices?.[0]?.delta;
          if (delta) {
            const reasoning = delta.reasoning_content ?? delta.reasoningContent ?? delta.reasoning;
            if (reasoning) yield { type: "reasoning", delta: reasoning };
            if (delta.content) yield { type: "content", delta: delta.content };
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const buf = toolBuffers.get(tc.index) ?? { arguments: "" };
                if (tc.id) buf.id = tc.id;
                if (tc.function?.name) buf.name = (buf.name ?? "") + tc.function.name;
                if (tc.function?.arguments) buf.arguments += tc.function.arguments;
                toolBuffers.set(tc.index, buf);
              }
            }
          }
          const finish = parsed.choices?.[0]?.finish_reason;
          if (finish === "tool_calls") {
            for (const call of assembleToolCalls(toolBuffers)) yield { type: "tool_call", call };
            toolBuffers.clear();
          }
          if (parsed.usage) {
            const usage = normalizeChatUsage(parsed.usage);
            if (usage) yield { type: "usage", usage };
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    await reader.closed.catch(() => {});
    reader.releaseLock();
  }
}

function assembleToolCalls(buffers: Map<number, { id?: string; name?: string; arguments: string }>): ModelToolCall[] {
  const calls: ModelToolCall[] = [];
  for (const buf of buffers.values()) {
    if (!buf.id || !buf.name) {
      throw new Error("LLM returned an incomplete tool call");
    }
    calls.push({ id: buf.id, name: buf.name, argumentsJson: buf.arguments });
  }
  return calls;
}
