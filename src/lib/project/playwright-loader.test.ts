import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chromiumStub = {
  executablePath: vi.fn(() => "/fake/chromium"),
  launchPersistentContext: vi.fn(),
};

vi.mock("playwright-core", () => ({
  chromium: chromiumStub,
}));

import { loadPlaywright, __resetPlaywrightCacheForTests } from "./playwright-loader";

describe("loadPlaywright", () => {
  let previousBrowsersPath: string | undefined;

  beforeEach(() => {
    __resetPlaywrightCacheForTests();
    chromiumStub.executablePath.mockClear();
    previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  });

  afterEach(() => {
    if (previousBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
  });

  it("returns the real chromium from playwright-core", async () => {
    const pw = await loadPlaywright();
    expect(pw.chromium).toBe(chromiumStub);
    expect(pw.chromium.executablePath()).toBe("/fake/chromium");
  });

  it("caches the instance across calls", async () => {
    const first = await loadPlaywright();
    const second = await loadPlaywright();
    expect(second).toBe(first);
  });

  it("pins PLAYWRIGHT_BROWSERS_PATH to Sion's managed chromium dir", async () => {
    await loadPlaywright();
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toMatch(/\.sion\/browser-cache\/chromium$/);
  });
});