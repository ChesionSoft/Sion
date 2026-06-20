import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import { generateUpdatedNodeMarkdown, streamNodeMarkdownRewrite, validateRewrittenNodeMarkdown } from "./agent-markdown";

describe("generateUpdatedNodeMarkdown", () => {
  it("asks the model to return complete updated Markdown for the current node", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "# 功能模块设计\n\n## 已确认内容\n\n- 登录\n- 客户管理",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const markdown = await generateUpdatedNodeMarkdown({
      apiBaseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "test-model",
      reasoningEffort: "medium",
      nodeId: "feature-design",
      currentMarkdown: "# 功能模块设计\n\n## 已确认内容\n\n- 登录",
      contextMarkdown: "# 项目基本信息\n\n测试项目",
      userMessage: "补充客户管理功能",
      assistantContent: "我会把客户管理写入当前节点。",
      fetchImpl,
    });

    expect(markdown).toBe("# 功能模块设计\n\n## 已确认内容\n\n- 登录\n- 客户管理");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      reasoning_effort?: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("test-model");
    expect(body.reasoning_effort).toBe("medium");
    expect(body.messages[0].content).toContain("Return only the complete updated Markdown");
    expect(body.messages[1].content).toContain("feature-design");
    expect(body.messages[1].content).toContain("补充客户管理功能");
  });

  it("removes a wrapper Markdown code fence from model output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "```markdown\n# 功能模块设计\n\n- 客户管理\n```" } }],
        }),
        { status: 200 },
      ),
    );

    await expect(
      generateUpdatedNodeMarkdown({
        apiBaseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "test-model",
        nodeId: "feature-design",
        currentMarkdown: "# 功能模块设计",
        contextMarkdown: "",
        userMessage: "更新",
        assistantContent: "已整理",
        fetchImpl,
      }),
    ).resolves.toBe("# 功能模块设计\n\n- 客户管理");
  });

  it("rejects empty Markdown returned by the model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), { status: 200 }),
    );

    await expect(
      generateUpdatedNodeMarkdown({
        apiBaseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "test-model",
        nodeId: "feature-design",
        currentMarkdown: "# 功能模块设计",
        contextMarkdown: "",
        userMessage: "更新",
        assistantContent: "已整理",
        fetchImpl,
      }),
    ).rejects.toThrow("Updated Markdown is empty");
  });

  it("forwards an abort signal to the underlying LLM call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "# 功能模块设计" } }] }), {
        status: 200,
      }),
    );
    const controller = new AbortController();

    await generateUpdatedNodeMarkdown({
      apiBaseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "m",
      nodeId: "feature-design",
      currentMarkdown: "",
      contextMarkdown: "",
      userMessage: "u",
      assistantContent: "a",
      fetchImpl,
      signal: controller.signal,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init?.signal).toBe(controller.signal);
  });
});

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
