import { describe, expect, it, vi } from "vitest";
import { judgeNodeFacts } from "./node-fact-judge";
import type { ModelCallUsage } from "./types";

const BASE_INPUT = {
  apiBaseUrl: "https://api.example.com",
  apiKey: "test-key",
  model: "test-model",
  nodeId: "basic-info" as const,
  userMessage: "需要客户管理功能",
  assistantContent: "好的，已添加客户管理功能。",
};

function makeFetchImpl(content: string) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200 },
    ),
  );
}

describe("judgeNodeFacts", () => {
  it("returns valid confirmed_fact change", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 客户管理",
            evidence: { source: "user", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(1);
    expect(result.decision.changes[0].category).toBe("confirmed_fact");
    expect(result.decision.changes[0].targetSectionKey).toBe("confirmed");
  });

  it("drops invalid change without affecting valid ones", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "nope",
            patchKind: "append_bullet",
            markdown: "- 客户管理",
            evidence: { source: "user", quote: "需要客户管理" },
          },
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 客户管理",
            evidence: { source: "user", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(1);
    expect(result.decision.changes[0].targetSectionKey).toBe("confirmed");
  });

  it("drops change with unknown section key", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "nope",
            patchKind: "append_bullet",
            markdown: "- 客户管理",
            evidence: { source: "user", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(0);
  });

  it("drops change with invalid patchKind for section", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "assumptions",
            patchKind: "append_table_row",
            markdown: "- 客户管理",
            evidence: { source: "user", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(0);
  });

  it("downgrades confirmed_fact when quote is not a user message substring", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 客户管理",
            evidence: { source: "user", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({
      ...BASE_INPUT,
      userMessage: "需要订单管理",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(1);
    expect(result.decision.changes[0].category).toBe("assumption");
    expect(result.decision.changes[0].targetSectionKey).toBe("assumptions");
  });

  it("downgrades confirmed_fact with assistant source to assumption", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 客户管理",
            evidence: { source: "assistant", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(1);
    expect(result.decision.changes[0].category).toBe("assumption");
    expect(result.decision.changes[0].targetSectionKey).toBe("assumptions");
  });

  it("forces assumption to assumptions section", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "assumption",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 客户管理",
            evidence: { source: "assistant", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(1);
    expect(result.decision.changes[0].targetSectionKey).toBe("assumptions");
  });

  it("forces open_question to open_questions section", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "open_question",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 客户管理",
            evidence: { source: "assistant", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(1);
    expect(result.decision.changes[0].targetSectionKey).toBe("open_questions");
  });

  it("returns ok:false for non-JSON response", async () => {
    const fetchImpl = makeFetchImpl("this is not json");

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("network error");
  });

  it("returns ok:true with empty changes for empty changes array", async () => {
    const fetchImpl = makeFetchImpl(JSON.stringify({ changes: [] }));

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
  });

  it("drops change with heading in markdown", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "## sub\n- foo",
            evidence: { source: "user", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(0);
  });

  it("reports fact_judge usage into the supplied turn", async () => {
    const fetchImpl = makeFetchImpl(JSON.stringify({ changes: [] }));
    const calls: ModelCallUsage[] = [];
    await judgeNodeFacts({
      ...BASE_INPUT,
      fetchImpl,
      turnId: "t1",
      providerId: "p1",
      onUsage: (u) => calls.push(u),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ category: "fact_judge", providerId: "p1" });
  });

  it("uses low reasoning effort", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ changes: [] }) } }],
        }),
        { status: 200 },
      ),
    );

    await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });

    const callBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    );
    expect(callBody.reasoning_effort).toBe("low");
  });

  it("sends the assistant response and table column contract to the judge", async () => {
    const fetchImpl = makeFetchImpl(JSON.stringify({ changes: [] }));

    await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });

    const callBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as { messages: Array<{ role: string; content: string }> };
    const prompt = callBody.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain(BASE_INPUT.assistantContent);
    expect(prompt).toContain("tableColumns");
    expect(prompt).toContain("字段");
    expect(prompt).toContain("值");
  });

  it("parses JSON inside ```json fence", async () => {
    const fetchImpl = makeFetchImpl("```json\n{\"changes\":[]}\n```");

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
  });

  it("parses JSON wrapped in prose without a fence", async () => {
    // Reasoning models (e.g. minimax m3 via Ollama) often prepend a sentence
    // before the JSON and never use a code fence. The judge must still recover
    // the JSON object instead of erroring "judge response was not valid JSON".
    const fetchImpl = makeFetchImpl(
      "基于以上分析，未发现需要记录的事实，结果如下：\n{\"changes\":[]}\n以上。",
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
  });

  it("parses JSON after inline thinking tags", async () => {
    const fetchImpl = makeFetchImpl("<think>我先分析一下用户消息</think>\n{\"changes\":[]}");

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
  });

  it("accepts valid external assumptions", async () => {
    const source = {
      id: "src-1",
      kind: "provided_url" as const,
      url: "https://example.com/",
      title: "Example",
      domain: "example.com",
      snippet: "片段",
      retrievedAt: "2026-06-21T00:00:00.000Z",
    };
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "assumption",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 来自外部",
            evidence: { source: "external", sourceId: "src-1", quote: "片段" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl, externalSources: [source] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toHaveLength(1);
    expect(result.decision.changes[0].category).toBe("assumption");
    expect(result.decision.changes[0].targetSectionKey).toBe("assumptions");
  });

  it("downgrades externally sourced confirmed facts to assumptions", async () => {
    const source = {
      id: "src-1",
      kind: "provided_url" as const,
      url: "https://example.com/",
      title: "Example",
      domain: "example.com",
      snippet: "片段",
      retrievedAt: "2026-06-21T00:00:00.000Z",
    };
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 来自外部的结论",
            evidence: { source: "external", sourceId: "src-1", quote: "外部结论" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl, externalSources: [source] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes[0]).toMatchObject({
      category: "assumption",
      targetSectionKey: "assumptions",
    });
  });

  it("drops external evidence with an unknown source id", async () => {
    const source = {
      id: "src-1",
      kind: "provided_url" as const,
      url: "https://example.com/",
      title: "Example",
      domain: "example.com",
      snippet: "片段",
      retrievedAt: "2026-06-21T00:00:00.000Z",
    };
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 伪造来源",
            evidence: { source: "external", sourceId: "missing", quote: "外部结论" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl, externalSources: [source] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
  });

  it("later user confirmation of an external fact remains valid user evidence", async () => {
    const source = {
      id: "src-1",
      kind: "provided_url" as const,
      url: "https://example.com/",
      title: "Example",
      domain: "example.com",
      snippet: "片段",
      retrievedAt: "2026-06-21T00:00:00.000Z",
    };
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 客户确认采用 A 方案",
            evidence: { source: "user", quote: "我们采用 A 方案" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({
      ...BASE_INPUT,
      userMessage: "我们采用 A 方案",
      fetchImpl,
      externalSources: [source],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes[0].category).toBe("confirmed_fact");
    expect(result.decision.changes[0].targetSectionKey).toBe("confirmed");
  });
});

describe("judgeNodeFacts/browser source fact rules", () => {
  const browserSource = {
    id: "bw-1",
    kind: "web_search" as const,
    url: "https://example.com/article",
    title: "Article",
    domain: "example.com",
    snippet: "据文章称",
    retrievedAt: "2026-06-21T00:00:00.000Z",
  };

  it("a browser-sourced confirmed_fact is downgraded to an assumption", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 据文章的结论",
            evidence: { source: "external", sourceId: "bw-1", quote: "据文章称" },
          },
        ],
      }),
    );
    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl, externalSources: [browserSource] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes[0]).toMatchObject({ category: "assumption", targetSectionKey: "assumptions" });
  });

  it("a browser-sourced open_question stays an open_question and preserves the source id", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "open_question",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 文章的说法是否适用于本项目？",
            evidence: { source: "external", sourceId: "bw-1", quote: "据文章称" },
          },
        ],
      }),
    );
    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl, externalSources: [browserSource] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patch = result.decision.changes[0];
    expect(patch.category).toBe("open_question");
    expect(patch.targetSectionKey).toBe("open_questions");
    expect(patch.evidence.source).toBe("external");
    if (patch.evidence.source === "external") {
      expect(patch.evidence.sourceId).toBe("bw-1");
    }
  });

  it("browser sources can never yield a confirmed_fact; confirmed_fact still requires explicit user evidence", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          // assistant-sourced confirmed_fact -> downgraded to assumption
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 助手推断",
            evidence: { source: "assistant", quote: "推断" },
          },
          // browser-sourced confirmed_fact -> downgraded to assumption
          {
            category: "confirmed_fact",
            targetSectionKey: "confirmed",
            patchKind: "append_bullet",
            markdown: "- 浏览器结论",
            evidence: { source: "external", sourceId: "bw-1", quote: "据文章称" },
          },
        ],
      }),
    );
    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl, externalSources: [browserSource] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const patch of result.decision.changes) {
      expect(patch.category).not.toBe("confirmed_fact");
    }
  });
});
