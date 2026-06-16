import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiUrlMode, ModelEntry, ModelProvider } from "@/lib/project/types";

export type CreateModelProviderInput = {
  name: string;
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  models: ModelEntry[];
  isDefault?: boolean;
};

export type UpdateModelProviderInput = Partial<CreateModelProviderInput>;

export class ModelProviderStore {
  private readonly settingsDir: string;

  constructor(settingsDir?: string) {
    this.settingsDir = settingsDir ?? path.join(process.cwd(), "settings");
  }

  private filePath(): string {
    return path.join(this.settingsDir, "model-providers.json");
  }

  async listProviders(): Promise<ModelProvider[]> {
    try {
      const raw = await readJson<unknown[]>(this.filePath());
      return raw.map((item) => migrateProvider(item as Record<string, unknown>));
    } catch {
      return [];
    }
  }

  async createProvider(input: CreateModelProviderInput): Promise<ModelProvider> {
    if (!input.name?.trim()) throw new ValidationError("提供商名称不能为空");
    if (!input.apiBaseUrl?.trim()) throw new ValidationError("API Base URL 不能为空");
    if (!input.apiKey?.trim()) throw new ValidationError("API Key 不能为空");
    if (!input.models.length) throw new ValidationError("至少需要一个模型名称");
    if (input.models.some((m) => !m.name.trim())) throw new ValidationError("模型名称不能为空");

    const providers = await this.listProviders();
    const now = new Date().toISOString();

    const models = input.models.map((m, i) => ({
      ...m,
      name: m.name.trim(),
      isDefault: i === 0 ? true : m.isDefault ?? false,
    }));
    const defaultIndex = models.findIndex((m) => m.isDefault);
    if (defaultIndex === -1) models[0].isDefault = true;
    else models.forEach((m, i) => { m.isDefault = i === defaultIndex; });

    const provider: ModelProvider = {
      id: randomUUID(),
      name: input.name.trim(),
      apiBaseUrl: input.apiBaseUrl.trim(),
      apiUrlMode: normalizeApiUrlMode(input.apiUrlMode),
      apiKey: input.apiKey.trim(),
      models,
      isDefault: input.isDefault ?? (providers.length === 0),
      createdAt: now,
      updatedAt: now,
    };

    if (provider.isDefault) {
      for (const p of providers) {
        p.isDefault = false;
      }
    }

    providers.push(provider);
    await this.writeProviders(providers);
    return provider;
  }

  async updateProvider(providerId: string, input: UpdateModelProviderInput): Promise<ModelProvider> {
    const providers = await this.listProviders();
    const index = providers.findIndex((p) => p.id === providerId);
    if (index === -1) throw new NotFoundError("提供商不存在");

    const current = providers[index];
    const next: ModelProvider = {
      ...current,
      name: input.name?.trim() ?? current.name,
      apiBaseUrl: input.apiBaseUrl?.trim() ?? current.apiBaseUrl,
      apiUrlMode: normalizeApiUrlMode(input.apiUrlMode ?? current.apiUrlMode),
      apiKey: input.apiKey?.trim() ?? current.apiKey,
      models: input.models ?? current.models,
      updatedAt: new Date().toISOString(),
    };

    if (input.models) {
      const defaultIdx = next.models.findIndex((m) => m.isDefault);
      if (defaultIdx === -1 && next.models.length > 0) next.models[0].isDefault = true;
      else next.models.forEach((m, i) => { m.isDefault = i === defaultIdx; });
    }

    if (input.isDefault === true) {
      next.isDefault = true;
      for (const p of providers) {
        if (p.id !== providerId) p.isDefault = false;
      }
    }

    providers[index] = next;
    await this.writeProviders(providers);
    return next;
  }

  async deleteProvider(providerId: string): Promise<void> {
    const providers = await this.listProviders();
    const index = providers.findIndex((p) => p.id === providerId);
    if (index === -1) throw new NotFoundError("提供商不存在");

    const wasDefault = providers[index].isDefault;
    providers.splice(index, 1);

    if (wasDefault && providers.length > 0) {
      providers[0].isDefault = true;
    }

    await this.writeProviders(providers);
  }

  async getProvider(providerId: string): Promise<ModelProvider | null> {
    const providers = await this.listProviders();
    return providers.find((p) => p.id === providerId) ?? null;
  }

  async getDefaultProvider(): Promise<ModelProvider | null> {
    const providers = await this.listProviders();
    return providers.find((p) => p.isDefault) ?? null;
  }

  getDefaultModelName(provider: ModelProvider): string {
    return provider.models.find((m) => m.isDefault)?.name ?? provider.models[0]?.name ?? "";
  }

  private async writeProviders(providers: ModelProvider[]): Promise<void> {
    await mkdir(this.settingsDir, { recursive: true });
    await writeJson(this.filePath(), providers);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function migrateProvider(raw: Record<string, unknown>): ModelProvider {
  raw.apiUrlMode = normalizeApiUrlMode(raw.apiUrlMode);
  const models = raw.models;
  if (Array.isArray(models) && models.length > 0 && typeof models[0] === "string") {
    raw.models = (models as string[]).map((name: string, i: number) => ({
      name,
      isDefault: i === 0,
    }));
    if (raw.defaultModel && typeof raw.defaultModel === "string") {
      (raw.models as ModelEntry[]).forEach((m: ModelEntry) => {
        m.isDefault = m.name === raw.defaultModel;
      });
      delete raw.defaultModel;
    }
  }
  return raw as unknown as ModelProvider;
}

function normalizeApiUrlMode(value: unknown): ApiUrlMode {
  return value === "full" ? "full" : "base";
}
