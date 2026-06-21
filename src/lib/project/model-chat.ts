import {
  callOpenAICompatibleChat,
  streamOpenAICompatibleChat,
  type LlmMessage,
  type LlmStreamPart,
} from "./llm";
import {
  callOpenAIResponses,
  streamOpenAIResponses,
  type ModelStreamPart,
  type ResponsesInput,
  type ResponsesMessage,
} from "./openai-responses";
import type { ApiUrlMode, ExternalSource, ModelProviderProtocol, ReasoningEffort } from "./types";

export type ModelChatInput = {
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  model: string;
  protocol: ModelProviderProtocol;
  reasoningEffort?: ReasoningEffort;
  webSearchEnabled?: boolean;
  messages: LlmMessage[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export type { ModelStreamPart, ExternalSource };

function toResponsesMessages(messages: LlmMessage[]): ResponsesMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export function streamModelChat(input: ModelChatInput): AsyncGenerator<ModelStreamPart, void, void> {
  if (input.protocol === "openai_responses") {
    const responsesInput: ResponsesInput = {
      apiBaseUrl: input.apiBaseUrl,
      apiUrlMode: input.apiUrlMode,
      apiKey: input.apiKey,
      model: input.model,
      protocol: input.protocol,
      reasoningEffort: input.reasoningEffort,
      webSearchEnabled: input.webSearchEnabled,
      messages: toResponsesMessages(input.messages),
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    };
    return streamOpenAIResponses(responsesInput);
  }

  return (async function* (): AsyncGenerator<ModelStreamPart, void, void> {
    for await (const part of streamOpenAICompatibleChat({
      apiBaseUrl: input.apiBaseUrl,
      apiUrlMode: input.apiUrlMode,
      apiKey: input.apiKey,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      messages: input.messages,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    })) {
      const next: LlmStreamPart = part;
      yield next as ModelStreamPart;
    }
  })();
}

export async function callModelChat(input: ModelChatInput): Promise<string> {
  if (input.protocol === "openai_responses") {
    return callOpenAIResponses({
      apiBaseUrl: input.apiBaseUrl,
      apiUrlMode: input.apiUrlMode,
      apiKey: input.apiKey,
      model: input.model,
      protocol: input.protocol,
      reasoningEffort: input.reasoningEffort,
      webSearchEnabled: input.webSearchEnabled,
      messages: toResponsesMessages(input.messages),
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    });
  }
  return callOpenAICompatibleChat({
    apiBaseUrl: input.apiBaseUrl,
    apiUrlMode: input.apiUrlMode,
    apiKey: input.apiKey,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    messages: input.messages,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
}