import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import { callModelChat, streamModelChat, streamModelTurn, type ModelUsageContext } from "./model-chat";
import { toolDefinitions } from "./model-tools";
import type { ModelCallUsage } from "./types";

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

describe("usage tracking", () => {
  function usageContext(onUsage: (u: ModelCallUsage) => void): ModelUsageContext {
    return { turnId: "t1", category: "answer", providerId: "p1", onUsage };
  }

  it("reports exact usage from the adapter usage event and forwards only content/reasoning", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ans"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const calls: ModelCallUsage[] = [];
    const parts: { type: string }[] = [];
    for await (const part of streamModelChat({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      protocol: "chat_completions",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      usageContext: usageContext((u) => calls.push(u)),
    })) {
      parts.push(part as { type: string });
    }

    // The internal usage event is never forwarded to consumers.
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "content"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: "exact",
      category: "answer",
      providerId: "p1",
      model: "m",
      status: "completed",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("falls back to estimation when no usage event arrives", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"结果"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const calls: ModelCallUsage[] = [];
    for await (const _ of streamModelChat({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      protocol: "chat_completions",
      messages: [{ role: "user", content: "你好" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      usageContext: usageContext((u) => calls.push(u)),
    })) {
      void _;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("estimated");
    expect(calls[0].outputTokens).toBeGreaterThan(0);
    expect(calls[0].status).toBe("completed");
  });

  it("reports interrupted status on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("aborted"));

    const calls: ModelCallUsage[] = [];
    try {
      for await (const _ of streamModelChat({
        apiBaseUrl: "https://api.example.com/v1",
        apiKey: "k",
        model: "m",
        protocol: "chat_completions",
        messages: [{ role: "user", content: "hi" }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signal: controller.signal,
        usageContext: usageContext((u) => calls.push(u)),
      })) {
        void _;
      }
    } catch {
      // expected — the aborted request propagates
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe("interrupted");
  });

  it("reports failed status when the provider throws without abort", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));

    const calls: ModelCallUsage[] = [];
    try {
      for await (const _ of streamModelChat({
        apiBaseUrl: "https://api.example.com/v1",
        apiKey: "k",
        model: "m",
        protocol: "chat_completions",
        messages: [{ role: "user", content: "hi" }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
        usageContext: usageContext((u) => calls.push(u)),
      })) {
        void _;
      }
    } catch {
      // expected
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe("failed");
  });

  it("callModelChat reports usage once for a non-stream request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        }),
        { status: 200 },
      ),
    );

    const calls: ModelCallUsage[] = [];
    const text = await callModelChat({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      protocol: "chat_completions",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      usageContext: usageContext((u) => calls.push(u)),
    });

    expect(text).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ source: "exact", inputTokens: 7, outputTokens: 2 });
  });

  it("streamModelTurn reports usage and forwards content/tool_call without the usage event", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"ans"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const calls: ModelCallUsage[] = [];
    const events: { type: string }[] = [];
    for await (const e of streamModelTurn({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      protocol: "chat_completions",
      conversation: [{ type: "message", role: "user", content: "hi" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      usageContext: { turnId: "t1", category: "tool_planning", providerId: "p1", onUsage: (u) => calls.push(u) },
    })) {
      events.push(e as { type: string });
    }

    expect(events.map((e) => e.type)).toEqual(["content"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ category: "tool_planning", source: "exact" });
  });
});