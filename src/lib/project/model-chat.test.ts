import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import { callModelChat, streamModelChat, streamModelTurn } from "./model-chat";
import { toolDefinitions } from "./model-tools";

function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe("streamModelChat", () => {
  it("routes chat_completions through the compatible adapter and produces no source parts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const parts: { type: string }[] = [];
    for await (const part of streamModelChat({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o",
      protocol: "chat_completions",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      parts.push(part as { type: string });
    }

    expect(parts.map((p) => p.type)).toEqual(["content"]);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
  });

  it("routes openai_responses through the Responses adapter", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const parts: { type: string }[] = [];
    for await (const part of streamModelChat({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      webSearchEnabled: false,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      parts.push(part as { type: string });
    }

    expect(parts.map((p) => p.type)).toEqual(["content"]);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/responses");
  });
});

describe("callModelChat", () => {
  it("routes chat_completions through callOpenAICompatibleChat", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
    );

    const text = await callModelChat({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o",
      protocol: "chat_completions",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(text).toBe("ok");
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
  });

  it("routes openai_responses through callOpenAIResponses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "r",
          output: [{ id: "i", type: "message", content: [{ type: "output_text", text: "resp" }] }],
        }),
        { status: 200 },
      ),
    );

    const text = await callModelChat({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(text).toBe("resp");
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/responses");
  });
});

describe("streamModelTurn", () => {
  it("routes chat_completions with tools through the tool-aware turn", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"ans"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const events: { type: string }[] = [];
    for await (const e of streamModelTurn({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o",
      protocol: "chat_completions",
      conversation: [{ type: "message", role: "user", content: "hi" }],
      tools: toolDefinitions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      events.push(e as { type: string });
    }

    expect(events.map((e) => e.type)).toEqual(["content"]);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.tools).toHaveLength(2);
    expect(body.tool_choice).toBe("auto");
  });
});