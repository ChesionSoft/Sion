import { NextResponse } from "next/server";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
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
  const sessions = await store.listSessions(projectId, nodeId);
  return NextResponse.json({ sessions });
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const body = (await request.json()) as { nodeId?: string };

  if (!body.nodeId || !isWorkflowNodeId(body.nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 400 });
  }

  const store = new ProjectStore();
  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  const session = await store.createSession(projectId, body.nodeId);
  return NextResponse.json({ session }, { status: 201 });
}
