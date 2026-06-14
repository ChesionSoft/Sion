import { mkdtemp, rm } from "node:fs/promises";
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
  it("creates a provider with defaults", async () => {
    const store = new ModelProviderStore(settingsDir);
    const provider = await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: ["gpt-4o", "gpt-4o-mini"],
      defaultModel: "gpt-4o",
    });

    expect(provider.name).toBe("OpenAI");
    expect(provider.isDefault).toBe(true);
    expect(provider.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("lists created providers", async () => {
    const store = new ModelProviderStore(settingsDir);
    await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
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
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
    });

    const updated = await store.updateProvider(created.id, { name: "OpenAI Updated" });
    expect(updated.name).toBe("OpenAI Updated");
  });

  it("deletes a provider and promotes another to default", async () => {
    const store = new ModelProviderStore(settingsDir);
    const first = await store.createProvider({
      name: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
    });
    const second = await store.createProvider({
      name: "DeepSeek",
      apiBaseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      models: ["deepseek-chat"],
      defaultModel: "deepseek-chat",
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
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
    });

    const def = await store.getDefaultProvider();
    expect(def?.name).toBe("OpenAI");
  });

  it("validates required fields on create", async () => {
    const store = new ModelProviderStore(settingsDir);
    await expect(
      store.createProvider({ name: "", apiBaseUrl: "", apiKey: "", models: [], defaultModel: "" }),
    ).rejects.toThrow("提供商名称不能为空");
  });
});
