import { NextResponse } from "next/server";
import { BrowserSearchStore, ValidationError } from "@/lib/settings/browser-search";
import type { BrowserSearchPreferences } from "@/lib/project/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const store = new BrowserSearchStore();
  const snapshot = await store.getSnapshot();
  return NextResponse.json(snapshot, { headers: NO_STORE });
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400, headers: NO_STORE });
  }

  const store = new BrowserSearchStore();
  try {
    const merged = await store.updatePreferences(body as Partial<BrowserSearchPreferences>);
    const status = await store.getStatus();
    return NextResponse.json({ preferences: merged, status }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }
    throw error;
  }
}