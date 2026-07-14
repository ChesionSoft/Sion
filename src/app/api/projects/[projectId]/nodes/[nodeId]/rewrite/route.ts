import { NextResponse } from "next/server";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { NodeRevisionConflictError, ProjectStore } from "@/lib/project/store";
import { AgentOverrideStore } from "@/lib/project/agent-overrides";
import { streamNodeMarkdownRewrite, validateRewrittenNodeMarkdown } from "@/lib/project/agent-markdown";
import {
  buildDependencyContextMarkdown,
  collectBudgetedConversation,
  MAX_AGENT_RULE_CHARS,
  MAX_CURRENT_NODE_CHARS,
  MAX_REWRITE_HISTORY_CHARS,
  truncateForPrompt,
} from "@/lib/project/chat-context";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import type { ProjectNode, ReasoningEffort, WorkflowNodeId } from "@/lib/project/types";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

export async function POST(request: Request, context: { params: Promise<{ projectId: string; nodeId: string }> }) {
  const { projectId, nodeId } = await context.params;

  if (!isWorkflowNodeId(nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const projectStore = new ProjectStore();
  const agentStore = new AgentOverrideStore();
  const modelProviderStore = new ModelProviderStore();

  const project = await projectStore.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const body = (await request.json()) as {
    sessionId?: string;
    providerId?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    expectedRevision?: number;
  };

  if (!body.sessionId) {
    return NextResponse.json({ error: "请选择有效会话" }, { status: 400 });
  }

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

  const contextMarkdown = buildDependencyContextMarkdown(nodeId, nodes);

  const agentRuleContent = await agentStore.getActiveRuleContent(projectId, nodeId);

  let recentMessages: import("@/lib/project/types").ChatMessage[];
  try {
    const messages = await projectStore.getChatMessages(projectId, nodeId, body.sessionId);
    const filtered = messages.filter((message) => message.role === "user" || message.role === "assistant");
    recentMessages = collectBudgetedConversation(filtered, MAX_REWRITE_HISTORY_CHARS);
  } catch {
    return NextResponse.json({ error: "会话不属于当前节点" }, { status: 400 });
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
          protocol: provider.protocol,
          reasoningEffort,
          nodeId: nodeId as WorkflowNodeId,
          currentMarkdown: truncateForPrompt(currentNode.markdown, MAX_CURRENT_NODE_CHARS),
          contextMarkdown,
          recentMessages,
          agentRuleContent: truncateForPrompt(agentRuleContent, MAX_AGENT_RULE_CHARS),
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
        if (error instanceof NodeRevisionConflictError) {
          const latestNode: ProjectNode = error.latestNode;
          sendEvent({
            type: "markdown_conflict",
            latestNode,
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
