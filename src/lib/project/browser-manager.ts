import os from "node:os";
import path from "node:path";
import { BrowserEgressProxy, type EgressProxyHandle } from "./browser-egress-proxy";
import type { BrowserSearchStatus } from "./types";

/**
 * BrowserManager owns the single independent persistent profile and serializes
 * every use of it. Discovery, version probing, and Playwright are injected so
 * the manager is deterministic in tests. Browser network egress is forced
 * through a safe proxy in a later task; this module only owns launch/close
 * serialization and executable resolution.
 */

export class BrowserLaunchError extends Error {
  constructor(public readonly code: "browser_launch_failed", message: string) {
    super(message);
    this.name = "BrowserLaunchError";
  }
}

export type ResolvedBrowser = {
  kind: "chrome" | "edge";
  version: string;
  path: string;
};

export type ResolvedExecutable = {
  kind: "chrome" | "edge" | "chromium";
  path: string;
};

export type PersistentContextLike = {
  newPage(): Promise<unknown>;
  close(): Promise<void>;
  route?(
    pattern: string,
    handler: (route: RouteLike, request: RequestLike) => Promise<void> | void,
  ): Promise<void>;
  on?(event: "close", handler: () => void): void;
};

export type RouteLike = {
  abort(code?: string): Promise<void>;
  continue(): Promise<void>;
};

export type RequestLike = {
  url(): string;
  isNavigationRequest(): boolean;
  resourceType(): string;
};

/**
 * Route handler that blocks WebSockets and aborts top-level navigation to
 * non-HTTP(S) targets. Every other request is allowed through (the egress
 * proxy validates the actual network target).
 */
export async function enforceEgressPolicy(route: RouteLike, request: RequestLike): Promise<void> {
  if (request.resourceType() === "websocket") {
    await route.abort();
    return;
  }
  if (request.isNavigationRequest()) {
    try {
      const target = new URL(request.url());
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        await route.abort();
        return;
      }
    } catch {
      await route.abort();
      return;
    }
  }
  await route.continue();
}

export type PlaywrightLike = {
  chromium: {
    executablePath(): string;
    launchPersistentContext(
      userDataDir: string,
      opts?: Record<string, unknown>,
    ): Promise<PersistentContextLike>;
  };
};

export type BrowserManagerDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  fs?: {
    exists(target: string): Promise<boolean>;
    remove?(target: string): Promise<void>;
  };
  spawn?: (cmd: string, args: string[]) => Promise<{ stdout: string; status: number | null }>;
  runInstall?: (opts: { env: NodeJS.ProcessEnv }) => Promise<void>;
  playwright?: PlaywrightLike;
  proxyFactory?: () => { start(): Promise<EgressProxyHandle> };
};

const MACOS_CANDIDATES: { kind: "chrome" | "edge"; path: string }[] = [
  { kind: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { kind: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
];

const WINDOWS_CANDIDATES: { kind: "chrome" | "edge"; path: string }[] = [
  { kind: "chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { kind: "chrome", path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
  { kind: "edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
  { kind: "edge", path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" },
];

const LINUX_CANDIDATES: { kind: "chrome" | "edge"; cmd: string }[] = [
  { kind: "chrome", cmd: "google-chrome" },
  { kind: "chrome", cmd: "google-chrome-stable" },
  { kind: "edge", cmd: "microsoft-edge" },
  { kind: "edge", cmd: "microsoft-edge-stable" },
];

const VERSION_RE = /(\d+\.\d+\.\d+\.\d+|\d+\.\d+)/;

async function defaultExists(target: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function defaultSpawn(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; status: number | null }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve({ stdout, status: 1 }));
    child.on("close", (status) => resolve({ stdout, status }));
  });
}

async function defaultRemove(target: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(target, { recursive: true, force: true });
}

async function defaultRunInstall(opts: { env: NodeJS.ProcessEnv }): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cliPath = await resolvePlaywrightCliPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
      env: opts.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", (error) => reject(error));
    child.on("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error("managed chromium install failed"));
    });
  });
}

/**
 * Locate `playwright-core`'s `cli.js` on disk without going through
 * `require.resolve`. Under Next.js 16 Turbopack the bundler intercepts
 * `createRequire(import.meta.url).resolve("playwright-core/package.json")` and
 * returns a virtual external descriptor string rather than a real path, so the
 * spawned `node <cli.js>` fails with `Cannot find module`. Walking
 * `node_modules` from the project root with plain `node:fs`/`node:path` is
 * bundler-proof: the server runs from the project root, and no bare-specifier
 * require is involved. Throws if the package cannot be found.
 */
