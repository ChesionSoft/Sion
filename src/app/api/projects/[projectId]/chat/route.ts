import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AgentOverrideStore } from "@/lib/project/agent-overrides";
import { dedupeExternalSources } from "@/lib/project/external-source";
import { FileStore } from "@/lib/project/files";
import { buildDeliverySectionsList, parseDeliveryBlock, stripDeliveryBlock } from "@/lib/project/delivery-block";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";
import { stripToolCallLeakage } from "@/lib/project/tool-call-strip";
import { ModelProviderStore } from "@/lib/settings/model-providers";
import { BrowserSearchStore } from "@/lib/settings/browser-search";
import { getSharedBrowserManager } from "@/lib/project/browser-registry";
import { createBrowserWebService } from "@/lib/project/browser-web-service";
import { runWebOrchestrator, type WebOrchestratorEvent } from "@/lib/project/web-tool-orchestrator";
import { extractHttpUrls } from "@/lib/project/url-content";
import { aggregateTokenUsage } from "@/lib/project/token-usage";
import type { ModelConversationItem } from "@/lib/project/model-tools";
import type {
  AgentActivityStage,
  ChatMessage,
  ChatStreamEvent,
  ExternalSource,
  ModelCallUsage,
  ReasoningEffort,
  WorkflowNodeId,
} from "@/lib/project/types";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

