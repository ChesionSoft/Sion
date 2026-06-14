import { NextResponse } from "next/server";
import { ModelProviderStore } from "@/lib/settings/model-providers";

const store = new ModelProviderStore();

export async function GET() {
  return NextResponse.json({ providers: await store.listProviders() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    apiBaseUrl?: string;
    apiKey?: string;
    models?: string[];
    defaultModel?: string;
    isDefault?: boolean;
  };

  try {
    const provider = await store.createProvider({
      name: body.name ?? "",
      apiBaseUrl: body.apiBaseUrl ?? "",
      apiKey: body.apiKey ?? "",
      models: body.models ?? [],
      defaultModel: body.defaultModel ?? "",
      isDefault: body.isDefault,
    });
    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.name === "ValidationError") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
