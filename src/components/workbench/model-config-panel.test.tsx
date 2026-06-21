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

  it("submits OpenAI Responses protocol when creating a provider", async () => {
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
              name: "OpenAI Responses",
              apiBaseUrl: "https://api.openai.com",
              apiUrlMode: "base",
              apiKey: "secret",
              protocol: "openai_responses",
              models: [{ name: "gpt-5", isDefault: true, toolCalling: false }],
              isDefault: true,
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
            },
          }),
          { status: 201 },
        );
      }

      return new Response(JSON.stringify({ providers: [] }));
    }) as typeof fetch;

    const user = userEvent.setup();
    render(<ModelConfigPanel />);

    await user.click(await screen.findByRole("button", { name: /添加模型提供商/ }));
    await user.selectOptions(screen.getByLabelText("API 协议"), "openai_responses");
    expect(screen.getByText("系统会自动补全 /v1/responses。")).toBeInTheDocument();
    await user.type(screen.getByLabelText("提供商名称"), "OpenAI Responses");
    await user.type(screen.getByLabelText("API Base URL"), "https://api.openai.com");
    await user.type(screen.getByLabelText("API Key"), "secret");
    await user.type(screen.getByPlaceholderText(/gpt-4\.1/), "gpt-5");
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
        name: "OpenAI Responses",
        apiBaseUrl: "https://api.openai.com",
        apiUrlMode: "base",
        protocol: "openai_responses",
        apiKey: "secret",
      }),
    );
  });

  it("does not claim Responses supports native web search", async () => {
    const user = userEvent.setup();
    render(<ModelConfigPanel />);
    await user.click(await screen.findByRole("button", { name: /添加模型提供商/ }));
    // The retired capability claim must be gone, and protocol copy must say it
    // controls request format only.
    expect(screen.queryByText(/原生联网/)).not.toBeInTheDocument();
    expect(screen.getByText(/协议仅决定请求格式/)).toBeInTheDocument();
  });

  it("defaults tool calling off and submits the saved value when enabled", async () => {
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
              name: "ToolProvider",
              apiBaseUrl: "https://api.example.com",
              apiUrlMode: "base",
              apiKey: "secret",
              models: [{ name: "tool-model", isDefault: true, toolCalling: true }],
              isDefault: true,
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ providers: [] }));
    }) as typeof fetch;

    const user = userEvent.setup();
    render(<ModelConfigPanel />);
    await user.click(await screen.findByRole("button", { name: /添加模型提供商/ }));
    const toolCheckbox = screen.getByRole("checkbox", { name: /工具调用：模型 1/ });
    expect(toolCheckbox).not.toBeChecked();
    await user.type(screen.getByLabelText("提供商名称"), "ToolProvider");
    await user.type(screen.getByLabelText("API Base URL"), "https://api.example.com");
    await user.type(screen.getByLabelText("API Key"), "secret");
    await user.type(screen.getByPlaceholderText(/gpt-4\.1/), "tool-model");
    await user.click(toolCheckbox);
    await user.click(screen.getByRole("button", { name: /保存配置/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/settings/model-providers",
        expect.objectContaining({ method: "POST", body: expect.any(String) }),
      );
    });
    const postCall = vi.mocked(globalThis.fetch).mock.calls.find(
      ([url, init]) => String(url) === "/api/settings/model-providers" && init?.method === "POST",
    );
    const body = JSON.parse(String(postCall?.[1]?.body));
    expect(body.models[0]).toMatchObject({ name: "tool-model", toolCalling: true });
  });

  it("edits an existing model's tool calling flag", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings/model-providers" && !init) {
        return new Response(JSON.stringify({
          providers: [
            {
              id: "mp-1",
              name: "Edit",
              apiBaseUrl: "https://api.example.com",
              apiUrlMode: "base",
              apiKey: "secret",
              protocol: "chat_completions",
              models: [{ name: "m", isDefault: true, toolCalling: false }],
              isDefault: true,
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
            },
          ],
        }));
      }
      if (url === "/api/settings/model-providers/mp-1" && init?.method === "PATCH") {
        return new Response(JSON.stringify({
          provider: {
            id: "mp-1",
            name: "Edit",
            apiBaseUrl: "https://api.example.com",
            apiUrlMode: "base",
            apiKey: "secret",
            protocol: "chat_completions",
            models: [{ name: "m", isDefault: true, toolCalling: true }],
            isDefault: true,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:01:00.000Z",
          },
        }));
      }
      return new Response(JSON.stringify({ providers: [] }));
    }) as typeof fetch;

    const user = userEvent.setup();
    render(<ModelConfigPanel />);
    await user.click(await screen.findByRole("button", { name: /编辑/ }));
    const toolCheckbox = screen.getByRole("checkbox", { name: /工具调用：m/ });
    expect(toolCheckbox).not.toBeChecked();
    await user.click(toolCheckbox);
    await user.click(screen.getByRole("button", { name: /保存配置/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/settings/model-providers/mp-1",
        expect.objectContaining({ method: "PATCH", body: expect.any(String) }),
      );
    });
    const patchCall = vi.mocked(globalThis.fetch).mock.calls.find(
      ([url, init]) => String(url) === "/api/settings/model-providers/mp-1" && init?.method === "PATCH",
    );
    const body = JSON.parse(String(patchCall?.[1]?.body));
    expect(body.models[0]).toMatchObject({ toolCalling: true });
  });
});
