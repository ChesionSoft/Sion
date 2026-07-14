import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { ProjectStore } from "@/lib/project/store";
import { isExportFilename } from "@/lib/project/export-files";
import { readStageState } from "@/lib/project/exports";

const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const DOCX_FILENAME = "项目开发设计文档.docx";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; filename: string }> },
) {
  const { projectId, filename } = await context.params;

  // Whitelist first - this is the security boundary that prevents path
  // traversal via the dynamic filename segment.
  if (!isExportFilename(filename)) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const store = new ProjectStore();
  // getProject calls assertSafeProjectId internally (and returns null for an
  // unsafe or missing id), so we 404 before touching the disk for the file.
  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const url = new URL(request.url);
  const asHtml = url.searchParams.get("as") === "html";
  const download = url.searchParams.get("download") === "1";
  const filePath = store.exportPath(projectId, filename);

  if (filename === DOCX_FILENAME) {
    const stage = await readStageState(store, projectId);
    if (stage.qaStatus !== "passed") {
      return NextResponse.json({ error: "正式 Word 尚未通过当前 DOCX 结构与内容校验" }, { status: 404 });
    }
  }

  if (asHtml) {
    if (filename !== DOCX_FILENAME) {
      return NextResponse.json({ error: "该文件不支持 HTML 预览" }, { status: 400 });
    }
    try {
      const buffer = await readFile(filePath);
      const mammoth = await import("mammoth");
      const { value: html } = await mammoth.convertToHtml({ buffer });
      return NextResponse.json({ html });
    } catch (error) {
      console.error("[exports] docx -> html failed:", error);
      return NextResponse.json({ error: "预览生成失败,请直接下载 .docx" }, { status: 500 });
    }
  }

  try {
    const buffer = await readFile(filePath);
    const headers: Record<string, string> = {
      "Content-Type": filename.endsWith(".md") ? MARKDOWN_TYPE : DOCX_TYPE,
    };
    if (download) {
      headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    return new NextResponse(buffer, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: "文件尚未生成" }, { status: 404 });
  }
}
