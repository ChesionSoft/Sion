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
            targetSectionKey: "boundary",
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
    expect(result.decision.changes[0].targetSectionKey).toBe("boundary");
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
            targetSectionKey: "boundary",
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
    expect(result.decision.changes[0].targetSectionKey).toBe("boundary");
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
    // metadata only allows append_table_row; append_bullet must be rejected.
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "metadata",
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

  it("keeps confirmed_fact in the model's chosen content section when quote matches", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "metadata",
            patchKind: "append_table_row",
            markdown: "| 项目名称 | 客户管理系统 |",
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
    expect(result.decision.changes[0].targetSectionKey).toBe("metadata");
  });

  it("downgrades confirmed_fact to assumption (kept in content section) when quote is not a user message substring", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "boundary",
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
    // assumption keeps the model's chosen content section — no separate bucket.
    expect(result.decision.changes[0].targetSectionKey).toBe("boundary");
  });

  it("downgrades confirmed_fact with assistant source to assumption kept in content section", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "boundary",
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
    expect(result.decision.changes[0].targetSectionKey).toBe("boundary");
  });

  it("keeps assumption in the model's chosen content section", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "assumption",
            targetSectionKey: "boundary",
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
    expect(result.decision.changes[0].targetSectionKey).toBe("boundary");
  });

  it("drops open_question changes — questions belong in chat, not the document", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "open_question",
            targetSectionKey: "boundary",
            patchKind: "append_bullet",
            markdown: "- 是否需要扫码入库？",
            evidence: { source: "assistant", quote: "需要客户管理" },
          },
        ],
      }),
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
  });

  it("returns ok:true with empty changes for prose with no JSON", async () => {
    // A prose reply with no JSON object means the model concluded there is
    // nothing to record. Treat it as "no changes" instead of erroring.
    const fetchImpl = makeFetchImpl("this is not json");

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
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
            targetSectionKey: "boundary",
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

  it("uses medium reasoning effort", async () => {
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
    expect(callBody.reasoning_effort).toBe("medium");
  });

  it("includes the current node markdown in the judge prompt", async () => {
    const fetchImpl = makeFetchImpl(JSON.stringify({ changes: [] }));
    await judgeNodeFacts({
      ...BASE_INPUT,
      currentMarkdown: "# 项目基本信息\n\n## 项目边界\n\n已有：客户管理",
      fetchImpl,
    });
    const callBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as { messages: Array<{ role: string; content: string }> };
    const prompt = callBody.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("已有：客户管理");
    expect(prompt).toContain("当前节点已有交付稿");
  });

  it("includes recent conversation history in the judge prompt", async () => {
    const fetchImpl = makeFetchImpl(JSON.stringify({ changes: [] }));
    await judgeNodeFacts({
      ...BASE_INPUT,
      recentMessages: [
        { role: "user", content: "上轮聊了订单管理" },
        { role: "assistant", content: "好的，已记录订单管理。" },
      ],
      fetchImpl,
    });
    const callBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as { messages: Array<{ role: string; content: string }> };
    const prompt = callBody.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("上轮聊了订单管理");
    expect(prompt).toContain("最近对话");
  });

  it("instructs the judge to skip facts already in the existing draft", async () => {
    const fetchImpl = makeFetchImpl(JSON.stringify({ changes: [] }));
    await judgeNodeFacts({ ...BASE_INPUT, currentMarkdown: "已有内容", fetchImpl });
    const callBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as { messages: Array<{ role: string; content: string }> };
    const prompt = callBody.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("尚未在上方已有交付稿中体现");
  });

  it("slices recent messages to the last 10", async () => {
    const fetchImpl = makeFetchImpl(JSON.stringify({ changes: [] }));
    const recent = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `历史消息 ${i}`,
    }));
    await judgeNodeFacts({ ...BASE_INPUT, recentMessages: recent, fetchImpl });
    const callBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as { messages: Array<{ role: string; content: string }> };
    const prompt = callBody.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("历史消息 5");
    expect(prompt).toContain("历史消息 14");
    expect(prompt).not.toContain("历史消息 0");
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

  it("tells the judge there is no confirmed/assumptions/open_questions section", async () => {
    const fetchImpl = makeFetchImpl(JSON.stringify({ changes: [] }));

    await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });

    const callBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as { messages: Array<{ role: string; content: string }> };
    const prompt = callBody.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("no \"confirmed\", \"assumptions\", or \"open_questions\" section");
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
    const fetchImpl = makeFetchImpl("我先分析一下用户消息\n{\"changes\":[]}");

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
  });

  it("returns empty changes when the judge replies with prose and no JSON", async () => {
    // Some models, when they conclude there is nothing to record, reply in
    // plain prose without any JSON object. Erroring here only surfaces a scary
    // warning to the user for no benefit — the document simply isn't updated,
    // same as {"changes":[]}. Treat unparseable prose as "no changes".
    const fetchImpl = makeFetchImpl(
      "根据用户消息和助手回复，没有需要记录的确认事实、假设或待确认问题，因此无需更新文档。",
    );

    const result = await judgeNodeFacts({ ...BASE_INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.changes).toEqual([]);
  });

  it("accepts valid external assumptions written into a content section", async () => {
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
            targetSectionKey: "boundary",
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
    // external/inferred content goes into the content section, not a bucket.
    expect(result.decision.changes[0].targetSectionKey).toBe("boundary");
  });

  it("downgrades externally sourced confirmed facts to assumptions kept in content section", async () => {
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
            targetSectionKey: "boundary",
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
      targetSectionKey: "boundary",
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
            targetSectionKey: "boundary",
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
            targetSectionKey: "boundary",
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
    expect(result.decision.changes[0].targetSectionKey).toBe("boundary");
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

  it("a browser-sourced confirmed_fact is downgraded to an assumption in a content section", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "confirmed_fact",
            targetSectionKey: "boundary",
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
    expect(result.decision.changes[0]).toMatchObject({ category: "assumption", targetSectionKey: "boundary" });
  });

  it("a browser-sourced open_question is dropped (questions belong in chat, not the doc)", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          {
            category: "open_question",
            targetSectionKey: "boundary",
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
    expect(result.decision.changes).toEqual([]);
  });

  it("browser sources can never yield a confirmed_fact; confirmed_fact still requires explicit user evidence", async () => {
    const fetchImpl = makeFetchImpl(
      JSON.stringify({
        changes: [
          // assistant-sourced confirmed_fact -> downgraded to assumption
          {
            category: "confirmed_fact",
            targetSectionKey: "boundary",
            patchKind: "append_bullet",
            markdown: "- 助手推断",
            evidence: { source: "assistant", quote: "推断" },
          },
          // browser-sourced confirmed_fact -> downgraded to assumption
          {
            category: "confirmed_fact",
            targetSectionKey: "boundary",
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
    expect(result.decision.changes.length).toBeGreaterThan(0);
    for (const patch of result.decision.changes) {
      expect(patch.category).not.toBe("confirmed_fact");
    }
  });
});