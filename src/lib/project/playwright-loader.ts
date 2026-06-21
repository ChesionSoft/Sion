import { defaultManagedChromiumDir } from "./browser-manager";
import type { PlaywrightLike } from "./browser-manager";

/**
 * Server-side loader for the real `playwright-core` runtime. `playwright-core`
 * is on Next.js's auto-externalize list, so `await import("playwright-core")`
 * resolves to the actual package at runtime (not a bundled/virtual module) and
 * returns the real `chromium`, whose `executablePath()` /
 * `launchPersistentContext()` match `PlaywrightLike`. The instance is cached so
 * repeated route calls share one runtime.
 *
 * Before returning, `PLAYWRIGHT_BROWSERS_PATH` is pinned to Sion's managed
 * directory: `installManagedChromium` downloads there, and Playwright's
 * registry reads this env var for both `executablePath()` (status detection)
 * and `launchPersistentContext` (no explicit `executablePath` is passed). Without
 * it, the registry resolves to the default `~/Library/Caches/ms-playwright`
 * cache, so the installed Chromium would read as "未安装" and launches would fail.
 *
 * Domain modules use `node:fs/promises` and dynamic imports; this is server-side
 * only and must never be imported into a client component.
 */
let cached: PlaywrightLike | null = null;

export async function loadPlaywright(): Promise<PlaywrightLike> {
  if (cached) return cached;
  process.env.PLAYWRIGHT_BROWSERS_PATH = defaultManagedChromiumDir();
  const mod = (await import("playwright-core")) as unknown as {
    chromium: PlaywrightLike["chromium"];
  };
  cached = { chromium: mod.chromium };
  return cached;
}

/** Test-only: reset the cache between tests. */
export function __resetPlaywrightCacheForTests(): void {
  cached = null;
}