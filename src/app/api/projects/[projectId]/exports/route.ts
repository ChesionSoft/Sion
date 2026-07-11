import { NextResponse } from "next/server";
import {
  approveBlueprintArtifact,
  approveDraftArtifact,
  canFinalize,
  finalizeFormalPrdExport,
  readStageState,
  writeBlueprintArtifact,
  writeDraftArtifact,
} from "@/lib/project/exports";
import {
  buildBlueprintSystemPrompt,
  buildBlueprintUserPrompt,
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  parseModelJson,
} from "@/lib/project/formal-prd-prompts";
import { validateBlueprint } from "@/lib/project/formal-prd";
import { streamModelChat } from "@/lib/project/model-chat";
import { sanitizeSynthesisOutput } from "@/lib/project/synthesis";
import { ProjectStore } from "@/lib/project/store";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import type { ReasoningEffort } from "@/lib/project/types";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);
const OPERATIONS = new Set(["blueprint", "draft", "approve_blueprint", "approve_draft", "finalize"]);

export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const store = new ProjectStore();
  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  const [files, stage] = await Promise.all([
    store.listExports(projectId),
    readStageState(store, projectId),
  ]);
  return NextResponse.json({ files, stage });
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const store = new ProjectStore();
  const body = (await request.json().catch(() => ({}))) as {
    operation?: string;
    providerId?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    artifactDigest?: string;
  };

  const operation = body.operation;
  if (!operation || !OPERATIONS.has(operation)) {
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  }

  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  if (operation === "blueprint" || operation === "draft") {
    if (!body.providerId || !body.model) {
      return NextResponse.json({ error: "请先配置并选择大模型" }, { status: 400 });
    }
    const reasoningEffort =
      body.reasoningEffort && REASONING_EFFORTS.has(body.reasoningEffort) ? body.reasoningEffort : "medium";

    const modelProviderStore = new ModelProviderStore();
    const provider = await modelProviderStore.getProvider(body.providerId);
    if (!provider) {
      return NextResponse.json({ error: "模型提供商不存在" }, { status: 400 });
    }

    const nodes = await store.getProjectNodes(projectId);

    if (operation === "blueprint") {
      try {
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
            { role: "system", content: buildBlueprintSystemPrompt() },
            { role: "user", content: buildBlueprintUserPrompt(project, nodes) },
          ],
        })) {
          if (part.type === "content") raw += part.content;
        }
        const blueprint = validateBlueprint(parseModelJson(raw));
        const state = await writeBlueprintArtifact(store, projectId, blueprint);
        return NextResponse.json({ stage: state, digest: state.blueprintDigest });
      } catch (err) {
        console.error("[exports] blueprint failed:", err);
        return NextResponse.json({ error: "蓝图生成失败,请重试或更换模型" }, { status: 502 });
      }
    }

    // operation === "draft"
    const state = await readStageState(store, projectId);
    if (!state.blueprint || !state.blueprintDigest || state.blueprintApprovedDigest !== state.blueprintDigest) {
      return NextResponse.json({ error: "请先确认导出蓝图" }, { status: 409 });
    }
    try {
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
          { role: "system", content: buildDraftSystemPrompt() },
          { role: "user", content: buildDraftUserPrompt(state.blueprint, nodes) },
        ],
      })) {
        if (part.type === "content") raw += part.content;
      }
      const markdown = sanitizeSynthesisOutput(raw);
      if (!markdown.trim()) {
        return NextResponse.json({ error: "模型未返回有效内容,请重试或更换模型" }, { status: 502 });
      }
      const nextState = await writeDraftArtifact(store, projectId, markdown);
      return NextResponse.json({ stage: nextState, digest: nextState.draftDigest });
    } catch (err) {
      console.error("[exports] draft failed:", err);
      return NextResponse.json({ error: "正文生成失败,请重试" }, { status: 502 });
    }
  }

  if (operation === "approve_blueprint") {
    if (!body.artifactDigest) {
      return NextResponse.json({ error: "缺少蓝图摘要" }, { status: 400 });
    }
    try {
      const state = await approveBlueprintArtifact(store, projectId, body.artifactDigest);
      return NextResponse.json({ stage: state });
    } catch {
      return NextResponse.json({ error: "蓝图摘要不匹配,请重新生成或确认" }, { status: 409 });
    }
  }

  if (operation === "approve_draft") {
    if (!body.artifactDigest) {
      return NextResponse.json({ error: "缺少正文摘要" }, { status: 400 });
    }
    try {
      const state = await approveDraftArtifact(store, projectId, body.artifactDigest);
      return NextResponse.json({ stage: state });
    } catch {
      return NextResponse.json({ error: "正文摘要不匹配,请重新生成或确认" }, { status: 409 });
    }
  }

  // operation === "finalize"
  const state = await readStageState(store, projectId);
  if (!canFinalize(state)) {
    return NextResponse.json({ error: "请先确认导出蓝图与正式正文后再生成正式 Word" }, { status: 409 });
  }
  try {
    const result = await finalizeFormalPrdExport(store, projectId);
    if (result.status === 422) {
      return NextResponse.json(
        { error: "渲染质检未通过，请查看质检报告后调整正文再重新生成", stage: result.stage, qaReport: result.qaReport },
        { status: 422 },
      );
    }
    return NextResponse.json({ stage: result.stage, qaReport: result.qaReport });
  } catch (err) {
    console.error("[exports] finalize failed:", err);
    return NextResponse.json({ error: "正式 Word 生成失败,请重试" }, { status: 500 });
  }
}