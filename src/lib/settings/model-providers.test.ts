import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelProviderStore } from "./model-providers";

let settingsDir: string;

beforeEach(async () => {
  settingsDir = await mkdtemp(path.join(os.tmpdir(), "Sion-settings-"));
});

afterEach(async () => {
  await rm(settingsDir, { recursive: true, force: true });
});

describe("ModelProviderStore", () => {
  it("creates a provider with ModelEntry objects", async () => {
    const store = new ModelProviderStore(settingsDir);
    const provider = await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [
        { name: "gpt-4o", contextLength: 128000, isDefault: true },
        { name: "gpt-4o-mini", contextLength: 128000 },
      ],
    });

    expect(provider.name).toBe("OpenAI");
    expect(provider.isDefault).toBe(true);
    expect(provider.apiUrlMode).toBe("base");
    expect(provider.models).toHaveLength(2);
    expect(provider.models[0]).toEqual({ name: "gpt-4o", contextLength: 128000, isDefault: true });
    expect(provider.models[1]).toEqual({ name: "gpt-4o-mini", contextLength: 128000, isDefault: false });
  });

  it("creates a provider with a full API URL mode", async () => {
    const store = new ModelProviderStore(settingsDir);
    const provider = await store.createProvider({
      name: "Proxy",
      apiBaseUrl: "https://proxy.example.com/openai/chat/completions",
      apiUrlMode: "full",
      apiKey: "sk-test",
      models: [{ name: "gpt-4o", isDefault: true }],
    });

    expect(provider.apiUrlMode).toBe("full");
  });

  it("ensures exactly one model is marked default", async () => {
    const store = new ModelProviderStore(settingsDir);
    const provider = await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [
        { name: "gpt-4o" },
        { name: "gpt-4o-mini" },
      ],
    });

    expect(provider.models[0].isDefault).toBe(true);
    expect(provider.models[1].isDefault).toBe(false);
  });

  it("lists created providers", async () => {
    const store = new ModelProviderStore(settingsDir);
    await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ name: "gpt-4o", isDefault: true }],
    });

    const providers = await store.listProviders();
    expect(providers).toHaveLength(1);
  });

  it("updates a provider", async () => {
    const store = new ModelProviderStore(settingsDir);
    const created = await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ name: "gpt-4o", isDefault: true }],
    });

    const updated = await store.updateProvider(created.id, {
      name: "OpenAI Updated",
      apiUrlMode: "full",
    });
    expect(updated.name).toBe("OpenAI Updated");
    expect(updated.apiUrlMode).toBe("full");
  });

  it("deletes a provider and promotes another to default", async () => {
    const store = new ModelProviderStore(settingsDir);
    const first = await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ name: "gpt-4o", isDefault: true }],
    });
    const second = await store.createProvider({
      name: "DeepSeek",
      apiBaseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      models: [{ name: "deepseek-chat", isDefault: true }],
    });

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    await store.deleteProvider(first.id);

    const providers = await store.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].isDefault).toBe(true);
  });

  it("returns default provider", async () => {
    const store = new ModelProviderStore(settingsDir);
    await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ name: "gpt-4o", isDefault: true }],
    });

    const def = await store.getDefaultProvider();
    expect(def?.name).toBe("OpenAI");
  });

  it("validates required fields on create", async () => {
    const store = new ModelProviderStore(settingsDir);
    await expect(
      store.createProvider({ name: "", apiBaseUrl: "", apiKey: "", models: [] }),
    ).rejects.toThrow("提供商名称不能为空");
  });

  it("validates model names are not empty", async () => {
    const store = new ModelProviderStore(settingsDir);
    await expect(
      store.createProvider({
        name: "OpenAI",
        apiBaseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: [{ name: "" }],
      }),
    ).rejects.toThrow("模型名称不能为空");
  });

  it("getDefaultModelName returns the model with isDefault", async () => {
    const store = new ModelProviderStore(settingsDir);
    const provider = await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [
        { name: "gpt-4o", isDefault: true },
        { name: "gpt-4o-mini" },
      ],
    });
    expect(store.getDefaultModelName(provider)).toBe("gpt-4o");
  });

  it("getDefaultModelName falls back to first model", async () => {
    const store = new ModelProviderStore(settingsDir);
    const provider = await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ name: "gpt-4o" }, { name: "gpt-4o-mini" }],
    });
    expect(store.getDefaultModelName(provider)).toBe("gpt-4o");
  });

  it("migrates legacy string[] models to ModelEntry[]", async () => {
    const filePath = path.join(settingsDir, "model-providers.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(filePath, JSON.stringify([
      {
        id: "legacy-id",
        name: "Legacy",
        apiBaseUrl: "https://api.legacy.com/v1",
        apiKey: "sk-legacy",
        models: ["gpt-4o", "gpt-4o-mini"],
        defaultModel: "gpt-4o-mini",
        isDefault: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]));

    const store = new ModelProviderStore(settingsDir);
    const providers = await store.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].apiUrlMode).toBe("base");
    expect(providers[0].models).toEqual([
      { name: "gpt-4o", isDefault: false },
      { name: "gpt-4o-mini", isDefault: true },
    ]);
  });
});
