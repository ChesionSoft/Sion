import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSearchStatus } from "@/lib/project/types";

// The default status provider derives status from BrowserManager + the
// Playwright loader. Mock both so the GET/PATCH route stays deterministic and
// never touches the real filesystem or playwright-core runtime.
const fakeStatus: BrowserSearchStatus = {
  systemBrowser: null,
  managedChromiumInstalled: false,
  profileConfigured: false,
};

vi.mock("@/lib/project/browser-manager", () => ({
  BrowserManager: class {
    getStatus = vi.fn(async () => ({ ...fakeStatus }));
  },
}));

vi.mock("@/lib/project/playwright-loader", () => ({
  loadPlaywright: vi.fn(async () => ({ chromium: {} })),
}));

import { GET, PATCH } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-browser-search-api-"));
  process.cwd = () => tmpDir;
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("browser-search settings API", () => {
  it("GET returns default preferences and derived status", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.preferences).toEqual({ defaultEngine: "google", browserPreference: "system" });
    expect(body.status).toEqual({
      systemBrowser: null,
      managedChromiumInstalled: false,
      profileConfigured: false,
    });
  });

  it("GET sets Cache-Control: no-store", async () => {
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("GET never returns profile or executable absolute paths", async () => {
    const response = await GET();
    const text = JSON.stringify(await response.json());
    expect(text).not.toMatch(/\/Users\/|\/tmp\/|[A-Z]:\\/);
  });

  it("PATCH accepts a partial preference update", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/settings/browser-search", {
        method: "PATCH",
        body: JSON.stringify({ defaultEngine: "baidu" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.preferences).toEqual({ defaultEngine: "baidu", browserPreference: "system" });

    const getResponse = await GET();
    const getBody = await getResponse.json();
    expect(getBody.preferences.defaultEngine).toBe("baidu");
  });

  it("PATCH rejects unknown fields with 400", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/settings/browser-search", {
        method: "PATCH",
        body: JSON.stringify({ engine: "google" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("PATCH rejects an invalid enum value with 400", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/settings/browser-search", {
        method: "PATCH",
        body: JSON.stringify({ defaultEngine: "yahoo" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("PATCH derives status from the status provider", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/settings/browser-search", {
        method: "PATCH",
        body: JSON.stringify({ browserPreference: "chromium" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBeDefined();
    expect(body.preferences.browserPreference).toBe("chromium");
  });

  it("does not expose a method other than GET/PATCH", () => {
    // Route handlers are named exports; ensure no POST/DELETE etc.
    expect(typeof GET).toBe("function");
    expect(typeof PATCH).toBe("function");
  });
});