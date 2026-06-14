import { describe, expect, it, vi } from "vitest";
import { callOpenAICompatibleChat } from "./llm";

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
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "secret",
      model: "example-chat",
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
      }),
    );
  });
});
