import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import {
  callOpenAIResponses,
  callOpenAIResponsesDetailed,
  resolveResponsesUrl,
  streamOpenAIResponses,
  streamOpenAIResponsesTurn,
} from "./openai-responses";
import { toolDefinitions, type ModelConversationItem } from "./model-tools";

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

describe("resolveResponsesUrl", () => {
  it("appends /v1/responses in base mode", () => {
    expect(resolveResponsesUrl("https://api.openai.com", "base")).toBe("https://api.openai.com/v1/responses");
  });

  it("strips a trailing /v1 in base mode before appending /v1/responses", () => {
    expect(resolveResponsesUrl("https://api.openai.com/v1", "base")).toBe("https://api.openai.com/v1/responses");
  });

  it("returns the url unchanged in full mode", () => {
    expect(resolveResponsesUrl("https://api.openai.com/v1/responses", "full")).toBe(
      "https://api.openai.com/v1/responses",
    );
  });
});

describe("streamOpenAIResponses", () => {
  it("sends the expected URL and body without any hosted search tool", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"type":"response.completed","response":{"output":[],"id":"r-1"}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const parts: unknown[] = [];
    for await (const part of streamOpenAIResponses({
      apiBaseUrl: "https://api.openai.com",
      apiUrlMode: "base",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      reasoningEffort: "medium",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "question" },
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      parts.push(part);
    }

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5",
      input: [
        { role: "system", content: [{ type: "input_text", text: "rules" }] },
        { role: "user", content: [{ type: "input_text", text: "question" }] },
      ],
      reasoning: { effort: "medium", summary: "auto" },
      stream: true,
    });
    expect(body.tools).toBeUndefined();
  });

  it("parses text and reasoning-summary deltas split across chunks", async () => {
    // Split a JSON line across two chunks to test buffer handling.
    const line1 = 'data: {"type":"response.reasoning_summary_text.delta","delta":"分析';
    const line2 = '"}\n\n';
    const line3 = 'data: {"type":"response.output_text.delta","delta":"结论"}\n\n';
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse([line1, line2 + line3, "data: [DONE]\n\n"]));

    const parts: { type: string; content: string }[] = [];
    for await (const part of streamOpenAIResponses({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      messages: [{ role: "user", content: "q" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      parts.push(part as { type: string; content: string });
    }

    expect(parts).toEqual([
      { type: "reasoning", content: "分析" },
      { type: "content", content: "结论" },
    ]);
  });

  it("emits source events from annotation.added and dedupes by url", async () => {
    const events = [
      'data: {"type":"response.output_text.annotation.added","item_id":"i-1","output_index":0,"annotation":{"type":"url_citation","url":"https://example.com/","title":"Example"}}\n\n',
      'data: {"type":"response.output_text.annotation.added","item_id":"i-1","output_index":0,"annotation":{"type":"url_citation","url":"https://example.com/","title":"Example"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"r-1","output":[{"id":"i-1","type":"message","content":[{"type":"output_text","text":"结论","annotations":[{"type":"url_citation","url":"https://example.com/","title":"Example"}]}]}]}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(events));

    const parts: { type: string; source?: { url: string; kind: string } }[] = [];
    for await (const part of streamOpenAIResponses({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      messages: [{ role: "user", content: "q" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      parts.push(part as { type: string; source?: { url: string; kind: string } });
    }

    const sources = parts.filter((p) => p.type === "source");
    expect(sources).toHaveLength(1);
    expect(sources[0].source).toMatchObject({ kind: "web_search", url: "https://example.com/" });
  });

  it("throws on non-2xx responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" } as Response);
    await expect(async () => {
      for await (const _ of streamOpenAIResponses({
        apiBaseUrl: "https://api.openai.com",
        apiKey: "bad",
        model: "gpt-5",
        protocol: "openai_responses",
        messages: [{ role: "user", content: "q" }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })) {
        void _;
      }
    }).rejects.toThrow();
  });

  it("throws on a terminal Responses error event", async () => {
    const events = [
      'data: {"type":"error","message":"rate limited"}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(events));
    await expect(async () => {
      for await (const _ of streamOpenAIResponses({
        apiBaseUrl: "https://api.openai.com",
        apiKey: "sk-test",
        model: "gpt-5",
        protocol: "openai_responses",
        messages: [{ role: "user", content: "q" }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })) {
        void _;
      }
    }).rejects.toThrow("rate limited");
  });

  it("throws when the Responses stream ends with response.failed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse([
      'data: {"type":"response.failed","response":{"error":{"message":"quota exceeded"}}}\n\n',
    ]));

    await expect(async () => {
      for await (const _ of streamOpenAIResponses({
        apiBaseUrl: "https://api.openai.com",
        apiKey: "sk-test",
        model: "gpt-5",
        protocol: "openai_responses",
        messages: [{ role: "user", content: "q" }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })) {
        void _;
      }
    }).rejects.toThrow("quota exceeded");
  });

  it("throws when the Responses stream ends incomplete", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse([
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    ]));

    await expect(async () => {
      for await (const _ of streamOpenAIResponses({
        apiBaseUrl: "https://api.openai.com",
        apiKey: "sk-test",
        model: "gpt-5",
        protocol: "openai_responses",
        messages: [{ role: "user", content: "q" }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })) {
        void _;
      }
    }).rejects.toThrow("max_output_tokens");
  });
});

describe("streamOpenAIResponses usage", () => {
  it("emits exact usage from the response.completed event", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"type":"response.output_text.delta","delta":"ans"}\n\n',
        'data: {"type":"response.completed","response":{"id":"r-1","output":[],"usage":{"input_tokens":21,"output_tokens":9,"total_tokens":30}}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const parts: { type: string }[] = [];
    for await (const part of streamOpenAIResponses({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      messages: [{ role: "user", content: "q" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      parts.push(part as { type: string });
    }

    expect(parts.at(-1)).toEqual({
      type: "usage",
      usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
    });
  });
});

describe("callOpenAIResponsesDetailed", () => {
  it("returns content and exact usage from a non-stream response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "r-1",
          output: [
            { id: "i-1", type: "message", content: [{ type: "output_text", text: "最终答案" }] },
          ],
          usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 },
        }),
        { status: 200 },
      ),
    );

    const result = await callOpenAIResponsesDetailed({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      messages: [{ role: "user", content: "q" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      content: "最终答案",
      usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
    });
  });

  it("returns null usage when the provider omits it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "r-1",
          output: [{ id: "i-1", type: "message", content: [{ type: "output_text", text: "ok" }] }],
        }),
        { status: 200 },
      ),
    );

    const result = await callOpenAIResponsesDetailed({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      messages: [{ role: "user", content: "q" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ content: "ok", usage: null });
  });
});

