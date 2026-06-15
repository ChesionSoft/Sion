import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AgentOverrideStore } from "@/lib/project/agent-overrides";
import { FileStore } from "@/lib/project/files";
import { callOpenAICompatibleChat } from "@/lib/project/llm";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";
import type { ReasoningEffort } from "@/lib/project/types";
import { ModelProviderStore } from "@/lib/settings/model-providers";

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
  const currentNode = nodes.find((node) => node.id === body.nodeId);

  if (!currentNode) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const contextMarkdown = nodes
    .filter((node) => node.id !== body.nodeId)
    .map((node) => node.markdown)
    .join("\n\n");

  // Load active agent rule (custom or default)
  const agentRuleContent = await agentStore.getActiveRuleContent(projectId, body.nodeId);

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

  // Attach selected file contents
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
    '- 所有假设必须写入“设计假设”，所有不确定项必须写入“待确认问题”。',
    "- 不要修改其他节点负责的章节。",
  );

  const systemPrompt = systemPromptParts.join("\n");

  let sessionId = body.sessionId;
  if (sessionId) {
    try {
      await projectStore.getChatMessages(projectId, body.nodeId, sessionId);
    } catch {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }
  } else {
    const session = await projectStore.createSession(projectId, body.nodeId);
    sessionId = session.id;
  }

  await projectStore.appendChatMessage(projectId, body.nodeId, {
    id: randomUUID(),
    role: "user",
    content: body.message.trim(),
    createdAt: new Date().toISOString(),
  }, sessionId);

  let assistantContent: string;
  try {
    assistantContent = await callOpenAICompatibleChat({
      apiBaseUrl: provider.apiBaseUrl,
      apiKey: provider.apiKey,
      model: body.model,
      reasoningEffort,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: body.message.trim() },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM 请求失败";
    if (message.includes("context") || message.includes("length") || message.includes("token")) {
      return NextResponse.json(
        { error: "上下文长度超出模型限制，请减少引用文件或选择更大上下文的模型。" },
        { status: 400 },
      );
    }
    if (message.includes("status 404")) {
      return NextResponse.json(
        { error: "API 端点不存在（404），请检查模型提供商的 API Base URL 是否正确。" },
        { status: 502 },
      );
    }
    if (message.includes("status 401") || message.includes("status 403")) {
      return NextResponse.json(
        { error: "API 认证失败，请检查模型提供商的 API Key 是否正确。" },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: `模型请求失败：${message}` }, { status: 502 });
  }

  const messages = await projectStore.appendChatMessage(projectId, body.nodeId, {
    id: randomUUID(),
    role: "assistant",
    content: assistantContent,
    createdAt: new Date().toISOString(),
  }, sessionId);

  return NextResponse.json({ messages, assistantContent, sessionId });
}
