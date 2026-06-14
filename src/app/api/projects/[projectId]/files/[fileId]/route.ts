import { NextResponse } from "next/server";
import { FileStore } from "@/lib/project/files";
import { ProjectStore } from "@/lib/project/store";

const fileStore = new FileStore();
const projectStore = new ProjectStore();

export async function DELETE(_request: Request, context: { params: Promise<{ projectId: string; fileId: string }> }) {
  const { projectId, fileId } = await context.params;
  const project = await projectStore.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  try {
    await fileStore.deleteFile(projectId, fileId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "文件不存在") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
