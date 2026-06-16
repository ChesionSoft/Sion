import { describe, expect, it, vi } from "vitest";
import { generateUpdatedNodeMarkdown } from "./agent-markdown";

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
});
