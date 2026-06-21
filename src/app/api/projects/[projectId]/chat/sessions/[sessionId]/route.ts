import { NextResponse } from "next/server";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";
import type { WorkflowNodeId } from "@/lib/project/types";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const { projectId, sessionId } = await context.params;
  const { searchParams } = new URL(request.url);
  const nodeId = searchParams.get("nodeId");

  if (!nodeId || !isWorkflowNodeId(nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 400 });
  }

  const store = new ProjectStore();
  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  try {
    const messages = await store.getChatMessages(projectId, nodeId, sessionId);
    return NextResponse.json({ messages, sessionId });
  } catch {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const { projectId, sessionId } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { nodeId?: string; webSearchEnabled?: unknown }
    | null;

  if (!body?.nodeId || !isWorkflowNodeId(body.nodeId) || typeof body.webSearchEnabled !== "boolean") {
    return NextResponse.json({ error: "会话设置无效" }, { status: 400 });
  }

  const store = new ProjectStore();
  if (!(await store.getProject(projectId))) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  try {
    const session = await store.updateSessionWebSearch(
      projectId,
      body.nodeId as WorkflowNodeId,
      sessionId,
      body.webSearchEnabled,
    );
    return NextResponse.json({ session });
  } catch {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const { projectId, sessionId } = await context.params;
  const store = new ProjectStore();
  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  try {
    await store.deleteSession(projectId, sessionId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }
}
