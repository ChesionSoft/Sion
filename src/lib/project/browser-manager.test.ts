import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserLaunchError,
  BrowserManager,
  type BrowserManagerDeps,
  type PersistentContextLike,
} from "./browser-manager";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "Sion-browser-mgr-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<BrowserManagerDeps> = {}): BrowserManagerDeps {
  return {
    platform: "darwin",
    env: {} as NodeJS.ProcessEnv,
    cacheDir,
    fs: {
      exists: vi.fn(async () => false),
    },
    spawn: vi.fn(async () => ({ stdout: "", status: 1 })),
    playwright: undefined,
    ...overrides,
  };
}

function fakeContext(): PersistentContextLike & { closeCalls: number; newPageMock: unknown } {
  let closeCalls = 0;
  const ctx = {
    close: vi.fn(async () => {
      closeCalls += 1;
    }),
    newPage: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
  };
  return Object.assign(ctx as PersistentContextLike, { closeCalls, newPageMock: null });
}

describe("BrowserManager/resolveSystemBrowser", () => {
  it("discovers Chrome before Edge on macOS", async () => {
    const exists = vi.fn(async (p: string) => p.includes("Google Chrome.app"));
    const spawn = vi.fn(async () => ({ stdout: "Google Chrome 120.0.6099.109", status: 0 }));
    const mgr = new BrowserManager(makeDeps({ platform: "darwin", fs: { exists }, spawn }));
    const browser = await mgr.resolveSystemBrowser();
    expect(browser).toEqual({
      kind: "chrome",
      version: "120.0.6099.109",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
  });

  it("falls back to Edge when Chrome is missing on macOS", async () => {
    const exists = vi.fn(async (p: string) => p.includes("Microsoft Edge.app"));
    const spawn = vi.fn(async () => ({ stdout: "Microsoft Edge 120.0.2210.89", status: 0 }));
    const mgr = new BrowserManager(makeDeps({ platform: "darwin", fs: { exists }, spawn }));
    const browser = await mgr.resolveSystemBrowser();
    expect(browser?.kind).toBe("edge");
    expect(browser?.version).toBe("120.0.2210.89");
  });

  it("returns null when no system browser is found on macOS", async () => {
    const mgr = new BrowserManager(makeDeps({ platform: "darwin" }));
    expect(await mgr.resolveSystemBrowser()).toBeNull();
  });

  it("discovers Chrome on Windows via Program Files paths", async () => {
    const exists = vi.fn(async (p: string) => p.endsWith("chrome.exe") && !p.includes("Edge"));
    const spawn = vi.fn(async () => ({ stdout: "Google Chrome 119.0", status: 0 }));
    const mgr = new BrowserManager(
      makeDeps({ platform: "win32", fs: { exists }, spawn }),
    );
    const browser = await mgr.resolveSystemBrowser();
    expect(browser?.kind).toBe("chrome");
    expect(browser?.path?.endsWith("chrome.exe")).toBe(true);
  });

  it("discovers Chrome on Linux by probing candidate commands", async () => {
    const spawn = vi.fn(async (cmd: string) =>
      cmd === "google-chrome"
        ? { stdout: "Google Chrome 118.0.5993.70", status: 0 }
        : { stdout: "", status: 1 },
    );
    const mgr = new BrowserManager(makeDeps({ platform: "linux", spawn }));
    const browser = await mgr.resolveSystemBrowser();
    expect(browser?.kind).toBe("chrome");
    expect(browser?.version).toBe("118.0.5993.70");
  });

  it("returns null when no Linux candidate resolves", async () => {
    const mgr = new BrowserManager(makeDeps({ platform: "linux" }));
    expect(await mgr.resolveSystemBrowser()).toBeNull();
  });
});

describe("BrowserManager/getStatus", () => {
  it("derives status from system browser + managed/profile existence", async () => {
    const managedExe = path.join(cacheDir, "chromium", "chrome");
    const exists = vi.fn(async (p: string) => {
      if (p.includes("Google Chrome.app")) return true;
      if (p === managedExe) return true; // managed installed
      if (p === path.join(cacheDir, "profile")) return true; // profile configured
      return false;
    });
    const spawn = vi.fn(async () => ({ stdout: "Google Chrome 120.0.6099.109", status: 0 }));
    const mgr = new BrowserManager(
      makeDeps({
        fs: { exists },
        spawn,
        playwright: {
          chromium: { executablePath: () => managedExe, launchPersistentContext: vi.fn() },
        },
      }),
    );
    const status = await mgr.getStatus();
    expect(status.systemBrowser).toEqual({
      kind: "chrome",
      version: "120.0.6099.109",
    });
    expect(status.managedChromiumInstalled).toBe(true);
    expect(status.profileConfigured).toBe(true);
  });

  it("reports unavailable when nothing is configured", async () => {
    const mgr = new BrowserManager(makeDeps());
    const status = await mgr.getStatus();
    expect(status.systemBrowser).toBeNull();
    expect(status.managedChromiumInstalled).toBe(false);
    expect(status.profileConfigured).toBe(false);
  });

  it("keeps cache and profile paths outside process.cwd()", () => {
    const mgr = new BrowserManager(makeDeps({ cacheDir }));
    expect(mgr.profileDir().startsWith(process.cwd())).toBe(false);
    expect(mgr.managedChromiumDir().startsWith(process.cwd())).toBe(false);
  });
});

describe("BrowserManager/resolveExecutable", () => {
  it("prefers managed chromium when preference is chromium and it is installed", async () => {
    const managedExe = path.join(cacheDir, "chromium", "chrome");
    const exists = vi.fn(async (p: string) => p === managedExe);
    const mgr = new BrowserManager(
      makeDeps({
        fs: { exists },
        playwright: {
          chromium: {
            executablePath: () => managedExe,
            launchPersistentContext: vi.fn(),
          },
        },
      }),
    );
    const exe = await mgr.resolveExecutable("chromium");
    expect(exe?.path).toBe(managedExe);
    expect(exe?.kind).toBe("chromium");
  });

  it("falls back to the system browser when chromium is preferred but not installed", async () => {
    const exists = vi.fn(async (p: string) => p.includes("Google Chrome.app"));
    const spawn = vi.fn(async () => ({ stdout: "Google Chrome 120.0", status: 0 }));
    const mgr = new BrowserManager(makeDeps({ fs: { exists }, spawn }));
    const exe = await mgr.resolveExecutable("chromium");
    expect(exe?.kind).toBe("chrome");
  });

  it("uses the system browser for system preference", async () => {
    const exists = vi.fn(async (p: string) => p.includes("Microsoft Edge.app"));
    const spawn = vi.fn(async () => ({ stdout: "Microsoft Edge 120.0", status: 0 }));
    const mgr = new BrowserManager(makeDeps({ fs: { exists }, spawn }));
    const exe = await mgr.resolveExecutable("system");
    expect(exe?.kind).toBe("edge");
  });

  it("returns null when nothing is available", async () => {
    const mgr = new BrowserManager(makeDeps());
    expect(await mgr.resolveExecutable("system")).toBeNull();
  });
});

describe("BrowserManager/withPersistentContext", () => {
  it("never overlaps two concurrent context uses (FIFO mutex)", async () => {
    let active = 0;
    let maxOverlap = 0;
    const ctx: PersistentContextLike = {
      close: vi.fn(async () => {
        active -= 1;
      }),
      newPage: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
    };
    const launch = vi.fn(async () => {
      active += 1;
      maxOverlap = Math.max(maxOverlap, active);
      return ctx;
    });
    const mgr = new BrowserManager(
      makeDeps({
        playwright: {
          chromium: { launchPersistentContext: launch, executablePath: () => "x" },
        },
      }),
    );

    const work = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "done";
    });

    const results = await Promise.all([
      mgr.withPersistentContext(work),
      mgr.withPersistentContext(work),
      mgr.withPersistentContext(work),
    ]);
    expect(results).toEqual(["done", "done", "done"]);
    expect(maxOverlap).toBe(1);
    expect((ctx.close as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3);
  });

  it("closes the context in finally when work throws", async () => {
    const ctx = fakeContext();
    const launch = vi.fn(async () => ctx);
    const mgr = new BrowserManager(
      makeDeps({
        playwright: {
          chromium: { launchPersistentContext: launch, executablePath: () => "x" },
        },
      }),
    );
    await expect(
      mgr.withPersistentContext(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(ctx.close).toHaveBeenCalled();
  });

  it("maps a launch failure to BrowserLaunchError", async () => {
    const launch = vi.fn(async () => {
      throw new Error("playwright: executable doesn't exist");
    });
    const mgr = new BrowserManager(
      makeDeps({
        playwright: {
          chromium: { launchPersistentContext: launch, executablePath: () => "x" },
        },
      }),
    );
    await expect(mgr.withPersistentContext(async () => "x")).rejects.toThrow(BrowserLaunchError);
  });

  it("closes the context when the abort signal fires", async () => {
    const ctx = fakeContext();
    const launch = vi.fn(async () => ctx);
    const mgr = new BrowserManager(
      makeDeps({
        playwright: {
          chromium: { launchPersistentContext: launch, executablePath: () => "x" },
        },
      }),
    );
    const controller = new AbortController();
    const work = vi.fn(
      async () =>
        new Promise<string>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    setTimeout(() => controller.abort(), 5);
    await expect(mgr.withPersistentContext(work, { signal: controller.signal })).rejects.toThrow();
    expect(ctx.close).toHaveBeenCalled();
  });

  it("launches with downloads refused", async () => {
    const ctx = fakeContext();
    const launch = vi.fn(async (_dir: string, opts?: Record<string, unknown>) => {
      expect(opts?.acceptDownloads).toBe(false);
      return ctx;
    });
    const mgr = new BrowserManager(
      makeDeps({
        playwright: {
          chromium: { launchPersistentContext: launch, executablePath: () => "x" },
        },
      }),
    );
    await mgr.withPersistentContext(async () => "ok");
  });
});

describe("BrowserManager/managed mutations", () => {
  it("installManagedChromium runs the installer with PLAYWRIGHT_BROWSERS_PATH set", async () => {
    const runInstall = vi.fn(async () => {});
    const mgr = new BrowserManager(makeDeps({ runInstall }));
    await mgr.installManagedChromium();
    expect(runInstall).toHaveBeenCalledWith({
      env: expect.objectContaining({
        PLAYWRIGHT_BROWSERS_PATH: path.join(cacheDir, "chromium"),
      }),
    });
  });

  it("removeManagedChromium removes only the managed directory", async () => {
    const removed: string[] = [];
    const remove = vi.fn(async (target: string) => {
      removed.push(target);
    });
    const mgr = new BrowserManager(makeDeps({ fs: { exists: async () => false, remove } }));
    await mgr.removeManagedChromium();
    expect(removed).toEqual([path.join(cacheDir, "chromium")]);
  });

  it("clearProfile removes only Sion's profile directory", async () => {
    const removed: string[] = [];
    const remove = vi.fn(async (target: string) => {
      removed.push(target);
    });
    const mgr = new BrowserManager(makeDeps({ fs: { exists: async () => false, remove } }));
    await mgr.clearProfile();
    expect(removed).toEqual([path.join(cacheDir, "profile")]);
  });
});