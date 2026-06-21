import { NextResponse } from "next/server";
import { BrowserManager } from "@/lib/project/browser-manager";
import { loadPlaywright } from "@/lib/project/playwright-loader";
import { browserVerificationStore, VerificationError } from "@/lib/project/browser-verification";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: NO_STORE });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; verificationId: string }> },
) {
  const { projectId, verificationId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400, headers: NO_STORE });
  }

  const sessionId = (body as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return NextResponse.json({ error: "sessionId 必填" }, { status: 400, headers: NO_STORE });
  }

  const manager = new BrowserManager({ playwright: await loadPlaywright() });
  try {
    await manager.openVisibleVerification({
      resolveUrl: () =>
        browserVerificationStore.consume({
          verificationId,
          projectId,
          sessionId,
        }),
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof VerificationError) {
      return NextResponse.json({ error: "验证请求已失效" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ error: "打开浏览器验证失败" }, { status: 500, headers: NO_STORE });
  }
}
