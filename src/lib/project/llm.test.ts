import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import {
  callOpenAICompatibleChat,
  callOpenAICompatibleChatDetailed,
  resolveChatCompletionsUrl,
  streamChatCompletionsTurn,
  streamOpenAICompatibleChat,
} from "./llm";
import { toolDefinitions, type ModelConversationItem } from "./model-tools";

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

  it("uses the configured URL directly in full API URL mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://proxy.example.com/openai/chat/completions",
      apiUrlMode: "full",
      apiKey: "secret",
      model: "example-chat",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example.com/openai/chat/completions",
      expect.any(Object),
    );
  });

  it("forwards an abort signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    const controller = new AbortController();

    await callOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(init?.signal).toBe(controller.signal);
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
          stream_options: { include_usage: true },
        }),
      }),
    );
  });

  it("streams from the configured URL directly in full API URL mode", async () => {
    const mockBody = createMockStreamBody([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const parts = [];
    for await (const part of streamOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://proxy.example.com/openai/chat/completions",
      apiUrlMode: "full",
      apiKey: "secret",
      model: "example-chat",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      parts.push(part);
    }

    expect(parts).toEqual([{ type: "content", content: "ok" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example.com/openai/chat/completions",
      expect.objectContaining({
        body: JSON.stringify({
          model: "example-chat",
          messages: [{ role: "user", content: "Hi" }],
          temperature: 0.2,
          stream: true,
          stream_options: { include_usage: true },
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

  it("emits exact usage from the final streaming chunk", async () => {
    const mockBody = createMockStreamBody([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: mockBody });

    const parts: { type: string }[] = [];
    for await (const part of streamOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      parts.push(part);
    }

    expect(parts.at(-1)).toEqual({
      type: "usage",
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    });
  });

  it("includes stream_options.include_usage in streaming requests", async () => {
    const mockBody = createMockStreamBody(['data: [DONE]\n\n']);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: mockBody });

    for await (const _ of streamOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      void _;
    }

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ stream_options: { include_usage: true } });
  });

  it("retries once without stream_options on a 400 mentioning stream_options", async () => {
    const errBody = JSON.stringify({ error: { message: "stream_options not supported" } });
    const okBody = createMockStreamBody(['data: [DONE]\n\n']);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => errBody })
      .mockResolvedValueOnce({ ok: true, body: okBody });

    for await (const _ of streamOpenAICompatibleChat({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      void _;
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1] as [string, { body: string }])[1].body,
    );
    expect(secondBody).not.toHaveProperty("stream_options");
  });
});

describe("callOpenAICompatibleChatDetailed", () => {
  it("returns content and exact usage from a non-stream response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "已更新。" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    });

    const result = await callOpenAICompatibleChatDetailed({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result).toEqual({
      content: "已更新。",
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    });
  });

  it("returns null usage when the provider omits it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    const result = await callOpenAICompatibleChatDetailed({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result).toEqual({ content: "ok", usage: null });
  });
});

describe("resolveChatCompletionsUrl", () => {
  it("appends /v1/chat/completions to a bare base url", () => {
    expect(resolveChatCompletionsUrl("https://api.example.com")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("does not double /v1 when the base url already ends with /v1", () => {
    expect(resolveChatCompletionsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("strips a trailing slash before /v1", () => {
    expect(resolveChatCompletionsUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("returns the url as-is in full mode", () => {
    expect(
      resolveChatCompletionsUrl("https://proxy.example.com/openai/chat/completions", "full"),
    ).toBe("https://proxy.example.com/openai/chat/completions");
  });
});

describe("streamChatCompletionsTurn", () => {
  it("sends tools, tool_choice auto, assistant tool_calls, and tool results", async () => {
    const mockBody = createMockStreamBody(['data: [DONE]\n\n']);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: mockBody });

    const conversation: ModelConversationItem[] = [
      { type: "message", role: "system", content: "sys" },
      { type: "message", role: "user", content: "search it" },
      { type: "tool_call", call: { id: "call_1", name: "web_search", argumentsJson: '{"query":"x"}' } },
      { type: "tool_result", callId: "call_1", name: "web_search", output: '{"ok":true,"results":[]}' },
    ];

    for await (const _part of streamChatCompletionsTurn({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      conversation,
      tools: toolDefinitions,
    })) {
      void _part;
    }

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "web_search",
          description: expect.any(String),
          parameters: expect.any(Object),
        },
      },
      {
        type: "function",
        function: {
          name: "web_fetch",
          description: expect.any(String),
          parameters: expect.any(Object),
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    // assistant tool_call becomes assistant.tool_calls
    const assistant = body.messages.find(
      (m: { role: string; tool_calls?: unknown }) => m.role === "assistant" && m.tool_calls,
    );
    expect(assistant.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } },
    ]);
    // tool_result becomes role: tool with tool_call_id
    const toolMsg = body.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"ok":true,"results":[]}',
    });
  });

  it("leaves the request body structurally unchanged when no tools are provided", async () => {
    const mockBody = createMockStreamBody(['data: [DONE]\n\n']);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: mockBody });

    for await (const _part of streamChatCompletionsTurn({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      conversation: [{ type: "message", role: "user", content: "Hi" }],
    })) {
      void _part;
    }

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("retries once without stream_options on a 400 mentioning stream_options", async () => {
    const errBody = JSON.stringify({ error: { message: "stream_options not supported" } });
    const okBody = createMockStreamBody(['data: [DONE]\n\n']);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => errBody })
      .mockResolvedValueOnce({ ok: true, body: okBody });

    for await (const _part of streamChatCompletionsTurn({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      conversation: [{ type: "message", role: "user", content: "Hi" }],
      tools: toolDefinitions,
    })) {
      void _part;
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body);
    expect(firstBody).toMatchObject({ stream_options: { include_usage: true } });
    expect(secondBody).not.toHaveProperty("stream_options");
    expect(secondBody.tools).toEqual(firstBody.tools);
  });

  it("assembles interleaved tool_call fragments by index into complete calls", async () => {
    const mockBody = createMockStreamBody([
      'data: {"choices":[{"delta":{"content":"ans"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"quer"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"y\\":\\"hi\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"web_fetch","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"url\\":\\"https://x.com\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: mockBody });

    const events = [];
    for await (const e of streamChatCompletionsTurn({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      conversation: [{ type: "message", role: "user", content: "Hi" }],
      tools: toolDefinitions,
    })) {
      events.push(e);
    }

    expect(events).toEqual([
      { type: "content", delta: "ans" },
      { type: "tool_call", call: { id: "call_1", name: "web_search", argumentsJson: '{"query":"hi"}' } },
      { type: "tool_call", call: { id: "call_2", name: "web_fetch", argumentsJson: '{"url":"https://x.com"}' } },
    ]);
  });

  it("preserves reasoning deltas alongside content", async () => {
    const mockBody = createMockStreamBody([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ans"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: mockBody });
    const events = [];
    for await (const e of streamChatCompletionsTurn({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      conversation: [{ type: "message", role: "user", content: "Hi" }],
    })) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "reasoning", delta: "thinking" },
      { type: "content", delta: "ans" },
    ]);
  });

  it("throws a protocol error for an incomplete tool call (missing id)", async () => {
    const mockBody = createMockStreamBody([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"web_search","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: mockBody });
    const gen = streamChatCompletionsTurn({
      fetchImpl: fetchMock,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "m",
      conversation: [{ type: "message", role: "user", content: "Hi" }],
      tools: toolDefinitions,
    });
    await expect(gen.next()).rejects.toThrow();
  });
});
