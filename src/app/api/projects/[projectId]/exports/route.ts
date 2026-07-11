import { NextResponse } from "next/server";
import { exportProjectDocuments } from "@/lib/project/exports";
import { ProjectStore } from "@/lib/project/store";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import { streamModelChat } from "@/lib/project/model-chat";
import { buildSynthesisSystemPrompt, buildSynthesisUserPrompt, sanitizeSynthesisOutput } from "@/lib/project/synthesis";
import type { ReasoningEffort } from "@/lib/project/types";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const store = new ProjectStore();
  const modelProviderStore = new ModelProviderStore();
  const body = (await request.json().catch(() => ({}))) as {
    providerId?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
  };

  if (!body.providerId || !body.model) {
    return NextResponse.json({ error: "请先配置并选择大模型" }, { status: 400 });
  }

  const reasoningEffort =
    body.reasoningEffort && REASONING_EFFORTS.has(body.reasoningEffort) ? body.reasoningEffort : "medium";

  const provider = await modelProviderStore.getProvider(body.providerId);
  if (!provider) {
    return NextResponse.json({ error: "模型提供商不存在" }, { status: 400 });
  }

  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const nodes = await store.getProjectNodes(projectId);

  let master: string;
  try {
    // Stream the synthesis: a full-document generation can run well past a
    // provider's non-streaming timeout, so we accumulate content chunks via
    // the streaming path (same as the chat route) instead of one POST.
    let raw = "";
    for await (const part of streamModelChat({
      apiBaseUrl: provider.apiBaseUrl,
      apiUrlMode: provider.apiUrlMode,
      apiKey: provider.apiKey,
      model: body.model,
      protocol: provider.protocol,
      reasoningEffort,
      webSearchEnabled: false,
      messages: [
        { role: "system", content: buildSynthesisSystemPrompt() },
        { role: "user", content: buildSynthesisUserPrompt(project, nodes) },
      ],
    })) {
      if (part.type === "content") raw += part.content;
    }
    master = sanitizeSynthesisOutput(raw);
    if (!master.trim()) {
      console.error("[exports] synthesis returned empty content");
      return NextResponse.json({ error: "模型未返回有效内容,请重试或更换模型" }, { status: 502 });
    }
  } catch (err) {
    console.error("[exports] synthesis failed:", err);
    return NextResponse.json({ error: "综合整理失败,请重试" }, { status: 502 });
  }

  const result = await exportProjectDocuments(store, projectId, master);
  return NextResponse.json(result);
}
