import { describe, expect, it, vi } from "vitest";
import { judgeNodeFacts } from "./node-fact-judge";

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
});
