import { NextResponse } from "next/server";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";
import { streamNodeMarkdownRewrite, validateRewrittenNodeMarkdown } from "@/lib/project/agent-markdown";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import type { ReasoningEffort, WorkflowNodeId } from "@/lib/project/types";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

export async function POST(request: Request, context: { params: Promise<{ projectId: string; nodeId: string }> }) {
  const { projectId, nodeId } = await context.params;

  if (!isWorkflowNodeId(nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const projectStore = new ProjectStore();
  const modelProviderStore = new ModelProviderStore();

  const project = await projectStore.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const body = (await request.json()) as {
    providerId?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    expectedRevision?: number;
  };

  if (!body.providerId) {
    return NextResponse.json({ error: "请先配置并选择大模型" }, { status: 400 });
  }

  if (!body.model) {
    return NextResponse.json({ error: "请选择模型" }, { status: 400 });
  }

  if (typeof body.expectedRevision !== "number" || !Number.isFinite(body.expectedRevision)) {
    return NextResponse.json({ error: "缺少 expectedRevision" }, { status: 400 });
  }

  const reasoningEffort = body.reasoningEffort && REASONING_EFFORTS.has(body.reasoningEffort)
    ? body.reasoningEffort
    : "medium";

  const provider = await modelProviderStore.getProvider(body.providerId);
  if (!provider) {
    return NextResponse.json({ error: "模型提供商不存在" }, { status: 400 });
  }

  const nodes = await projectStore.getProjectNodes(projectId);
  const currentNode = nodes.find((n) => n.id === nodeId)!;

  if (!currentNode) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const contextMarkdown = nodes
    .filter((n) => n.id !== nodeId)
    .map((n) => n.markdown)
    .join("\n\n");

  // Gather recent chat messages for context
  const sessions = await projectStore.listSessions(projectId, nodeId);
  const recentMessages: import("@/lib/project/types").ChatMessage[] = [];
  for (const session of sessions.slice(0, 3)) {
    const messages = await projectStore.getChatMessages(projectId, nodeId, session.id);
    // Only include chat role messages (user/assistant)
    recentMessages.push(...messages.filter((m) => m.role === "user" || m.role === "assistant"));
  }

  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event: Record<string, unknown>) => {
        if (abortController.signal.aborted) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      sendEvent({ type: "markdown_start", mode: "rewrite", baseRevision: currentNode.revision });

      let candidateMarkdown = "";
      try {
        for await (const token of streamNodeMarkdownRewrite({
          apiBaseUrl: provider.apiBaseUrl,
          apiUrlMode: provider.apiUrlMode,
          apiKey: provider.apiKey,
          model: body.model!,
          reasoningEffort,
          nodeId: nodeId as WorkflowNodeId,
          currentMarkdown: currentNode.markdown,
          contextMarkdown,
          recentMessages,
          signal: abortController.signal,
        })) {
          candidateMarkdown += token;
          sendEvent({ type: "markdown_token", content: token, mode: "rewrite" });
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          controller.close();
          return;
        }
        const message = error instanceof Error ? error.message : "LLM 请求失败";
        sendEvent({ type: "markdown_error", error: message });
        controller.close();
        return;
      }

      // Validate
      const validation = validateRewrittenNodeMarkdown(nodeId as WorkflowNodeId, candidateMarkdown);
      if (!validation.ok) {
        sendEvent({ type: "markdown_error", error: validation.error });
        controller.close();
        return;
      }

      // Attempt revision-safe save
      try {
        const updatedNode = await projectStore.updateProjectNodeIfRevision(
          projectId,
          nodeId as WorkflowNodeId,
          body.expectedRevision!,
          { markdown: candidateMarkdown, status: "generated" },
        );
        sendEvent({ type: "markdown_done", updatedNode });
      } catch (error) {
        const conflictErr = error as { latestNode?: unknown; name?: string };
        if (conflictErr.name === "NodeRevisionConflictError" && conflictErr.latestNode) {
          sendEvent({
            type: "markdown_conflict",
            latestNode: conflictErr.latestNode,
            candidateMarkdown,
          });
        } else {
          const message = error instanceof Error ? error.message : "保存失败";
          sendEvent({ type: "markdown_error", error: message });
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}