export async function resolvePlaywrightCliPath(
  fs: { existsSync(target: string): boolean } | undefined = undefined,
  cwd: string = process.cwd(),
): Promise<string> {
  const exists = fs?.existsSync ?? (await import("node:fs")).existsSync;
  let dir = cwd;
  for (let i = 0; i < 32; i++) {
    const cliPath = path.join(dir, "node_modules", "playwright-core", "cli.js");
    if (exists(cliPath)) return cliPath;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("playwright-core cli.js not found");
}

function defaultCacheDir(): string {
  const envCache = process.env.XDG_CACHE_HOME;
  if (envCache && envCache.trim()) return path.join(envCache.trim(), "sion");
  return path.join(os.homedir(), ".sion", "browser-cache");
}

/**
 * The default managed-Chromium directory (`<cacheDir>/chromium`), used to pin
 * `PLAYWRIGHT_BROWSERS_PATH` so Playwright's registry resolves to Sion's own
 * Chromium rather than the default `ms-playwright` cache. Exported for the
 * loader, which sets the env once when the real runtime is loaded.
 */
export function defaultManagedChromiumDir(): string {
  return path.join(defaultCacheDir(), "chromium");
}

export class BrowserManager {
  private readonly deps: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    cacheDir: string;
    fs: {
      exists(target: string): Promise<boolean>;
      remove(target: string): Promise<void>;
    };
    spawn: (cmd: string, args: string[]) => Promise<{ stdout: string; status: number | null }>;
    runInstall: (opts: { env: NodeJS.ProcessEnv }) => Promise<void>;
    playwright?: PlaywrightLike;
    proxyFactory: () => { start(): Promise<EgressProxyHandle> };
  };
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(deps: BrowserManagerDeps = {}) {
    const fs = deps.fs;
    this.deps = {
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
      cacheDir: deps.cacheDir ?? defaultCacheDir(),
      fs: {
        exists: fs?.exists ?? defaultExists,
        remove: fs?.remove ?? defaultRemove,
      },
      spawn: deps.spawn ?? defaultSpawn,
      runInstall: deps.runInstall ?? defaultRunInstall,
      playwright: deps.playwright,
      proxyFactory: deps.proxyFactory ?? (() => new BrowserEgressProxy()),
    };
  }

  profileDir(): string {
    return path.join(this.deps.cacheDir, "profile");
  }

  managedChromiumDir(): string {
    return path.join(this.deps.cacheDir, "chromium");
  }

  private async managedChromiumInstalled(): Promise<boolean> {
    if (!this.deps.playwright) return false;
    try {
      const exe = this.deps.playwright.chromium.executablePath();
      return await this.deps.fs.exists(exe);
    } catch {
      return false;
    }
  }

  async resolveSystemBrowser(): Promise<ResolvedBrowser | null> {
    const candidates =
      this.deps.platform === "darwin"
        ? MACOS_CANDIDATES
        : this.deps.platform === "win32"
          ? WINDOWS_CANDIDATES
          : [];

    if (candidates.length > 0) {
      for (const candidate of candidates) {
        if (await this.deps.fs.exists(candidate.path)) {
          const version = await this.probeVersion(candidate.path);
          if (version) return { kind: candidate.kind, version, path: candidate.path };
        }
      }
      return null;
    }

    // Linux: probe candidate commands with --version.
    for (const candidate of LINUX_CANDIDATES) {
      const result = await this.deps.spawn(candidate.cmd, ["--version"]);
      if (result.status === 0) {
        const version = parseVersion(result.stdout);
        if (version) return { kind: candidate.kind, version, path: candidate.cmd };
      }
    }
    return null;
  }

  private async probeVersion(executable: string): Promise<string | null> {
    const result = await this.deps.spawn(executable, ["--version"]);
    if (result.status !== 0) return null;
    return parseVersion(result.stdout);
  }

  async resolveExecutable(
    preference: "system" | "chromium" = "system",
  ): Promise<ResolvedExecutable | null> {
    if (preference === "chromium") {
      if (await this.managedChromiumInstalled()) {
        try {
          return {
            kind: "chromium",
            path: this.deps.playwright!.chromium.executablePath(),
          };
        } catch {
          // fall through to system
        }
      }
    }
    const system = await this.resolveSystemBrowser();
    if (system) return { kind: system.kind, path: system.path };
    if (preference === "chromium" && (await this.managedChromiumInstalled())) {
      try {
        return { kind: "chromium", path: this.deps.playwright!.chromium.executablePath() };
      } catch {
        return null;
      }
    }
    return null;
  }

  async getStatus(): Promise<BrowserSearchStatus> {
    const system = await this.resolveSystemBrowser();
    return {
      systemBrowser: system ? { kind: system.kind, version: system.version } : null,
      managedChromiumInstalled: await this.managedChromiumInstalled(),
      profileConfigured: await this.deps.fs.exists(this.profileDir()),
    };
  }

  /**
   * Explicitly install managed Chromium into Sion's user-cache directory. No
   * browser is downloaded on demand elsewhere; this is the only install path.
   * Raw child output is never surfaced to callers.
   */
  async installManagedChromium(): Promise<void> {
    await this.enqueueExclusive(async () => {
      await this.deps.runInstall({
        env: { ...this.deps.env, PLAYWRIGHT_BROWSERS_PATH: this.managedChromiumDir() },
      });
    });
  }

  /** Remove only Sion's managed Chromium directory, never a personal browser. */
  async removeManagedChromium(): Promise<void> {
    await this.enqueueExclusive(async () => {
      await this.deps.fs.remove(this.managedChromiumDir());
    });
  }

  /** Clear only Sion's own profile directory. */
  async clearProfile(): Promise<void> {
    await this.enqueueExclusive(async () => {
      await this.deps.fs.remove(this.profileDir());
    });
  }

  /**
   * Open a visible (headed) browser at a server-held verification URL. The
   * challenge is consumed via `resolveUrl` only after the serialized context
   * lock is acquired, so a failed consume never navigates. The model has no
   * control over this page. Resolves when the user closes the window, the
   * bounded timeout elapses, or the request aborts; the context is always
   * cleaned up in finally.
   */
  async openVisibleVerification(opts: {
    resolveUrl: () => Promise<string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    if (!this.deps.playwright) {
      throw new BrowserLaunchError("browser_launch_failed", "浏览器运行时不可用");
    }
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    await this.withPersistentContext(
      async (ctx) => {
        const url = await opts.resolveUrl();
        const page = (await ctx.newPage()) as {
          goto(url: string, opts?: Record<string, unknown>): Promise<void>;
        };
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await waitForCloseOrTimeout(ctx, opts.signal, timeoutMs);
      },
      { signal: opts.signal, launchOptions: { headless: false } },
    );
  }

  /**
   * Run `work` against a freshly launched persistent context. A FIFO mutex
   * guarantees two calls never overlap. The context is closed in `finally`
   * for success, failure, timeout, and abort. Never points userDataDir at a
   * personal browser profile — only at Sion's own profile directory.
   */
  async withPersistentContext<T>(
    work: (ctx: PersistentContextLike) => Promise<T>,
    opts: { signal?: AbortSignal; launchOptions?: Record<string, unknown> } = {},
  ): Promise<T> {
    if (!this.deps.playwright) {
      throw new BrowserLaunchError("browser_launch_failed", "浏览器运行时不可用");
    }
    return this.enqueueExclusive(async () => {
      // Start the safe egress proxy first; a startup failure prevents launch.
      const proxy = this.deps.proxyFactory();
      let proxyHandle: EgressProxyHandle;
      try {
        proxyHandle = await proxy.start();
      } catch {
        throw new BrowserLaunchError("browser_launch_failed", "安全代理启动失败");
      }

      let ctx: PersistentContextLike;
      try {
        ctx = await this.deps.playwright!.chromium.launchPersistentContext(this.profileDir(), {
          acceptDownloads: false,
          proxy: { server: proxyHandle.server },
          args: ["--proxy-bypass-list=<-loopback>"],
          ...(opts.launchOptions ?? {}),
        });
      } catch (error) {
        await proxyHandle.close().catch(() => {});
        throw new BrowserLaunchError("browser_launch_failed", sanitizeLaunchError(error));
      }

      try {
        // Block WebSockets and reject non-HTTP(S) top-level navigation. The
        // egress proxy validates every actual network target.
        if (typeof ctx.route === "function") {
          await ctx.route("**/*", enforceEgressPolicy).catch(() => {});
        }
        return await work(ctx);
      } finally {
        await ctx.close().catch(() => {});
        await proxyHandle.close().catch(() => {});
      }
    });
  }

  /**
   * Serialize work against the shared browser/profile state. Every caller that
   * touches the persistent profile - launches, installs, removals, clears - goes
   * through this FIFO queue so a destructive maintenance op can never race an
   * active context. `getStatus` intentionally stays off the queue.
   *
   * NOTE: this mutex is process-local only. It cannot coordinate separate Node
   * processes that share the same on-disk profile directory; that is acceptable
   * for this local-first single-server deployment.
   */
  private enqueueExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(work, work);
    this.mutex = run.catch(() => {});
    return run;
  }
}

function parseVersion(stdout: string): string | null {
  const match = VERSION_RE.exec(stdout);
  return match ? match[1] : null;
}

function sanitizeLaunchError(error: unknown): string {
  if (error instanceof Error && error.message) {
    // Drop any absolute local paths the launcher might leak.
    return error.message.replace(/(?:\/[\w.\-]+)+|[A-Za-z]:\\[^\s]*/g, "<path>").slice(0, 300);
  }
  return "浏览器启动失败";
}

function waitForCloseOrTimeout(
  ctx: PersistentContextLike,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const timer = setTimeout(() => finish(resolve), timeoutMs);
    if (typeof ctx.on === "function") {
      ctx.on("close", () => finish(resolve));
    }
    if (signal) {
      if (signal.aborted) {
        finish(() => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
        return;
      }
      signal.addEventListener(
        "abort",
        () =>
          finish(() => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }),
        { once: true },
      );
    }
  });
}
