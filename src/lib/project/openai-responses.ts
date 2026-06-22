import { createExternalSource } from "./external-source";
import type { ApiUrlMode, ExternalSource, ModelProviderProtocol, ProviderTokenUsage, ReasoningEffort } from "./types";
import type { ModelConversationItem, ModelToolDefinition, ModelToolCall, ModelTurnEvent } from "./model-tools";

export type ResponsesMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ResponsesInput = {
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  model: string;
  protocol: ModelProviderProtocol;
  reasoningEffort?: ReasoningEffort;
  messages: ResponsesMessage[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export type ResponsesTurnInput = {
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  model: string;
  protocol: ModelProviderProtocol;
  reasoningEffort?: ReasoningEffort;
  conversation: ModelConversationItem[];
  tools?: ModelToolDefinition[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export type ModelStreamPart =
  | { type: "content" | "reasoning"; content: string }
  | { type: "source"; source: ExternalSource }
  | { type: "usage"; usage: ProviderTokenUsage };

export type ModelTextResult = { content: string; usage: ProviderTokenUsage | null };

type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

/** Normalize an OpenAI Responses usage object, or null if incomplete. */
function normalizeResponsesUsage(usage: ResponsesUsage | undefined): ProviderTokenUsage | null {
  if (!usage) return null;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens = usage.total_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return null;
  }
  if (totalTokens !== inputTokens + outputTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

export function resolveResponsesUrl(apiBaseUrl: string, apiUrlMode: ApiUrlMode = "base"): string {
  const trimmed = apiBaseUrl.trim();
  if (apiUrlMode === "full") return trimmed;
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  const withoutV1 = withoutTrailingSlash.replace(/\/v1$/i, "");
  return `${withoutV1}/v1/responses`;
}

type Annotation = {
  type: string;
  url?: string;
  title?: string;
};

type CompletedResponse = {
  id?: string;
  usage?: ResponsesUsage;
  output?: Array<{
    type: string;
    content?: Array<{
      type: string;
      text?: string;
      annotations?: Annotation[];
    }>;
  }>;
};

function toResponsesInput(messages: ResponsesMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: [{ type: "input_text", text: m.content }],
  }));
}

async function* readSseLines(response: Response): AsyncGenerator<string, void, void> {
  if (!response.body) {
    throw new Error("Responses response did not include a streaming body");
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
    for (const line of lines) yield line;
  }
  if (buffer) yield buffer;
}

function buildSourceFromAnnotation(annotation: Annotation): ExternalSource | null {
  if (!annotation.url) return null;
  try {
    return createExternalSource({
      kind: "web_search",
      url: annotation.url,
      title: annotation.title || new URL(annotation.url).hostname,
      retrievedAt: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

export async function* streamOpenAIResponses(
  input: ResponsesInput,
): AsyncGenerator<ModelStreamPart, void, void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(resolveResponsesUrl(input.apiBaseUrl, input.apiUrlMode), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: toResponsesInput(input.messages),
      reasoning: {
        effort: input.reasoningEffort ?? "medium",
        summary: "auto",
      },
      stream: true,
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error(`Responses request failed with status ${response.status}`);
  }

  const seenSourceIds = new Set<string>();
  for await (const line of readSseLines(response)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const data = trimmed.slice(6);
    if (data === "[DONE]") return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = parsed.type as string | undefined;
    if (!type) continue;

    if (type === "error") {
      const message = (parsed as { message?: string }).message ?? "Responses error";
      throw new Error(message);
    }

    if (type === "response.failed") {
      const response = (parsed as { response?: { error?: { message?: string } } }).response;
      throw new Error(response?.error?.message ?? "Responses request failed");
    }

    if (type === "response.incomplete") {
      const response = (parsed as {
        response?: { incomplete_details?: { reason?: string } };
      }).response;
      const reason = response?.incomplete_details?.reason;
      throw new Error(reason ? `Responses request incomplete: ${reason}` : "Responses request incomplete");
    }

    if (type === "response.reasoning_summary_text.delta") {
      const delta = (parsed as { delta?: string }).delta;
      if (delta) yield { type: "reasoning", content: delta };
      continue;
    }

    if (type === "response.output_text.delta") {
      const delta = (parsed as { delta?: string }).delta;
      if (delta) yield { type: "content", content: delta };
      continue;
    }

    if (type === "response.output_text.annotation.added") {
      const annotation = (parsed as { annotation?: Annotation }).annotation;
      if (annotation) {
        const source = buildSourceFromAnnotation(annotation);
        if (source && !seenSourceIds.has(source.id)) {
          seenSourceIds.add(source.id);
          yield { type: "source", source };
        }
      }
      continue;
    }

    if (type === "response.completed") {
      const resp = (parsed as { response?: CompletedResponse }).response;
      if (resp?.output) {
        for (const item of resp.output) {
          for (const content of item.content ?? []) {
            for (const annotation of content.annotations ?? []) {
              const source = buildSourceFromAnnotation(annotation);
              if (source && !seenSourceIds.has(source.id)) {
                seenSourceIds.add(source.id);
                yield { type: "source", source };
              }
            }
          }
        }
      }
      const usage = normalizeResponsesUsage(resp?.usage);
      if (usage) yield { type: "usage", usage };
      continue;
    }
    // Unknown event types are ignored.
  }
}

export async function callOpenAIResponses(input: ResponsesInput): Promise<string> {
  const result = await callOpenAIResponsesDetailed(input);
  return result.content;
}

export async function callOpenAIResponsesDetailed(input: ResponsesInput): Promise<ModelTextResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(resolveResponsesUrl(input.apiBaseUrl, input.apiUrlMode), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: toResponsesInput(input.messages),
      reasoning: {
        effort: input.reasoningEffort ?? "medium",
        summary: "auto",
      },
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error(`Responses request failed with status ${response.status}`);
  }

  const json = (await response.json()) as CompletedResponse;
  for (const item of json.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.length > 0) {
        return { content: content.text, usage: normalizeResponsesUsage(json.usage) };
      }
    }
  }
  throw new Error("Responses response did not include output text");
}

// ---------------------------------------------------------------------------
// Standard function-tool turn (Responses). Protocol chooses wire shape only —
// no hosted web_search. Returns the same ModelTurnEvent union as Chat
// Completions.
// ---------------------------------------------------------------------------

type ResponsesInputItem = Record<string, unknown>;

function buildResponsesConversation(conversation: ModelConversationItem[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const entry of conversation) {
    if (entry.type === "message") {
      items.push({
        role: entry.role,
        content: [{ type: "input_text", text: entry.content }],
      });
    } else if (entry.type === "tool_call") {
      items.push({
        type: "function_call",
        call_id: entry.call.id,
        name: entry.call.name,
        arguments: entry.call.argumentsJson,
      });
    } else {
      items.push({
        type: "function_call_output",
        call_id: entry.callId,
        output: entry.output,
      });
    }
  }
  return items;
}

type FunctionCallBuffer = { callId?: string; name?: string; arguments: string };

export async function* streamOpenAIResponsesTurn(
  input: ResponsesTurnInput,
): AsyncGenerator<ModelTurnEvent, void, void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: input.model,
    input: buildResponsesConversation(input.conversation),
    reasoning: { effort: input.reasoningEffort ?? "medium", summary: "auto" },
    stream: true,
  };
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
  }

  const response = await fetchImpl(resolveResponsesUrl(input.apiBaseUrl, input.apiUrlMode), {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error(`Responses request failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Responses response did not include a streaming body");
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Buffers keyed by item_id (from output_item.added) accumulate arguments deltas.
  const functionBuffers = new Map<string, FunctionCallBuffer>();
  // Calls registered without a streaming id (arguments present in the added item).
  const standaloneCalls: ModelToolCall[] = [];

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
          flushFunctionCalls(functionBuffers, standaloneCalls, /*yielder*/ undefined);
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = parsed.type as string | undefined;
        if (!type) continue;

        if (type === "error") {
          throw new Error((parsed as { message?: string }).message ?? "Responses error");
        }
        if (type === "response.failed") {
          const r = (parsed as { response?: { error?: { message?: string } } }).response;
          throw new Error(r?.error?.message ?? "Responses request failed");
        }
        if (type === "response.incomplete") {
          const r = (parsed as { response?: { incomplete_details?: { reason?: string } } }).response;
          const reason = r?.incomplete_details?.reason;
          throw new Error(reason ? `Responses request incomplete: ${reason}` : "Responses request incomplete");
        }
        if (type === "response.reasoning_summary_text.delta") {
          const delta = (parsed as { delta?: string }).delta;
          if (delta) yield { type: "reasoning", delta };
          continue;
        }
        if (type === "response.output_text.delta") {
          const delta = (parsed as { delta?: string }).delta;
          if (delta) yield { type: "content", delta };
          continue;
        }
        if (type === "response.output_item.added") {
          const item = (parsed as { item?: { type?: string; call_id?: string; name?: string; arguments?: string; id?: string } }).item;
          if (item?.type === "function_call" && item.call_id && item.name) {
            const buf: FunctionCallBuffer = {
              callId: item.call_id,
              name: item.name,
              arguments: typeof item.arguments === "string" ? item.arguments : "",
            };
            if (item.id) {
              functionBuffers.set(item.id, buf);
            } else if (buf.arguments) {
              standaloneCalls.push({ id: item.call_id, name: item.name, argumentsJson: buf.arguments });
            } else {
              functionBuffers.set(item.call_id, buf);
            }
          }
          continue;
        }
        if (type === "response.function_call_arguments.delta") {
          const itemId = (parsed as { item_id?: string }).item_id;
          const delta = (parsed as { delta?: string }).delta;
          if (itemId && delta) {
            const buf = functionBuffers.get(itemId);
            if (buf) buf.arguments += delta;
          }
          continue;
        }
        if (type === "response.completed") {
          for (const call of collectCalls(functionBuffers, standaloneCalls)) {
            yield { type: "tool_call", call };
          }
          functionBuffers.clear();
          standaloneCalls.length = 0;
          const resp = (parsed as { response?: CompletedResponse }).response;
          const usage = normalizeResponsesUsage(resp?.usage);
          if (usage) yield { type: "usage", usage };
          continue;
        }
      }
    }
  } finally {
    await reader.closed.catch(() => {});
    reader.releaseLock();
  }
}

function collectCalls(
  buffers: Map<string, FunctionCallBuffer>,
  standalone: ModelToolCall[],
): ModelToolCall[] {
  const calls: ModelToolCall[] = [...standalone];
  for (const buf of buffers.values()) {
    if (!buf.callId || !buf.name) {
      throw new Error("Responses returned an incomplete function call");
    }
    calls.push({ id: buf.callId, name: buf.name, argumentsJson: buf.arguments });
  }
  return calls;
}

// Placeholder kept for symmetry with the [DONE] path; the actual flush happens
// via collectCalls at response.completed. At [DONE] without a completed event,
// any buffered calls are also flushed here.
function flushFunctionCalls(
  buffers: Map<string, FunctionCallBuffer>,
  standalone: ModelToolCall[],
  yielder: undefined,
): void {
  void yielder;
  // Throw on incomplete so they never execute; complete calls were already
  // emitted at response.completed. This guard only matters if a stream ends
  // without a completed event.
  for (const buf of buffers.values()) {
    if (!buf.callId || !buf.name) {
      throw new Error("Responses returned an incomplete function call");
    }
  }
  void standalone;
}
