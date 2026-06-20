import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import { streamNodeMarkdownRewrite, validateRewrittenNodeMarkdown } from "./agent-markdown";

describe("streamNodeMarkdownRewrite", () => {
  it("yields only content tokens from the LLM stream", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"思考中..."}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"# 项目基本信息"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"\\n\\n## 已确认内容"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    } as unknown as Response);

    const tokens: string[] = [];
    for await (const token of streamNodeMarkdownRewrite({
      apiBaseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "test-model",
      nodeId: "basic-info",
      currentMarkdown: "# 项目基本信息",
      contextMarkdown: "",
      recentMessages: [],
      fetchImpl,
    })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("# 项目基本信息\n\n## 已确认内容");
  });

  it("forwards abort signal to the underlying LLM call", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"# 项目基本信息"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    } as unknown as Response);

    const controller = new AbortController();
    const tokens: string[] = [];
    for await (const token of streamNodeMarkdownRewrite({
      apiBaseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "test-model",
      nodeId: "basic-info",
      currentMarkdown: "# 项目基本信息",
      contextMarkdown: "",
      recentMessages: [],
      fetchImpl,
      signal: controller.signal,
    })) {
      tokens.push(token);
    }

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init?.signal).toBe(controller.signal);
  });

  it("slices recent messages to last 20", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"# 项目基本信息"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    } as unknown as Response);

    const messages = Array.from({ length: 25 }, (_, i) => ({
      id: `msg-${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message ${i}`,
      createdAt: new Date().toISOString(),
    }));

    const tokens: string[] = [];
    for await (const token of streamNodeMarkdownRewrite({
      apiBaseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "test-model",
      nodeId: "basic-info",
      currentMarkdown: "# 项目基本信息",
      contextMarkdown: "",
      recentMessages: messages,
      fetchImpl,
    })) {
      tokens.push(token);
    }

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    // System message + user message with recent 20 messages
    const userMsg = body.messages[1].content;
    // Should contain messages 5-24 (last 20 of 25)
    expect(userMsg).toContain("Message 5");
    expect(userMsg).toContain("Message 24");
    // Should NOT contain message 0 (too old)
    expect(userMsg).not.toContain("Message 0");
  });

  it("includes schema sections in the system prompt", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"# 项目基本信息"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    } as unknown as Response);

    const tokens: string[] = [];
    for await (const token of streamNodeMarkdownRewrite({
      apiBaseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "test-model",
      nodeId: "basic-info",
      currentMarkdown: "# 项目基本信息",
      contextMarkdown: "",
      recentMessages: [],
      fetchImpl,
    })) {
      tokens.push(token);
    }

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = body.messages[0].content;
    expect(systemMsg).toContain("已确认内容");
    expect(systemMsg).toContain("基础信息表");
    expect(systemMsg).toContain("项目边界");
    expect(systemMsg).toContain("设计假设");
    expect(systemMsg).toContain("待确认问题");
  });
});