// Cap how many prior turns are replayed so long sessions don't blow the model's
// context window. The most recent turns are kept; oldest are trimmed.
const MAX_HISTORY_MESSAGES = 40;

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

  const trimmedUserMessage = body.message.trim();

  // Direct URLs in the user message are always fetched through the browser
  // service, regardless of the search toggle. Extracted here so the system
  // prompt can tell the model the link content is provided below — otherwise
  // models that pattern-match on the raw link reply "I can't access links"
  // and ignore the fetched text.
  const directUrls = extractHttpUrls(trimmedUserMessage);

  const baseSystemPromptParts: string[] = [
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

  if (directUrls.length > 0) {
    baseSystemPromptParts.push(
      "",
      "## 链接读取说明",
      "",
      "- 用户消息中若包含链接，系统会自动抓取该链接的网页内容，并附在用户消息末尾、标注为「链接网页内容」。",
      "- 请直接基于已抓取的内容回答用户问题，不要回答「我无法访问链接」「我没有联网功能」或同类说辞。",
      "- 若消息中出现「链接读取失败」说明，请如实告知用户该链接暂无法读取，并基于已有信息继续，不要声称自己没有联网功能。",
    );
  }

  // File contents and the final "回复要求" section are appended inside the
  // stream so the reading_files activity is emitted before the file reads
  // actually occur.

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

  // Load prior turns BEFORE appending the current message so the current
  // message is delivered via `userMessage` and not duplicated in history.
  const priorMessages = await projectStore.getChatMessages(projectId, nodeId, sessionId);
  const history: ModelConversationItem[] = priorMessages
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.content.trim().length > 0))
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      type: "message" as const,
      role: m.role,
      // Keep the structured delivery block out of the model's replayed
      // history; it stays in the persisted message for the chat card.
      content: m.role === "assistant" ? stripDeliveryBlock(m.content) : m.content,
    }));

  await projectStore.appendChatMessage(projectId, nodeId, {
    id: randomUUID(),
    role: "user",
    content: trimmedUserMessage,
    createdAt: new Date().toISOString(),
  }, sessionId);

  // Tool capability is stored per model — never derived from protocol.
  const modelEntry = provider.models.find((m) => m.name === body.model);
  const toolCalling = !!modelEntry?.toolCalling;

  // Search engine preference (Google/Baidu) from browser-search settings.
  const browserSearchStore = new BrowserSearchStore();
  const preferences = await browserSearchStore.getPreferences();

  const browserService = createBrowserWebService({
    browserManager: await getSharedBrowserManager(),
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
      const sendActivity = (stage: Exclude<AgentActivityStage, "idle">, summary: string) => {
        sendEvent({ type: "activity", stage, summary, at: new Date().toISOString() });
      };

      // Whole-turn identity and usage collection shared by the orchestrator
      // and the fact judge.
      const turnId = randomUUID();
      const assistantMessageId = randomUUID();
      const turnStartedAt = Date.now();
      const usageCalls: ModelCallUsage[] = [];
      const onUsage = (usage: ModelCallUsage) => {
        usageCalls.push(usage);
      };

      let assistantContent = "";
      let assistantReasoningContent = "";
      const consumedSources: ExternalSource[] = [];
      let firstContentAt: number | null = null;
      let assistantPersisted = false;

      // Persist the authoritative assistant message exactly once across the
      // success, error, and abort paths. When `force` is false (error/abort),
      // a message with no content/reasoning is skipped. Returns the saved
      // message, or null when nothing was persisted.
      const persistAssistant = async (force: boolean): Promise<ChatMessage | null> => {
        if (assistantPersisted) return null;
        if (!force && !assistantContent && !assistantReasoningContent) return null;
        assistantPersisted = true;
        const reasoningDurationMs =
          firstContentAt != null ? firstContentAt - turnStartedAt : Date.now() - turnStartedAt;
        const sources = dedupeExternalSources(consumedSources);
        const usage = aggregateTokenUsage(turnId, usageCalls);
        const message: ChatMessage = {
          id: assistantMessageId,
          role: "assistant",
          content: assistantContent,
          ...(assistantReasoningContent ? { reasoningContent: assistantReasoningContent } : {}),
          ...(sources.length ? { sources } : {}),
          createdAt: new Date().toISOString(),
          turnId,
          reasoningDurationMs,
          ...(usage ? { usage } : {}),
        };
        await projectStore.appendChatMessage(projectId, nodeId, message, sessionId);
        return message;
      };

      try {
        sendActivity("thinking", "正在分析需求");

        // Read selected project files inside the stream so the reading_files
        // activity is emitted before the reads actually occur.
        if (body.fileIds?.length) {
          sendActivity("reading_files", "正在读取所选项目文件");
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
            baseSystemPromptParts.push("");
            baseSystemPromptParts.push(...fileContents);
          }
        }

        baseSystemPromptParts.push(
          "",
          "## 回复要求",
          "",
          "- 先回答用户问题，再给出建议写入 Markdown 的内容。",
          "- 如果信息不足，每轮最多提出 3 个关键问题；提问直接用普通 Markdown 文本写出问题和选项，禁止调用任何工具，禁止输出任何工具调用格式或包装符（例如 tool_name、parameters、tool_call 标签或模型私有的工具调用标记）。",
          "- 分析或检索得到的内容直接写进对应正文小节，不要单独留\"假设\"小节。",
          "- 不确定、需要用户确认的问题只在聊天里追问，绝不写进交付稿。",
          "- 不要修改其他节点负责的章节。",
          "",
          "## 交付稿写入",
          "",
          "回答完用户问题后，在回复最末尾输出一个 delivery 代码围栏块（用三个反引号开头并紧接 delivery、再以三个反引号结尾），块内只放一行 JSON，声明本轮要写入交付稿的内容。JSON 形如：",
          '{"changes":[{"sectionKey":"<sectionKey>","patchKind":"<append_bullet|append_block|append_table_row>","markdown":"<内容>"}]}',
          "- 只输出相对上方「当前节点 Markdown」的新增或更新项；无新增则块内输出 {\"changes\":[]}。",
          "- sectionKey 与 patchKind 必须来自下方可用 sections 列表；append_table_row 的管道分隔单元格数必须等于该 section 的 tableColumns 长度。",
          "- markdown 内容会原样进入交付稿，质量要与你会在正文里给的建议一致；不要包含标题行（# 开头）。",
          "- 可用 sections：",
          buildDeliverySectionsList(nodeId),
        );
        const systemPrompt = baseSystemPromptParts.join("\n");

        if (webSearchEnabled || directUrls.length > 0) {
          sendActivity("searching_web", "正在检索外部资料");
        }
        sendActivity("generating_answer", "正在生成回复");

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
          history,
          directUrls,
          searchEnabled: webSearchEnabled,
          engine: preferences.defaultEngine,
          projectId,
          sessionId,
          browserService,
          signal: abortController.signal,
          turnId,
          providerId: body.providerId!,
          onUsage,
        })) {
          for (const sse of mapOrchestratorEvent(e)) {
            if (sse.type === "token") {
              if (firstContentAt == null) firstContentAt = Date.now();
              assistantContent += sse.content;
            } else if (sse.type === "reasoning") {
              assistantReasoningContent += sse.content;
            } else if (sse.type === "source") {
              consumedSources.push(sse.source);
            }
            sendEvent(sse);
          }
        }

        if (abortController.signal.aborted) return;

        // Some MiniMax models leak proprietary tool-call wrappers into the
        // content channel over the OpenAI-compatible endpoint (the system
        // prompt tells the model not to emit them; this is the safety net).
        // Strip before persisting and before the judge sees the turn, so the
        // saved message and the draft-update decision are based on clean text.
        assistantContent = stripToolCallLeakage(assistantContent);
        if (assistantReasoningContent) {
          assistantReasoningContent = stripToolCallLeakage(assistantReasoningContent);
        }

        sendActivity("updating_document", "正在检查交付稿更新");
        sendEvent({ type: "markdown_check_start" });

        // The assistant declares its delivery-doc changes in a ```delivery
        // block at the end of the reply (see the system prompt). Parse it
        // straight into patches — no second model call, no re-translation.
        // stripToolCallLeakage already ran above, so MiniMax wrappers that
        // might wrap the block are gone before we parse.
        const patches = parseDeliveryBlock(assistantContent);

        if (abortController.signal.aborted) return;

        if (patches.length === 0) {
          sendEvent({ type: "markdown_unchanged" });
        } else {
          sendEvent({ type: "markdown_start", mode: "increment", baseRevision: currentNode.revision });
          for (const patch of patches) {
            sendEvent({ type: "markdown_patch_preview", patch });
          }
        }

        // Persist the authoritative assistant message after the delivery
        // block is parsed so the patch-preview events precede the final
        // message. The block stays in content so the chat card can render.
        const message = await persistAssistant(true);
        sendActivity("completed", "已完成");
        if (message) {
          sendEvent({ type: "done", sessionId, assistantMessage: message });
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          // Abort surfaced as a thrown error: persist partial without emitting.
          await persistAssistant(false);
          return;
        }

        const message = await persistAssistant(false);
        sendActivity("failed", "生成失败");

        const rawMessage = error instanceof Error ? error.message : "LLM 请求失败";
        const sanitized = rawMessage.replace(/(?:\/[\w.\-]+)+|[A-Za-z]:\\[^\s]*/g, "").slice(0, 200) || "请求失败";
        let errorMessage = `模型请求失败：${sanitized}`;
        if (sanitized.includes("context") || sanitized.includes("length") || sanitized.includes("token")) {
          errorMessage = "上下文长度超出模型限制，请减少引用文件或选择更大上下文的模型。";
        } else if (sanitized.includes("status 404")) {
          errorMessage = "API 端点不存在（404），请检查模型提供商的 API Base URL 是否正确。";
        } else if (sanitized.includes("status 401") || sanitized.includes("status 403")) {
          errorMessage = "API 认证失败，请检查模型提供商的 API Key 是否正确。";
        }

        sendEvent({ type: "error", error: errorMessage, ...(message ? { assistantMessage: message } : {}) });
      } finally {
        // Abort via a clean early return (no thrown error): persist partial
        // without enqueuing any further events after the request aborted.
        if (!assistantPersisted && (assistantContent || assistantReasoningContent)) {
          await persistAssistant(false);
        }
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