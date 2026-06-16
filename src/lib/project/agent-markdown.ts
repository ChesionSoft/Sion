import { callOpenAICompatibleChat } from "./llm";
import type { ApiUrlMode, ReasoningEffort, WorkflowNodeId } from "./types";

export type GenerateUpdatedNodeMarkdownInput = {
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  nodeId: WorkflowNodeId;
  currentMarkdown: string;
  contextMarkdown: string;
  userMessage: string;
  assistantContent: string;
  fetchImpl?: typeof fetch;
};

export async function generateUpdatedNodeMarkdown(input: GenerateUpdatedNodeMarkdownInput): Promise<string> {
  const raw = await callOpenAICompatibleChat({
    apiBaseUrl: input.apiBaseUrl,
    apiUrlMode: input.apiUrlMode,
    apiKey: input.apiKey,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    fetchImpl: input.fetchImpl,
    messages: [
      {
        role: "system",
        content: [
          "You update one workflow node Markdown document.",
          "Return only the complete updated Markdown for the current node.",
          "Do not wrap the Markdown in a code fence.",
          "Do not include other workflow nodes or chapters.",
          "Preserve useful existing content and the current node heading.",
          "Incorporate confirmed details from the latest user message and assistant response.",
          "Put assumptions in the current node's assumptions section.",
          "Put uncertain items in the current node's open questions section.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Current node id: ${input.nodeId}`,
          "",
          "## Current node Markdown",
          input.currentMarkdown,
          "",
          "## Read-only context from other nodes",
          input.contextMarkdown || "No other confirmed context.",
          "",
          "## Latest user message",
          input.userMessage,
          "",
          "## Latest assistant response",
          input.assistantContent,
        ].join("\n"),
      },
    ],
  });

  const markdown = stripWrapperFence(raw).trim();
  if (!markdown) {
    throw new Error("Updated Markdown is empty");
  }

  return markdown;
}

function stripWrapperFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1] : trimmed;
}
