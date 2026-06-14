export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CallOpenAICompatibleChatInput = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  fetchImpl?: typeof fetch;
};

export async function callOpenAICompatibleChat(input: CallOpenAICompatibleChatInput): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.apiBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
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
