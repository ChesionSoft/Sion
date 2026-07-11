import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
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
  buildBlueprintReviseSystemPrompt,
  buildBlueprintReviseUserPrompt,
  buildBlueprintSystemPrompt,
  buildBlueprintUserPrompt,
  buildDraftReviseSystemPrompt,
  buildDraftReviseUserPrompt,
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  parseModelJson,
} from "@/lib/project/formal-prd-prompts";
import { applyDraftPatches } from "@/lib/project/formal-prd-patcher";
import {
  applyBlueprintPatches,
  parseBlueprint,
  validateBlueprint,
  validateBlueprintPatch,
  validateDraftPatch,
} from "@/lib/project/formal-prd";
import { streamModelChat } from "@/lib/project/model-chat";
import { sanitizeSynthesisOutput } from "@/lib/project/synthesis";
import { ProjectStore } from "@/lib/project/store";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import type { ReasoningEffort } from "@/lib/project/types";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);
const OPERATIONS = new Set([
  "blueprint",
  "draft",
  "approve_blueprint",
  "approve_draft",
  "finalize",
  "edit_blueprint",
  "edit_draft",
  "revise_blueprint",
  "revise_draft",
]);

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
    markdown?: string;
    instruction?: string;
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

  // --- Manual edits: replace the blueprint/draft artifact with user-supplied Markdown.
  // edit_* requires an existing corresponding digest (409 otherwise) but intentionally
  // performs no stale-digest check; the writer re-runs all lint/source gates.

  if (operation === "edit_blueprint") {
    if (!body.markdown || !body.markdown.trim()) {
      return NextResponse.json({ error: "蓝图正文不能为空" }, { status: 422 });
    }
    const state = await readStageState(store, projectId);
    if (!state.blueprintDigest) {
      return NextResponse.json({ error: "尚无导出蓝图可编辑" }, { status: 409 });
    }
    try {
      const blueprint = parseBlueprint(body.markdown);
      const nextState = await writeBlueprintArtifact(store, projectId, blueprint);
      return NextResponse.json({ stage: nextState });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 422 });
    }
  }

  if (operation === "edit_draft") {
    if (!body.markdown || !body.markdown.trim()) {
      return NextResponse.json({ error: "正文不能为空" }, { status: 422 });
    }
    const state = await readStageState(store, projectId);
    if (!state.draftDigest) {
      return NextResponse.json({ error: "尚无正式正文可编辑" }, { status: 409 });
    }
    if (!state.blueprint || !state.blueprintDigest || state.blueprintApprovedDigest !== state.blueprintDigest) {
      return NextResponse.json({ error: "导出蓝图未确认,无法编辑正文" }, { status: 409 });
    }
    try {
      const nextState = await writeDraftArtifact(store, projectId, body.markdown);
      return NextResponse.json({ stage: nextState });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 422 });
    }
  }

  // --- Agent revisions: one focused instruction -> typed patch -> existing writer.

  if (operation === "revise_blueprint") {
    if (!body.instruction?.trim() || !body.providerId || !body.model || !body.artifactDigest) {
      return NextResponse.json({ error: "请先配置并选择大模型,并填写修订指令与摘要" }, { status: 400 });
    }
    const state = await readStageState(store, projectId);
    if (!state.blueprint || !state.blueprintDigest) {
      return NextResponse.json({ error: "尚无导出蓝图可修订" }, { status: 409 });
    }
    if (body.artifactDigest !== state.blueprintDigest) {
      return NextResponse.json({ error: "蓝图摘要不匹配,请重新加载" }, { status: 409 });
    }
    const reasoningEffort =
      body.reasoningEffort && REASONING_EFFORTS.has(body.reasoningEffort) ? body.reasoningEffort : "medium";
    const modelProviderStore = new ModelProviderStore();
    const provider = await modelProviderStore.getProvider(body.providerId);
    if (!provider) {
      return NextResponse.json({ error: "模型提供商不存在" }, { status: 400 });
    }
    const nodes = await store.getProjectNodes(projectId);

    let raw = "";
    try {
      for await (const part of streamModelChat({
        apiBaseUrl: provider.apiBaseUrl,
        apiUrlMode: provider.apiUrlMode,
        apiKey: provider.apiKey,
        model: body.model,
        protocol: provider.protocol,
        reasoningEffort,
        webSearchEnabled: false,
        messages: [
          { role: "system", content: buildBlueprintReviseSystemPrompt() },
          { role: "user", content: buildBlueprintReviseUserPrompt(state.blueprint, nodes, body.instruction) },
        ],
      })) {
        if (part.type === "content") raw += part.content;
      }
    } catch (err) {
      console.error("[exports] revise_blueprint stream failed:", err);
      return NextResponse.json({ error: "修订失败,请重试或更换模型" }, { status: 502 });
    }

    let patch;
    try {
      patch = validateBlueprintPatch({ ...(parseModelJson(raw) as Record<string, unknown>), artifactDigest: body.artifactDigest });
    } catch (err) {
      console.error("[exports] revise_blueprint parse failed:", err);
      return NextResponse.json({ error: "模型未返回有效修订补丁" }, { status: 502 });
    }

    let revised;
    let applied;
    try {
      const result = applyBlueprintPatches(state.blueprint, patch);
      revised = result.blueprint;
      applied = result.applied;
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 422 });
    }
    if (applied.every((r) => r.status === "skipped")) {
      return NextResponse.json({ error: "修订未产生变更", applied }, { status: 422 });
    }
    try {
      const nextState = await writeBlueprintArtifact(store, projectId, revised);
      return NextResponse.json({ stage: nextState, applied });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 422 });
    }
  }

  if (operation === "revise_draft") {
    if (!body.instruction?.trim() || !body.providerId || !body.model || !body.artifactDigest) {
      return NextResponse.json({ error: "请先配置并选择大模型,并填写修订指令与摘要" }, { status: 400 });
    }
    const state = await readStageState(store, projectId);
    if (!state.draftDigest) {
      return NextResponse.json({ error: "尚无正式正文可修订" }, { status: 409 });
    }
    if (body.artifactDigest !== state.draftDigest) {
      return NextResponse.json({ error: "正文摘要不匹配,请重新加载" }, { status: 409 });
    }
    // Read the current draft only after confirming a digest exists.
    let draftMarkdown: string;
    try {
      draftMarkdown = await readFile(store.exportPath(projectId, "formal-prd-draft.md"), "utf8");
    } catch {
      return NextResponse.json({ error: "尚无正式正文可修订" }, { status: 409 });
    }
    if (!state.blueprint || !state.blueprintDigest || state.blueprintApprovedDigest !== state.blueprintDigest) {
      return NextResponse.json({ error: "导出蓝图未确认,无法修订正文" }, { status: 409 });
    }
    const reasoningEffort =
      body.reasoningEffort && REASONING_EFFORTS.has(body.reasoningEffort) ? body.reasoningEffort : "medium";
    const modelProviderStore = new ModelProviderStore();
    const provider = await modelProviderStore.getProvider(body.providerId);
    if (!provider) {
      return NextResponse.json({ error: "模型提供商不存在" }, { status: 400 });
    }

    let raw = "";
    try {
      for await (const part of streamModelChat({
        apiBaseUrl: provider.apiBaseUrl,
        apiUrlMode: provider.apiUrlMode,
        apiKey: provider.apiKey,
        model: body.model,
        protocol: provider.protocol,
        reasoningEffort,
        webSearchEnabled: false,
        messages: [
          { role: "system", content: buildDraftReviseSystemPrompt() },
          { role: "user", content: buildDraftReviseUserPrompt(draftMarkdown, state.blueprint, body.instruction) },
        ],
      })) {
        if (part.type === "content") raw += part.content;
      }
    } catch (err) {
      console.error("[exports] revise_draft stream failed:", err);
      return NextResponse.json({ error: "修订失败,请重试或更换模型" }, { status: 502 });
    }

    let patch;
    try {
      patch = validateDraftPatch({ ...(parseModelJson(raw) as Record<string, unknown>), artifactDigest: body.artifactDigest });
    } catch (err) {
      console.error("[exports] revise_draft parse failed:", err);
      return NextResponse.json({ error: "模型未返回有效修订补丁" }, { status: 502 });
    }

    let revisedMarkdown: string;
    let applied;
    try {
      const result = applyDraftPatches(draftMarkdown, patch);
      revisedMarkdown = result.markdown;
      applied = result.applied;
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 422 });
    }
    if (applied.every((r) => r.status === "skipped")) {
      return NextResponse.json({ error: "修订未产生变更", applied }, { status: 422 });
    }
    try {
      const nextState = await writeDraftArtifact(store, projectId, revisedMarkdown);
      return NextResponse.json({ stage: nextState, applied });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 422 });
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