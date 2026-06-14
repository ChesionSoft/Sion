import { NextResponse } from "next/server";
import { ModelProviderStore } from "@/lib/settings/model-providers";

const store = new ModelProviderStore();

export async function PATCH(request: Request, context: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await context.params;
  const body = (await request.json()) as {
    name?: string;
    apiBaseUrl?: string;
    apiKey?: string;
    models?: string[];
    defaultModel?: string;
    isDefault?: boolean;
  };

  try {
    const provider = await store.updateProvider(providerId, body);
    return NextResponse.json({ provider });
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof Error && error.name === "ValidationError") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await context.params;

  try {
    await store.deleteProvider(providerId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