describe("validateRewrittenNodeMarkdown", () => {
  it("passes valid markdown with correct H1 and all required sections in order", () => {
    const result = validateRewrittenNodeMarkdown("basic-info", [
      "# 项目基本信息",
      "",
      "## 已确认内容",
      "",
      "确认内容",
      "",
      "## 基础信息表",
      "",
      "| 字段 | 值 |",
      "|------|-----|",
      "| 名称 | 测试 |",
      "",
      "## 项目边界",
      "",
      "边界内容",
      "",
      "## 设计假设",
      "",
      "- 假设1",
      "",
      "## 待确认问题",
      "",
      "- 问题1",
    ].join("\n"));

    expect(result).toEqual({ ok: true });
  });

  it("fails on empty markdown", () => {
    const result = validateRewrittenNodeMarkdown("basic-info", "");
    expect(result).toEqual({ ok: false, error: "重写结果为空" });
  });

  it("fails on whitespace-only markdown", () => {
    const result = validateRewrittenNodeMarkdown("basic-info", "   \n\n  ");
    expect(result).toEqual({ ok: false, error: "重写结果为空" });
  });

  it("fails when H1 does not match node title", () => {
    const result = validateRewrittenNodeMarkdown("basic-info", [
      "# 错误标题",
      "",
      "## 已确认内容",
      "",
      "内容",
    ].join("\n"));

    expect(result).toEqual({ ok: false, error: "一级标题不匹配" });
  });

  it("fails when there is no H1", () => {
    const result = validateRewrittenNodeMarkdown("basic-info", [
      "## 已确认内容",
      "",
      "内容",
    ].join("\n"));

    expect(result).toEqual({ ok: false, error: "一级标题不匹配" });
  });

  it("fails when a required section is missing", () => {
    const result = validateRewrittenNodeMarkdown("basic-info", [
      "# 项目基本信息",
      "",
      "## 已确认内容",
      "",
      "内容",
      "",
      "## 基础信息表",
      "",
      "表内容",
      "",
      "## 项目边界",
      "",
      "边界",
      "",
      "## 设计假设",
      "",
      "- 假设",
      // 待确认问题 is missing
    ].join("\n"));

    expect(result).toEqual({ ok: false, error: "缺少必填小节：待确认问题" });
  });

  it("fails when sections are in wrong order", () => {
    const result = validateRewrittenNodeMarkdown("basic-info", [
      "# 项目基本信息",
      "",
      "## 已确认内容",
      "",
      "内容",
      "",
      "## 项目边界",
      "",
      "边界",
      "",
      "## 基础信息表", // 基础信息表 should come before 项目边界
      "",
      "| 字段 | 值 |",
      "",
      "## 设计假设",
      "",
      "- 假设",
      "",
      "## 待确认问题",
      "",
      "- 问题",
    ].join("\n"));

    expect(result).toEqual({ ok: false, error: "小节顺序与骨架不一致" });
  });

  it("fails when markdown contains another node's title as a heading", () => {
    const result = validateRewrittenNodeMarkdown("basic-info", [
      "# 项目基本信息",
      "",
      "## 已确认内容",
      "",
      "内容",
      "",
      "## 基础信息表",
      "",
      "| 字段 | 值 |",
      "",
      "## 项目边界",
      "",
      "边界",
      "",
      "## 需求背景与建设目标", // This is goals node's title
      "",
      "背景内容",
      "",
      "## 设计假设",
      "",
      "- 假设",
      "",
      "## 待确认问题",
      "",
      "- 问题",
    ].join("\n"));

    expect(result).toEqual({ ok: false, error: "包含其他节点的标题" });
  });

  it("passes when optional sections are omitted", () => {
    // roles-permissions has an optional "权限矩阵" section
    const result = validateRewrittenNodeMarkdown("roles-permissions", [
      "# 用户角色与权限",
      "",
      "## 已确认内容",
      "",
      "内容",
      "",
      "## 角色清单",
      "",
      "| 角色 | 职责 | 备注 |",
      "|------|------|------|",
      "| 管理员 | 管理 | 全部 |",
      "",
      "## 设计假设",
      "",
      "- 假设",
      "",
      "## 待确认问题",
      "",
      "- 问题",
    ].join("\n"));

    expect(result).toEqual({ ok: true });
  });

  it("passes when optional sections are present", () => {
    const result = validateRewrittenNodeMarkdown("roles-permissions", [
      "# 用户角色与权限",
      "",
      "## 已确认内容",
      "",
      "内容",
      "",
      "## 角色清单",
      "",
      "| 角色 | 职责 | 备注 |",
      "",
      "## 权限矩阵",
      "",
      "| 角色 | 模块 | 权限 |",
      "",
      "## 设计假设",
      "",
      "- 假设",
      "",
      "## 待确认问题",
      "",
      "- 问题",
    ].join("\n"));

    expect(result).toEqual({ ok: true });
  });
});
