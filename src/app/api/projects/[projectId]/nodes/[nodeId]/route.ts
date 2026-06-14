import { NextResponse } from "next/server";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";
import type { NodeStatus } from "@/lib/project/types";

const store = new ProjectStore();

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; nodeId: string }> }) {
  const { projectId, nodeId } = await context.params;

  if (!isWorkflowNodeId(nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const body = (await request.json()) as {
    markdown?: string;
    status?: NodeStatus;
    assumptions?: string[];
    openQuestions?: string[];
  };

  const node = await store.updateProjectNode(projectId, nodeId, {
    markdown: body.markdown,
    status: body.status,
    assumptions: body.assumptions,
    openQuestions: body.openQuestions,
  });

  return NextResponse.json({ node });
}
