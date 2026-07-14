import { NextResponse } from "next/server";
import { getSharedBrowserManager } from "@/lib/project/browser-registry";

const NO_STORE = { "Cache-Control": "no-store" };

const MUTATION_ACTIONS = new Set(["install", "remove", "clear_profile"]);
const ALL_ACTIONS = new Set(["detect", ...MUTATION_ACTIONS]);

// Module-level mutation lock. Install/remove/clear are explicit mutations and
// never run concurrently; a second mutation while one is in flight is rejected
// with 409 rather than queued. detect does not take the lock.
let mutationInFlight = false;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400, headers: NO_STORE });
  }

  const action = (body as { action?: unknown }).action;
  if (typeof action !== "string" || !ALL_ACTIONS.has(action)) {
    return NextResponse.json({ error: "不支持的操作" }, { status: 400, headers: NO_STORE });
  }

  const manager = await getSharedBrowserManager();

  if (MUTATION_ACTIONS.has(action)) {
    if (mutationInFlight) {
      return NextResponse.json({ error: "已有浏览器操作进行中" }, { status: 409, headers: NO_STORE });
    }
    mutationInFlight = true;
    try {
      if (action === "install") await manager.installManagedChromium();
      else if (action === "remove") await manager.removeManagedChromium();
      else await manager.clearProfile();
    } catch (err) {
      // Sanitized: never leak raw exception text or local paths.
      console.error("[browser-action] install/remove/clear failed:", err);
      return NextResponse.json(
        { error: "浏览器操作失败" },
        { status: 500, headers: NO_STORE },
      );
    } finally {
      mutationInFlight = false;
    }
  }

  const status = await manager.getStatus().catch(() => ({
    systemBrowser: null,
    managedChromiumInstalled: false,
    profileConfigured: false,
  }));
  return NextResponse.json({ status }, { headers: NO_STORE });
}