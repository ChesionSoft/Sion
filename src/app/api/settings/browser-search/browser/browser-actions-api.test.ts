import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSearchStatus } from "@/lib/project/types";

const defaultStatus: BrowserSearchStatus = {
  systemBrowser: null,
  managedChromiumInstalled: false,
  profileConfigured: false,
};

const mocks = {
  getStatus: vi.fn(async (): Promise<BrowserSearchStatus> => ({ ...defaultStatus })),
  installManagedChromium: vi.fn(async (): Promise<void> => {}),
  removeManagedChromium: vi.fn(async (): Promise<void> => {}),
  clearProfile: vi.fn(async (): Promise<void> => {}),
};

vi.mock("@/lib/project/browser-manager", () => {
  class BrowserManager {
    getStatus = mocks.getStatus;
    installManagedChromium = mocks.installManagedChromium;
    removeManagedChromium = mocks.removeManagedChromium;
    clearProfile = mocks.clearProfile;
  }
  return { BrowserManager };
});

import { POST } from "./route";

function post(action: unknown) {
  return POST(
    new Request("http://localhost/api/settings/browser-search/browser", {
      method: "POST",
      body: JSON.stringify(typeof action === "string" ? { action } : action),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStatus.mockResolvedValue({ ...defaultStatus });
  mocks.installManagedChromium.mockResolvedValue(undefined);
  mocks.removeManagedChromium.mockResolvedValue(undefined);
  mocks.clearProfile.mockResolvedValue(undefined);
});

describe("browser actions API", () => {
  it("detect returns derived status only", async () => {
    mocks.getStatus.mockResolvedValue({
      systemBrowser: { kind: "chrome", version: "120.0" },
      managedChromiumInstalled: true,
      profileConfigured: false,
    });
    const response = await post("detect");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toEqual({
      systemBrowser: { kind: "chrome", version: "120.0" },
      managedChromiumInstalled: true,
      profileConfigured: false,
    });
    expect(body).not.toHaveProperty("path");
    expect(mocks.installManagedChromium).not.toHaveBeenCalled();
  });

  it("install runs the install mutation and returns status", async () => {
    const response = await post("install");
    expect(response.status).toBe(200);
    expect(mocks.installManagedChromium).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.status).toBeDefined();
  });

  it("remove runs the remove mutation", async () => {
    const response = await post("remove");
    expect(response.status).toBe(200);
    expect(mocks.removeManagedChromium).toHaveBeenCalledTimes(1);
  });

  it("clear_profile runs the clear mutation", async () => {
    const response = await post("clear_profile");
    expect(response.status).toBe(200);
    expect(mocks.clearProfile).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown action with 400", async () => {
    const response = await post("reinstall");
    expect(response.status).toBe(400);
    expect(mocks.installManagedChromium).not.toHaveBeenCalled();
  });

  it("rejects a missing action with 400", async () => {
    const response = await POST(
      new Request("http://localhost/api/settings/browser-search/browser", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 409 for concurrent mutations", async () => {
    mocks.installManagedChromium.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );
    const [a, b] = await Promise.all([post("install"), post("remove")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain(409);
    expect(statuses).toContain(200);
  });

  it("detect does not take the mutation lock and can run during a mutation", async () => {
    mocks.installManagedChromium.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );
    const installPromise = post("install");
    const detect = await post("detect");
    expect(detect.status).toBe(200);
    await installPromise;
  });

  it("sanitizes mutation errors and never leaks paths", async () => {
    mocks.removeManagedChromium.mockRejectedValue(new Error("rm failed at /Users/secret/profile"));
    const response = await post("remove");
    expect(response.status).toBe(500);
    const body = await response.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain("/Users/secret");
    expect(text).not.toContain("rm failed");
  });

  it("never returns profile or executable absolute paths in any response", async () => {
    mocks.getStatus.mockResolvedValue({
      systemBrowser: { kind: "chrome", version: "120.0" },
      managedChromiumInstalled: true,
      profileConfigured: true,
    });
    const response = await post("detect");
    const text = JSON.stringify(await response.json());
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\/);
  });
});