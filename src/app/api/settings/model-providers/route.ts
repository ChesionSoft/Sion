import { NextResponse } from "next/server";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import type { ApiUrlMode, ModelEntry, ModelProviderProtocol } from "@/lib/project/types";

const store = new ModelProviderStore();

export async function GET() {
  return NextResponse.json({ providers: await store.listProviders() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    apiBaseUrl?: string;
    apiUrlMode?: ApiUrlMode;
    protocol?: ModelProviderProtocol;
    apiKey?: string;
    models?: ModelEntry[];
    isDefault?: boolean;
  };

  try {
    const provider = await store.createProvider({
      name: body.name ?? "",
      apiBaseUrl: body.apiBaseUrl ?? "",
      apiUrlMode: body.apiUrlMode,
      protocol: body.protocol,
      apiKey: body.apiKey ?? "",
      models: body.models ?? [],
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
