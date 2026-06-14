import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { renderAgentSystemPrompt } from "@/lib/project/agents";
import { callOpenAICompatibleChat } from "@/lib/project/llm";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";

const store = new ProjectStore();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const body = (await request.json()) as {
    nodeId?: string;
    message?: string;
    apiBaseUrl?: string;
    apiKey?: string;
    model?: string;
  };

  if (!body.nodeId || !isWorkflowNodeId(body.nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 400 });
  }

  if (!body.message?.trim()) {
    return NextResponse.json({ error: "消息不能为空" }, { status: 400 });
  }

  if (!body.apiBaseUrl || !body.apiKey || !body.model) {
    return NextResponse.json({ error: "请先配置模型 API Base URL、API Key 和模型名称" }, { status: 400 });
  }

  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const nodes = await store.getProjectNodes(projectId);
  const currentNode = nodes.find((node) => node.id === body.nodeId);

  if (!currentNode) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const contextMarkdown = nodes
    .filter((node) => node.id !== body.nodeId)
    .map((node) => node.markdown)
    .join("\n\n");

  const systemPrompt = await renderAgentSystemPrompt({
    nodeId: body.nodeId,
    projectName: project.name,
    currentMarkdown: currentNode.markdown,
    contextMarkdown,
  });

  await store.appendChatMessage(projectId, body.nodeId, {
    id: randomUUID(),
    role: "user",
    content: body.message.trim(),
    createdAt: new Date().toISOString(),
  });

  const assistantContent = await callOpenAICompatibleChat({
    apiBaseUrl: body.apiBaseUrl,
    apiKey: body.apiKey,
    model: body.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: body.message.trim() },
    ],
  });

  const messages = await store.appendChatMessage(projectId, body.nodeId, {
    id: randomUUID(),
    role: "assistant",
    content: assistantContent,
    createdAt: new Date().toISOString(),
  });

  return NextResponse.json({ messages, assistantContent });
}
