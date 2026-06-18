import type { ApiUrlMode } from "./types";

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
