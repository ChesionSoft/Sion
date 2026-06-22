import { randomUUID } from "node:crypto";
import {
  callOpenAICompatibleChatDetailed,
  streamChatCompletionsTurn,
  streamOpenAICompatibleChat,
  type LlmMessage,
  type LlmStreamPart,
} from "./llm";
import {
  callOpenAIResponsesDetailed,
  streamOpenAIResponses,
  streamOpenAIResponsesTurn,
  type ModelStreamPart,
  type ResponsesInput,
  type ResponsesMessage,
} from "./openai-responses";
import {
  buildModelCallUsage,
} from "./token-usage";
import type {
  ModelConversationItem,
  ModelToolDefinition,
  ModelTurnEvent,
} from "./model-tools";
import type {
  ApiUrlMode,
  ExternalSource,
  ModelCallCategory,
  ModelCallUsage,
  ModelProviderProtocol,
  ProviderTokenUsage,
  ReasoningEffort,
} from "./types";

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
  usageContext?: ModelUsageContext;
};

export type { ModelStreamPart, ExternalSource };

/**
 * Per-call usage tracking context. When supplied to a model entry point, the
 * wrapper serializes the request, accumulates the response text, captures any
 * exact provider usage event, and reports one ModelCallUsage via `onUsage` when
 * the call completes, fails, or aborts. The internal `usage` event is never
 * forwarded to UI consumers.
 */
export type ModelUsageContext = {
  turnId: string;
  category: ModelCallCategory;
  providerId: string;
  onUsage: (usage: ModelCallUsage) => void;
};

function toResponsesMessages(messages: LlmMessage[]): ResponsesMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** Serialize chat messages into a single input-text blob for token estimation. */
function serializeMessages(messages: LlmMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

/** Serialize a tool conversation into a single input-text blob. */
function serializeConversation(conversation: ModelConversationItem[]): string {
  return conversation
    .map((item) => {
      if (item.type === "message") return `${item.role}: ${item.content}`;
      if (item.type === "tool_call") return `assistant tool_call ${item.call.name}: ${item.call.argumentsJson}`;
      return `tool_result ${item.callId}: ${item.output}`;
    })
    .join("\n");
}

/** Report one usage record, guarding against double-report on re-entry. */
function reportUsage(
  usageContext: ModelUsageContext | undefined,
  model: string,
  inputText: string,
  outputText: string,
  exact: ProviderTokenUsage | null,
  status: ModelCallUsage["status"],
): void {
  if (!usageContext) return;
  usageContext.onUsage(
    buildModelCallUsage({
      id: randomUUID(),
      category: usageContext.category,
      providerId: usageContext.providerId,
      model,
      inputText,
      outputText,
      exact,
      status,
    }),
  );
}

export function streamModelChat(input: ModelChatInput): AsyncGenerator<ModelStreamPart, void, void> {
  const inputText = serializeMessages(input.messages);
  if (input.protocol === "openai_responses") {
    const responsesInput: ResponsesInput = {
      apiBaseUrl: input.apiBaseUrl,
      apiUrlMode: input.apiUrlMode,
      apiKey: input.apiKey,
      model: input.model,
      protocol: input.protocol,
      reasoningEffort: input.reasoningEffort,
      messages: toResponsesMessages(input.messages),
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    };
    return wrapStreamUsage(streamOpenAIResponses(responsesInput), input, inputText);
  }

  return wrapStreamUsage(
    (async function* (): AsyncGenerator<LlmStreamPart, void, void> {
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
        yield part;
      }
    })(),
    input,
    inputText,
  );
}

/**
 * Wrap a model stream so the internal `usage` event is captured (not forwarded),
 * content/reasoning/source events are forwarded, and one ModelCallUsage is
 * reported on completion, failure, or abort.
 */
