import { notFound } from "next/navigation";
import { ProjectStore } from "@/lib/project/store";
import { ExportCenter } from "@/components/workbench/export-center";

export default async function ExportCenterPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const store = new ProjectStore();
  const project = await store.getProject(projectId);
  if (!project) {
    notFound();
  }
  const files = await store.listExports(projectId);
  return <ExportCenter projectId={project.id} projectName={project.name} initialFiles={files} />;
}
