import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSharedBrowserManager,
  __resetSharedBrowserManagerForTests,
  __setSharedBrowserManagerForTests,
} from "./browser-registry";
import type { BrowserManager } from "./browser-manager";

afterEach(() => {
  __resetSharedBrowserManagerForTests();
});

describe("browser-registry", () => {
  it("returns the same BrowserManager instance on repeated calls", async () => {
    const a = await getSharedBrowserManager();
    const b = await getSharedBrowserManager();
    expect(a).toBe(b);
  });

  it("allows tests to inject a fake manager", async () => {
    const fake = { withPersistentContext: vi.fn() } as unknown as BrowserManager;
    __setSharedBrowserManagerForTests(fake);
    expect(await getSharedBrowserManager()).toBe(fake);
  });

  it("reset clears the cached instance so the next call creates a new one", async () => {
    const first = await getSharedBrowserManager();
    __resetSharedBrowserManagerForTests();
    const second = await getSharedBrowserManager();
    expect(second).not.toBe(first);
  });
});
