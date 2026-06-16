import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigPanel } from "./model-config-panel";

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings/model-providers" && !init) {
      return new Response(JSON.stringify({ providers: [] }));
    }

    if (url === "/api/settings/model-providers" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          provider: {
            id: "mp-1",
            name: "Proxy",
            apiBaseUrl: "https://proxy.example.com/openai/chat/completions",
            apiUrlMode: "full",
            apiKey: "secret",
            models: [{ name: "gpt-4o", isDefault: true }],
            isDefault: true,
            createdAt: "2026-06-16T00:00:00.000Z",
            updatedAt: "2026-06-16T00:00:00.000Z",
          },
        }),
        { status: 201 },
      );
    }

    return new Response(JSON.stringify({ providers: [] }));
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ModelConfigPanel", () => {
  it("submits full API URL mode when creating a provider", async () => {
    const user = userEvent.setup();
    render(<ModelConfigPanel />);

    await user.click(await screen.findByRole("button", { name: /添加模型提供商/ }));
    await user.selectOptions(screen.getByLabelText("API 链接模式"), "full");
    await user.type(screen.getByLabelText("提供商名称"), "Proxy");
    await user.type(screen.getByLabelText("完整 API URL"), "https://proxy.example.com/openai/chat/completions");
    await user.type(screen.getByLabelText("API Key"), "secret");
    await user.type(screen.getByPlaceholderText(/gpt-4\.1/), "gpt-4o");
    await user.click(screen.getByRole("button", { name: /保存配置/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/settings/model-providers",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        }),
      );
    });

    const postCall = vi.mocked(globalThis.fetch).mock.calls.find(
      ([url, init]) => String(url) === "/api/settings/model-providers" && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual(
      expect.objectContaining({
        name: "Proxy",
        apiBaseUrl: "https://proxy.example.com/openai/chat/completions",
        apiUrlMode: "full",
        apiKey: "secret",
      }),
    );
  });

  it("submits changed API URL mode when editing a provider", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings/model-providers" && !init) {
        return new Response(JSON.stringify({
          providers: [
            {
              id: "mp-1",
              name: "Proxy",
              apiBaseUrl: "https://api.example.com",
              apiUrlMode: "base",
              apiKey: "secret",
              models: [{ name: "gpt-4o", isDefault: true }],
              isDefault: true,
              createdAt: "2026-06-16T00:00:00.000Z",
              updatedAt: "2026-06-16T00:00:00.000Z",
            },
          ],
        }));
      }

      if (url === "/api/settings/model-providers/mp-1" && init?.method === "PATCH") {
        return new Response(JSON.stringify({
          provider: {
            id: "mp-1",
            name: "Proxy",
            apiBaseUrl: "https://api.example.com/openai/chat/completions",
            apiUrlMode: "full",
            apiKey: "secret",
            models: [{ name: "gpt-4o", isDefault: true }],
            isDefault: true,
            createdAt: "2026-06-16T00:00:00.000Z",
            updatedAt: "2026-06-16T00:01:00.000Z",
          },
        }));
      }

      return new Response(JSON.stringify({ providers: [] }));
    }) as typeof fetch;

    const user = userEvent.setup();
    render(<ModelConfigPanel />);

    await user.click(await screen.findByRole("button", { name: /编辑/ }));
    await user.selectOptions(screen.getByLabelText("API 链接模式"), "full");
    await user.clear(screen.getByLabelText("完整 API URL"));
    await user.type(screen.getByLabelText("完整 API URL"), "https://api.example.com/openai/chat/completions");
    await user.click(screen.getByRole("button", { name: /保存配置/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/settings/model-providers/mp-1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.any(String),
        }),
      );
    });

    const patchCall = vi.mocked(globalThis.fetch).mock.calls.find(
      ([url, init]) => String(url) === "/api/settings/model-providers/mp-1" && init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual(
      expect.objectContaining({
        apiBaseUrl: "https://api.example.com/openai/chat/completions",
        apiUrlMode: "full",
      }),
    );
  });
});