function wrapStreamUsage(
  source: AsyncGenerator<ModelStreamPart, void, void>,
  input: ModelChatInput,
  inputText: string,
): AsyncGenerator<ModelStreamPart, void, void> {
  return (async function* (): AsyncGenerator<ModelStreamPart, void, void> {
    let outputText = "";
    let exactUsage: ProviderTokenUsage | null = null;
    let reported = false;
    let status: ModelCallUsage["status"] = "completed";
    try {
      for await (const part of source) {
        if (part.type === "usage") {
          exactUsage = part.usage;
          continue; // never forward the internal usage event
        }
        if (part.type === "content" || part.type === "reasoning") {
          outputText += part.content;
        }
        yield part;
      }
    } catch (err) {
      status = input.signal?.aborted ? "interrupted" : "failed";
      throw err;
    } finally {
      if (!reported) {
        reported = true;
        reportUsage(
          input.usageContext,
          input.model,
          inputText,
          outputText,
          exactUsage,
          input.signal?.aborted ? "interrupted" : status,
        );
      }
    }
  })();
}

export async function callModelChat(input: ModelChatInput): Promise<string> {
  const inputText = serializeMessages(input.messages);
  try {
    let result: { content: string; usage: ProviderTokenUsage | null };
    if (input.protocol === "openai_responses") {
      result = await callOpenAIResponsesDetailed({
        apiBaseUrl: input.apiBaseUrl,
        apiUrlMode: input.apiUrlMode,
        apiKey: input.apiKey,
        model: input.model,
        protocol: input.protocol,
        reasoningEffort: input.reasoningEffort,
        messages: toResponsesMessages(input.messages),
        fetchImpl: input.fetchImpl,
        signal: input.signal,
      });
    } else {
      result = await callOpenAICompatibleChatDetailed({
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
    reportUsage(input.usageContext, input.model, inputText, result.content, result.usage, "completed");
    return result.content;
  } catch (err) {
    reportUsage(
      input.usageContext,
      input.model,
      inputText,
      "",
      null,
      input.signal?.aborted ? "interrupted" : "failed",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tool-aware model turn, consumed by the WebToolOrchestrator. Dispatches by
// protocol; tools are standard function definitions for both protocols.
// ---------------------------------------------------------------------------

export type ModelTurnInput = {
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
  usageContext?: ModelUsageContext;
};

export function streamModelTurn(input: ModelTurnInput): AsyncGenerator<ModelTurnEvent, void, void> {
  const inputText = serializeConversation(input.conversation);
  const base = input.protocol === "openai_responses" ? streamOpenAIResponsesTurn({
    apiBaseUrl: input.apiBaseUrl,
    apiUrlMode: input.apiUrlMode,
    apiKey: input.apiKey,
    model: input.model,
    protocol: input.protocol,
    reasoningEffort: input.reasoningEffort,
    conversation: input.conversation,
    tools: input.tools,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  }) : streamChatCompletionsTurn({
    apiBaseUrl: input.apiBaseUrl,
    apiUrlMode: input.apiUrlMode,
    apiKey: input.apiKey,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    conversation: input.conversation,
    tools: input.tools,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });

  return wrapTurnUsage(base, input, inputText);
}

function wrapTurnUsage(
  source: AsyncGenerator<ModelTurnEvent, void, void>,
  input: ModelTurnInput,
  inputText: string,
): AsyncGenerator<ModelTurnEvent, void, void> {
  return (async function* (): AsyncGenerator<ModelTurnEvent, void, void> {
    let outputText = "";
    let exactUsage: ProviderTokenUsage | null = null;
    let reported = false;
    let status: ModelCallUsage["status"] = "completed";
    try {
      for await (const part of source) {
        if (part.type === "usage") {
          exactUsage = part.usage;
          continue; // never forward the internal usage event
        }
        if (part.type === "content" || part.type === "reasoning") {
          outputText += part.delta;
        }
        yield part;
      }
    } catch (err) {
      status = input.signal?.aborted ? "interrupted" : "failed";
      throw err;
    } finally {
      if (!reported) {
        reported = true;
        reportUsage(
          input.usageContext,
          input.model,
          inputText,
          outputText,
          exactUsage,
          input.signal?.aborted ? "interrupted" : status,
        );
      }
    }
  })();
}