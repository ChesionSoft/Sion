import { createExternalSource } from "./external-source";
import type { ApiUrlMode, ExternalSource, ModelProviderProtocol, ReasoningEffort } from "./types";

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
  webSearchEnabled?: boolean;
  messages: ResponsesMessage[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export type ModelStreamPart =
  | { type: "content" | "reasoning"; content: string }
  | { type: "source"; source: ExternalSource };

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
      ...(input.webSearchEnabled ? { tools: [{ type: "web_search" }] } : {}),
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
      continue;
    }
    // Unknown event types are ignored.
  }
}

export async function callOpenAIResponses(input: ResponsesInput): Promise<string> {
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
      ...(input.webSearchEnabled ? { tools: [{ type: "web_search" }] } : {}),
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
        return content.text;
      }
    }
  }
  throw new Error("Responses response did not include output text");
}