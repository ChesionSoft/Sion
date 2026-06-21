import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AgentOverrideStore } from "@/lib/project/agent-overrides";
import { dedupeExternalSources } from "@/lib/project/external-source";
import { FileStore } from "@/lib/project/files";
import { judgeNodeFacts } from "@/lib/project/node-fact-judge";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import { BrowserSearchStore } from "@/lib/settings/browser-search";
import { BrowserManager } from "@/lib/project/browser-manager";
import { loadPlaywright } from "@/lib/project/playwright-loader";
import { createBrowserWebService } from "@/lib/project/browser-web-service";
import { runWebOrchestrator, type WebOrchestratorEvent } from "@/lib/project/web-tool-orchestrator";
import { extractHttpUrls } from "@/lib/project/url-content";
import type {
  ChatStreamEvent,
  ExternalSource,
  ReasoningEffort,
  WorkflowNodeId,
} from "@/lib/project/types";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const projectStore = new ProjectStore();
  const modelProviderStore = new ModelProviderStore();
  const fileStore = new FileStore();
  const agentStore = new AgentOverrideStore();
  const body = (await request.json()) as {
    nodeId?: string;
    message?: string;
    providerId?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    fileIds?: string[];
    sessionId?: string;
  };

  if (!body.nodeId || !isWorkflowNodeId(body.nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 400 });
  }

  const nodeId = body.nodeId as WorkflowNodeId;

  if (!body.message?.trim()) {
    return NextResponse.json({ error: "消息不能为空" }, { status: 400 });
  }

  if (!body.providerId) {
    return NextResponse.json({ error: "请先配置并选择大模型" }, { status: 400 });
  }

  if (!body.model) {
    return NextResponse.json({ error: "请选择模型" }, { status: 400 });
  }

  const reasoningEffort = body.reasoningEffort && REASONING_EFFORTS.has(body.reasoningEffort)
    ? body.reasoningEffort
    : "medium";

  const provider = await modelProviderStore.getProvider(body.providerId);
  if (!provider) {
    return NextResponse.json({ error: "模型提供商不存在" }, { status: 400 });
  }

  const project = await projectStore.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const nodes = await projectStore.getProjectNodes(projectId);
  const currentNode = nodes.find((node) => node.id === nodeId);

  if (!currentNode) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const contextMarkdown = nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => node.markdown)
    .join("\n\n");

  const agentRuleContent = await agentStore.getActiveRuleContent(projectId, nodeId);

  const systemPromptParts: string[] = [
    `当前项目：${project.name}`,
    "",
    agentRuleContent.trim(),
    "",
    "## 当前节点 Markdown",
    "",
    currentNode.markdown.trim(),
    "",
    "## 可参考项目上下文",
    "",
    contextMarkdown.trim() || "暂无已确认上下文。",
  ];

  if (body.fileIds?.length) {
    const fileContents: string[] = [];
    for (const fileId of body.fileIds) {
      const record = await fileStore.getFile(projectId, fileId);
      if (!record || record.status !== "available") continue;

      const content = await fileStore.readFileContent(projectId, fileId);
      if (content) {
        fileContents.push(`## 引用文件：${record.originalName}\n\n${content}`);
      }
    }

    if (fileContents.length) {
      systemPromptParts.push("");
      systemPromptParts.push(...fileContents);
    }
  }

  systemPromptParts.push(
    "",
    "## 回复要求",
    "",
    "- 先回答用户问题，再给出建议写入 Markdown 的内容。",
    "- 如果信息不足，每轮最多提出 3 个关键问题。",
    '- 所有假设必须写入"设计假设"，所有不确定项必须写入"待确认问题"。',
    "- 不要修改其他节点负责的章节。",
  );

  const systemPrompt = systemPromptParts.join("\n");

  // Resolve or create the session BEFORE streaming so we can read the persisted
  // webSearchEnabled preference. The chat POST body never carries the switch —
  // only the session PATCH endpoint can change it.
  let sessionId = body.sessionId;
  let webSearchEnabled = false;
  if (sessionId) {
    try {
      const session = await projectStore.getSession(projectId, nodeId, sessionId);
      webSearchEnabled = session.webSearchEnabled;
    } catch {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }
  } else {
    const session = await projectStore.createSession(projectId, nodeId);
    sessionId = session.id;
    webSearchEnabled = session.webSearchEnabled;
  }

  const trimmedUserMessage = body.message.trim();
  await projectStore.appendChatMessage(projectId, nodeId, {
    id: randomUUID(),
    role: "user",
    content: trimmedUserMessage,
    createdAt: new Date().toISOString(),
  }, sessionId);

  // Tool capability is stored per model — never derived from protocol.
  const modelEntry = provider.models.find((m) => m.name === body.model);
  const toolCalling = !!modelEntry?.toolCalling;

  // Direct URLs in the user message are always fetched through the browser
  // service, regardless of the search toggle.
  const directUrls = extractHttpUrls(trimmedUserMessage);

  // Search engine preference (Google/Baidu) from browser-search settings.
  const browserSearchStore = new BrowserSearchStore();
  const preferences = await browserSearchStore.getPreferences();

  const browserService = createBrowserWebService({
    browserManager: new BrowserManager({ playwright: await loadPlaywright() }),
  });

  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event: ChatStreamEvent) => {
        if (abortController.signal.aborted) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      let assistantContent = "";
      let assistantReasoningContent = "";
      const consumedSources: ExternalSource[] = [];

      try {
        for await (const e of runWebOrchestrator({
          apiBaseUrl: provider.apiBaseUrl,
          apiUrlMode: provider.apiUrlMode,
          apiKey: provider.apiKey,
          model: body.model!,
          protocol: provider.protocol,
          reasoningEffort,
          toolCalling,
          systemPrompt,
          userMessage: trimmedUserMessage,
          directUrls,
          searchEnabled: webSearchEnabled,
          engine: preferences.defaultEngine,
          projectId,
          sessionId,
          browserService,
          signal: abortController.signal,
        })) {
          for (const sse of mapOrchestratorEvent(e)) {
            if (sse.type === "token") assistantContent += sse.content;
            else if (sse.type === "reasoning") assistantReasoningContent += sse.content;
            else if (sse.type === "source") consumedSources.push(sse.source);
            sendEvent(sse);
          }
        }

        if (abortController.signal.aborted) return;

        // Persist assistant message with deduped sources actually supplied to
        // the answer model.
        const sources = dedupeExternalSources(consumedSources);
        await projectStore.appendChatMessage(projectId, nodeId, {
          id: randomUUID(),
          role: "assistant",
          content: assistantContent,
          ...(assistantReasoningContent ? { reasoningContent: assistantReasoningContent } : {}),
          ...(sources.length ? { sources } : {}),
          createdAt: new Date().toISOString(),
        }, sessionId);

        sendEvent({ type: "markdown_check_start" });

        const result = await judgeNodeFacts({
          apiBaseUrl: provider.apiBaseUrl,
          apiUrlMode: provider.apiUrlMode,
          apiKey: provider.apiKey,
          model: body.model!,
          protocol: provider.protocol,
          nodeId,
          userMessage: trimmedUserMessage,
          assistantContent,
          externalSources: sources,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) return;

        if (!result.ok) {
          sendEvent({ type: "markdown_unchanged", warning: result.error });
        } else if (result.decision.changes.length === 0) {
          sendEvent({ type: "markdown_unchanged" });
        } else {
          sendEvent({ type: "markdown_start", mode: "increment", baseRevision: currentNode.revision });
          for (const patch of result.decision.changes) {
            sendEvent({ type: "markdown_patch_preview", patch });
          }
        }

        sendEvent({ type: "done", sessionId });
      } catch (error) {
        if (assistantContent || assistantReasoningContent) {
          const sources = dedupeExternalSources(consumedSources);
          await projectStore.appendChatMessage(projectId, nodeId, {
            id: randomUUID(),
            role: "assistant",
            content: assistantContent,
            ...(assistantReasoningContent ? { reasoningContent: assistantReasoningContent } : {}),
            ...(sources.length ? { sources } : {}),
            createdAt: new Date().toISOString(),
          }, sessionId);
        }

        if (abortController.signal.aborted) {
          return;
        }

        const rawMessage = error instanceof Error ? error.message : "LLM 请求失败";
        const message = rawMessage.replace(/(?:\/[\w.\-]+)+|[A-Za-z]:\\[^\s]*/g, "").slice(0, 200) || "请求失败";
        let errorMessage = `模型请求失败：${message}`;
        if (message.includes("context") || message.includes("length") || message.includes("token")) {
          errorMessage = "上下文长度超出模型限制，请减少引用文件或选择更大上下文的模型。";
        } else if (message.includes("status 404")) {
          errorMessage = "API 端点不存在（404），请检查模型提供商的 API Base URL 是否正确。";
        } else if (message.includes("status 401") || message.includes("status 403")) {
          errorMessage = "API 认证失败，请检查模型提供商的 API Key 是否正确。";
        }

        sendEvent({ type: "error", error: errorMessage });
      } finally {
        controller.close();
      }
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

function mapOrchestratorEvent(e: WebOrchestratorEvent): ChatStreamEvent[] {
  switch (e.type) {
    case "content":
      return [{ type: "token", content: e.delta }];
    case "reasoning":
      return [{ type: "reasoning", content: e.delta }];
    case "web_search_start":
      return [{ type: "web_search_start", query: e.query }];
    case "web_search_result":
      return e.ok
        ? [{ type: "web_search_result", query: e.query, ok: true, results: e.results }]
        : [{ type: "web_search_result", query: e.query, ok: false, code: e.code, message: e.message, ...(e.verificationId ? { verificationId: e.verificationId } : {}) }];
    case "web_fetch_start":
      return [{ type: "web_fetch_start", url: e.url }];
    case "web_fetch_result":
      return e.ok
        ? [{ type: "web_fetch_result", url: e.url, ok: true, content: e.content }]
        : [{ type: "web_fetch_result", url: e.url, ok: false, code: e.code, message: e.message }];
    case "browser_verification_required":
      return [{ type: "browser_verification_required", verificationId: e.verificationId, engine: e.engine }];
    case "source":
      return [{ type: "source", source: e.source }];
    case "notice":
      return [{ type: "notice", message: e.message }];
    default:
      return [];
  }
}