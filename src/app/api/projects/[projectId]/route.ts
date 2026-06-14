import { NextResponse } from "next/server";
import { ProjectStore } from "@/lib/project/store";

const store = new ProjectStore();

export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const project = await store.getProject(projectId);

  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const nodes = await store.getProjectNodes(projectId);
  return NextResponse.json({ project, nodes });
}
