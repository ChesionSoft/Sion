import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { BrowserSearchPreferences, BrowserSearchStatus } from "@/lib/project/types";

/**
 * Persisted browser-search preferences and derived status. Only preferences
 * are stored on disk; {@link BrowserSearchStatus} is always derived from a
 * statusProvider so executable/profile paths never get persisted or leaked.
 */

const preferencesSchema = z.object({
  defaultEngine: z.enum(["google", "baidu"]),
  browserPreference: z.enum(["system", "chromium"]),
});

const partialPreferencesSchema = preferencesSchema.partial().strict();

const DEFAULT_PREFERENCES: BrowserSearchPreferences = {
  defaultEngine: "google",
  browserPreference: "system",
};

export type StatusProvider = () => BrowserSearchStatus | Promise<BrowserSearchStatus>;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class BrowserSearchStore {
  private readonly settingsDir: string;
  private readonly statusProvider: StatusProvider;

  constructor(settingsDir?: string, statusProvider?: StatusProvider) {
    this.settingsDir = settingsDir ?? path.join(process.cwd(), "settings");
    this.statusProvider = statusProvider ?? defaultStatusProvider;
  }

  private filePath(): string {
    return path.join(this.settingsDir, "browser-search.json");
  }

  async getPreferences(): Promise<BrowserSearchPreferences> {
    try {
      const raw = await readFile(this.filePath(), "utf8");
      const parsed = preferencesSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { ...DEFAULT_PREFERENCES };
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  async getStatus(): Promise<BrowserSearchStatus> {
    return this.statusProvider();
  }

  async getSnapshot(): Promise<{ preferences: BrowserSearchPreferences; status: BrowserSearchStatus }> {
    const [preferences, status] = await Promise.all([this.getPreferences(), this.getStatus()]);
    return { preferences, status };
  }

  async updatePreferences(
    partial: Partial<BrowserSearchPreferences>,
  ): Promise<BrowserSearchPreferences> {
    const parsed = partialPreferencesSchema.safeParse(partial);
    if (!parsed.success) {
      throw new ValidationError(preferencesErrorMessage(parsed.error));
    }
    const current = await this.getPreferences();
    const next: BrowserSearchPreferences = { ...current, ...parsed.data };
    await this.writePreferences(next);
    return next;
  }

  private async writePreferences(value: BrowserSearchPreferences): Promise<void> {
    await mkdir(this.settingsDir, { recursive: true });
    const filePath = this.filePath();
    const tmp = path.join(this.settingsDir, "." + path.basename(filePath) + "." + randomUUID() + ".tmp");
    try {
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(tmp, filePath);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
}

function preferencesErrorMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "浏览器搜索偏好不合法";
  if (issue.code === "unrecognized_keys") {
    return `不支持的字段：${(issue.keys ?? []).join(", ")}`;
  }
  return "浏览器搜索偏好不合法";
}

/**
 * Real status provider: derives `BrowserSearchStatus` live from the filesystem
 * via `BrowserManager.getStatus()` (system browser probe, managed-Chromium
 * existence, profile existence). Used by `GET /api/settings/browser-search`,
 * which the homepage panel loads on mount, so opening the homepage auto-detects
 * current browser status without a manual "重新检测" click.
 *
 * `playwright-core` and `browser-manager` are imported lazily so the settings
 * module's static import graph stays light and is never pulled into client
 * bundles. If probing fails for any reason, fall back to the "nothing ready"
 * status rather than 500-ing the settings read.
 */
async function defaultStatusProvider(): Promise<BrowserSearchStatus> {
  try {
    const { getSharedBrowserManager } = await import("@/lib/project/browser-registry");
    const manager = await getSharedBrowserManager();
    return await manager.getStatus();
  } catch {
    return {
      systemBrowser: null,
      managedChromiumInstalled: false,
      profileConfigured: false,
    };
  }
}