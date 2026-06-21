import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AgentOverrideStore } from "@/lib/project/agent-overrides";
import { dedupeExternalSources } from "@/lib/project/external-source";
import { FileStore } from "@/lib/project/files";
import { streamModelChat } from "@/lib/project/model-chat";
import { judgeNodeFacts } from "@/lib/project/node-fact-judge";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import { readPublicUrls } from "@/lib/project/url-reader";
import { extractHttpUrls } from "@/lib/project/url-content";
import { formatUntrustedWebContext } from "@/lib/project/untrusted-web-context";
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
      const adapterSources: ExternalSource[] = [];
      const providedSources: ExternalSource[] = [];

      try {
        // 1. Extract URLs from the user message and read them server-side.
        const urls = extractHttpUrls(trimmedUserMessage);
        let externalContext = "";
        if (urls.length > 0) {
          sendEvent({ type: "url_read_start", urls });
          const urlResults = await readPublicUrls(urls, { signal: abortController.signal });
          for (const result of urlResults) {
            if (result.ok) {
              sendEvent({ type: "url_read_result", url: result.requestedUrl, ok: true, source: result.source });
              providedSources.push(result.source);
              externalContext += (externalContext ? "\n\n" : "") + formatUntrustedWebContext({
                source: result.source,
                content: result.content,
              });
            } else {
              sendEvent({ type: "url_read_result", url: result.requestedUrl, ok: false, error: result.error });
            }
          }
        }

        // Abort guard: if the client disconnected during URL reads, do not call
        // the model and do not persist any assistant message.
        if (abortController.signal.aborted) return;

        // 2. Compose the user content for the LLM. The persisted user message
        // stays unchanged; only the LLM-facing copy gets the untrusted material
        // appended.
        const llmUserContent = externalContext
          ? `${trimmedUserMessage}\n\n${externalContext}`
          : trimmedUserMessage;

        // 3. Dispatch by protocol. Web Search is enabled only for OpenAI
        // Responses providers, and only when the session switch is on. A
        // Chat Completions provider with the switch on gets a single
        // web_search_unavailable notice and continues without search.
        const isResponses = provider.protocol === "openai_responses";
        const wantsWebSearch = webSearchEnabled;
        if (!isResponses && wantsWebSearch) {
          sendEvent({ type: "web_search_unavailable" });
        }

        for await (const part of streamModelChat({
          apiBaseUrl: provider.apiBaseUrl,
          apiUrlMode: provider.apiUrlMode,
          apiKey: provider.apiKey,
          model: body.model!,
          protocol: provider.protocol,
          reasoningEffort,
          webSearchEnabled: isResponses ? wantsWebSearch : false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: llmUserContent },
          ],
          signal: abortController.signal,
        })) {
          if (part.type === "reasoning") {
            assistantReasoningContent += part.content;
            sendEvent({ type: "reasoning", content: part.content });
            continue;
          }
          if (part.type === "source") {
            adapterSources.push(part.source);
            sendEvent({ type: "source", source: part.source });
            continue;
          }
          assistantContent += part.content;
          sendEvent({ type: "token", content: part.content });
        }

        // 4. Persist assistant message with deduped sources (provided URL
        // reads first, then adapter-sourced citations).
        const sources = dedupeExternalSources([...providedSources, ...adapterSources]);
        await projectStore.appendChatMessage(projectId, nodeId, {
          id: randomUUID(),
          role: "assistant",
          content: assistantContent,
          ...(assistantReasoningContent ? { reasoningContent: assistantReasoningContent } : {}),
          ...(sources.length ? { sources } : {}),
          createdAt: new Date().toISOString(),
        }, sessionId);

        // 5. Emit markdown_check_start
        sendEvent({ type: "markdown_check_start" });

        // 6. Call judgeNodeFacts to decide if patches are needed
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

        // If the client disconnected during the judge call, do not emit.
        if (abortController.signal.aborted) return;

        // 7. Branch on result
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

        // 8. Emit done with sessionId only (no updatedNode)
        sendEvent({ type: "done", sessionId });
      } catch (error) {
        if (assistantContent || assistantReasoningContent) {
          const sources = dedupeExternalSources([...providedSources, ...adapterSources]);
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
          return; // let finally close
        }

        const message = error instanceof Error ? error.message : "LLM 请求失败";
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