import { BrowserManager } from "./browser-manager";
import { loadPlaywright } from "./playwright-loader";

/**
 * Process-local BrowserManager for production routes.
 * All callers that share ~/.sion/browser-cache/profile must use this
 * so withPersistentContext's mutex actually serializes launches.
 *
 * This module cannot coordinate separate Node.js processes; that limitation
 * is acceptable for this local-first single-server deployment.
 *
 * Tests that need isolation keep constructing `new BrowserManager(deps)`.
 * This module is server-only - never import from client components.
 */

let shared: BrowserManager | null = null;
let sharedPromise: Promise<BrowserManager> | null = null;

export async function getSharedBrowserManager(): Promise<BrowserManager> {
  if (shared) return shared;
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const playwright = await loadPlaywright();
      shared = new BrowserManager({ playwright });
      return shared;
    })();
  }
  try {
    return await sharedPromise;
  } catch (error) {
    sharedPromise = null;
    throw error;
  }
}

/** Test-only: inject a manager (or null via reset). */
export function __setSharedBrowserManagerForTests(manager: BrowserManager): void {
  shared = manager;
  sharedPromise = Promise.resolve(manager);
}

/** Test-only: drop cache between tests. */
export function __resetSharedBrowserManagerForTests(): void {
  shared = null;
  sharedPromise = null;
}
