import { NextResponse } from "next/server";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";
import type { NodeStatus } from "@/lib/project/types";

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; nodeId: string }> }) {
  const { projectId, nodeId } = await context.params;
  const store = new ProjectStore();

  if (!isWorkflowNodeId(nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const body = (await request.json()) as {
    markdown?: string;
    status?: NodeStatus;
  };

  const node = await store.updateProjectNode(projectId, nodeId, {
    markdown: body.markdown,
    status: body.status,
  });

  return NextResponse.json({ node });
}
