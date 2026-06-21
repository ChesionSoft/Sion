import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import {
  callOpenAIResponses,
  resolveResponsesUrl,
  streamOpenAIResponses,
} from "./openai-responses";

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
  it("sends the expected URL and body without web_search when disabled", async () => {
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
      webSearchEnabled: false,
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

  it("adds web_search tool when enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamingResponse([
        'data: {"type":"response.completed","response":{"output":[],"id":"r-1"}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    for await (const _ of streamOpenAIResponses({
      apiBaseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-5",
      protocol: "openai_responses",
      webSearchEnabled: true,
      messages: [{ role: "user", content: "q" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      void _;
    }

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { tools: unknown[] };
    expect(body.tools).toEqual([{ type: "web_search" }]);
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