describe("callOpenAIResponses", () => {
  it("returns the final output text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "r-1",
          output: [
            {
              id: "i-1",
              type: "message",
              content: [{ type: "output_text", text: "最终答案" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const text = await callOpenAIResponses({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      messages: [{ role: "user", content: "q" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(text).toBe("最终答案");
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      callOpenAIResponses({
        apiBaseUrl: "https://api.openai.com",
        apiKey: "sk-test",
        model: "gpt-5",
        protocol: "openai_responses",
        messages: [{ role: "user", content: "q" }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });
});

describe("streamOpenAIResponsesTurn", () => {
  it("serializes function tools, prior function_call, and function_call_output; never web_search", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse(['data: [DONE]\n\n']),
    );
    const conversation: ModelConversationItem[] = [
      { type: "message", role: "user", content: "search it" },
      { type: "tool_call", call: { id: "call_1", name: "web_search", argumentsJson: '{"query":"x"}' } },
      { type: "tool_result", callId: "call_1", name: "web_search", output: '{"ok":true}' },
    ];

    for await (const _ of streamOpenAIResponsesTurn({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      conversation,
      tools: toolDefinitions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      void _;
    }

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { tools: unknown[]; input: unknown[] };
    expect(body.tools).toEqual([
      expect.objectContaining({ type: "function", name: "web_search" }),
      expect.objectContaining({ type: "function", name: "web_fetch" }),
    ]);
    expect(JSON.stringify(body.tools)).not.toContain("web_search\"}]"); // no hosted {type:"web_search"} tool
    // prior function_call
    expect(body.input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "call_1", name: "web_search", arguments: '{"query":"x"}' }),
    );
    // result
    expect(body.input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: '{"ok":true}' }),
    );
  });

  it("parses a function_call item and arguments delta into a tool_call event", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"type":"response.output_text.delta","delta":"ans"}\n\n',
        'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"web_search","arguments":""}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"quer"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"y\\":\\"hi\\"}"}\n\n',
        'data: {"type":"response.completed","response":{"output":[]}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events: { type: string }[] = [];
    for await (const e of streamOpenAIResponsesTurn({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      conversation: [{ type: "message", role: "user", content: "q" }],
      tools: toolDefinitions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      events.push(e as { type: string });
    }
    expect(events).toEqual([
      { type: "content", delta: "ans" } as unknown as { type: string },
      { type: "tool_call", call: { id: "call_1", name: "web_search", argumentsJson: '{"query":"hi"}' } } as unknown as { type: string },
    ]);
  });

  it("handles multiple function calls in one turn", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"c1","name":"web_search","arguments":"{\\"query\\":\\"a\\"}"}}\n\n',
        'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"c2","name":"web_fetch","arguments":"{\\"url\\":\\"https://x.com\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"output":[]}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const calls: string[] = [];
    for await (const e of streamOpenAIResponsesTurn({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      conversation: [{ type: "message", role: "user", content: "q" }],
      tools: toolDefinitions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      if (e.type === "tool_call") calls.push(e.call.id);
    }
    expect(calls).toEqual(["c1", "c2"]);
  });

  it("throws on response.failed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse(['data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n']),
    );
    await expect(async () => {
      for await (const _ of streamOpenAIResponsesTurn({
        apiBaseUrl: "https://api.openai.com",
        apiKey: "sk-test",
        model: "gpt-5",
        protocol: "openai_responses",
        conversation: [{ type: "message", role: "user", content: "q" }],
        tools: toolDefinitions,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })) {
        void _;
      }
    }).rejects.toThrow("boom");
  });

  it("skips malformed SSE chunks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: not-json\n\n',
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events: { type: string }[] = [];
    for await (const e of streamOpenAIResponsesTurn({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      conversation: [{ type: "message", role: "user", content: "q" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      events.push(e as { type: string });
    }
    expect(events).toEqual([{ type: "content", delta: "ok" } as unknown as { type: string }]);
  });
});
