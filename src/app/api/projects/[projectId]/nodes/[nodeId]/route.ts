import { NextResponse } from "next/server";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { NodeRevisionConflictError, ProjectStore } from "@/lib/project/store";

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
    expectedRevision?: number;
  };

  if (typeof body.markdown !== "string") {
    return NextResponse.json({ error: "缺少 markdown" }, { status: 400 });
  }

  if (typeof body.expectedRevision !== "number" || !Number.isFinite(body.expectedRevision)) {
    return NextResponse.json({ error: "缺少 expectedRevision" }, { status: 400 });
  }

  try {
    const node = await store.updateProjectNodeIfRevision(projectId, nodeId, body.expectedRevision, {
      markdown: body.markdown,
      status: "draft",
    });
    return NextResponse.json({ node });
  } catch (error) {
    if (error instanceof NodeRevisionConflictError) {
      return NextResponse.json(
        { error: "节点已被其他操作修改", latestNode: error.latestNode },
        { status: 409 },
      );
    }
    throw error;
  }
}
