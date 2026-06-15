import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import { callOpenAICompatibleChat, streamOpenAICompatibleChat } from "./llm";

describe("callOpenAICompatibleChat", () => {
  it("sends OpenAI-compatible chat completions request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "已更新功能设计。" } }],
      }),
    });

    const content = await callOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "example-chat",
      reasoningEffort: "high",
      messages: [
        { role: "system", content: "系统提示" },
        { role: "user", content: "生成文档" },
      ],
    });

    expect(content).toBe("已更新功能设计。");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          model: "example-chat",
          messages: [
            { role: "system", content: "系统提示" },
            { role: "user", content: "生成文档" },
          ],
          reasoning_effort: "high",
          temperature: 0.2,
        }),
      }),
    );
  });
});

function createMockStreamBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("streamOpenAICompatibleChat", () => {
  it("yields content parts from streaming LLM response", async () => {
    const mockBody = createMockStreamBody([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const parts = [];
    for await (const part of streamOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "example-chat",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      parts.push(part);
    }

    expect(parts).toEqual([
      { type: "content", content: "Hello" },
      { type: "content", content: " world" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        body: JSON.stringify({
          model: "example-chat",
          messages: [{ role: "user", content: "Hi" }],
          temperature: 0.2,
          stream: true,
        }),
      }),
    );
  });

  it("yields reasoning parts separately from answer content", async () => {
    const mockBody = createMockStreamBody([
      'data: {"choices":[{"delta":{"reasoning_content":"先分析需求。"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"最终输出。"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const parts = [];
    for await (const part of streamOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "example-chat",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      parts.push(part);
    }

    expect(parts).toEqual([
      { type: "reasoning", content: "先分析需求。" },
      { type: "content", content: "最终输出。" },
    ]);
  });

  it("throws on non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const gen = streamOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "bad",
      model: "example-chat",
      messages: [{ role: "user", content: "Hi" }],
    });

    await expect(gen.next()).rejects.toThrow("LLM request failed with status 401");
  });

  it("skips malformed SSE chunks", async () => {
    const mockBody = createMockStreamBody([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: not-json\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const parts = [];
    for await (const part of streamOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "example-chat",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      parts.push(part);
    }

    expect(parts).toEqual([
      { type: "content", content: "ok" },
      { type: "content", content: "!" },
    ]);
  });
});
