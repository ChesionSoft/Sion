import { writeFile } from "node:fs/promises";
import { createProjectDesignDocx } from "./docx";
import { assembleProjectDesignMarkdown, createAgentsMarkdown, createSpecMarkdown, createTasksMarkdown } from "./markdown";
import type { ProjectStore } from "./store";

export type ExportedFile = {
  filename: string;
  path: string;
};

export type ExportProjectDocumentsResult = {
  files: ExportedFile[];
};

export async function exportProjectDocuments(store: ProjectStore, projectId: string): Promise<ExportProjectDocumentsResult> {
  const project = await store.getProject(projectId);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const nodes = await store.getProjectNodes(projectId);
  const projectDesign = assembleProjectDesignMarkdown(project, nodes);
  const spec = createSpecMarkdown(project, nodes);
  const tasks = createTasksMarkdown(project, nodes);
  const agents = createAgentsMarkdown(project);
  const docx = await createProjectDesignDocx(project, nodes);

  const files = [
    { filename: "PROJECT_DESIGN.md", content: projectDesign },
    { filename: "SPEC.md", content: spec },
    { filename: "TASKS.md", content: tasks },
    { filename: "AGENTS.md", content: agents },
  ];

  const exported: ExportedFile[] = [];

  await writeFile(store.exportPath(projectId, "PROJECT_DESIGN.md"), projectDesign, "utf8");
  exported.push({ filename: "PROJECT_DESIGN.md", path: store.exportPath(projectId, "PROJECT_DESIGN.md") });

  await writeFile(store.exportPath(projectId, "项目开发设计文档.docx"), docx);
  exported.push({ filename: "项目开发设计文档.docx", path: store.exportPath(projectId, "项目开发设计文档.docx") });

  for (const file of files.slice(1)) {
    await writeFile(store.exportPath(projectId, file.filename), file.content, "utf8");
    exported.push({ filename: file.filename, path: store.exportPath(projectId, file.filename) });
  }

  return { files: exported };
}
