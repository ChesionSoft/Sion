import type { ApiUrlMode } from "./types";
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

export async function callOpenAICompatibleChat(input: CallOpenAICompatibleChatInput): Promise<string> {
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
  };

  const content = json.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM response did not include message content");
  }

  return content;
}

export type StreamOpenAICompatibleChatInput = CallOpenAICompatibleChatInput & {
  signal?: AbortSignal;
};

export type LlmStreamPart = {
  type: "content" | "reasoning";
  content: string;
};

export async function* streamOpenAICompatibleChat(
  input: StreamOpenAICompatibleChatInput,
): AsyncGenerator<LlmStreamPart, void, void> {
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
      stream: true,
    }),
    signal: input.signal,
  });

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
        };
        const delta = parsed.choices?.[0]?.delta;
        const reasoning = delta?.reasoning_content ?? delta?.reasoningContent ?? delta?.reasoning;
        if (reasoning) yield { type: "reasoning", content: reasoning };
        if (delta?.content) yield { type: "content", content: delta.content };
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
  };
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const response = await fetchImpl(resolveChatCompletionsUrl(input.apiBaseUrl, input.apiUrlMode), {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: input.signal,
  });

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
