import { NextResponse } from "next/server";
import { FileStore } from "@/lib/project/files";
import { MAX_UPLOAD_BYTES } from "@/lib/project/file-extraction";
import { ProjectStore } from "@/lib/project/store";

export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const projectStore = new ProjectStore();
  const fileStore = new FileStore();
  const project = await projectStore.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  return NextResponse.json({ files: await fileStore.listFiles(projectId) });
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const projectStore = new ProjectStore();
  const fileStore = new FileStore();
  const project = await projectStore.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const formData = await request.formData();
  const fileEntry = formData.get("file");

  if (!fileEntry || !(fileEntry instanceof File)) {
    return NextResponse.json({ error: "请选择要上传的文件" }, { status: 400 });
  }

  if (fileEntry.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "文件不能超过 20 MB" }, { status: 413 });
  }

  const buffer = Buffer.from(await fileEntry.arrayBuffer());
  const record = await fileStore.uploadFile(projectId, {
    name: fileEntry.name,
    buffer,
    mimeType: fileEntry.type,
  });

  return NextResponse.json({ file: record }, { status: 201 });
}