import { notFound } from "next/navigation";
import { ProjectStore } from "@/lib/project/store";
import { WorkbenchShell } from "@/components/workbench/workbench-shell";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const store = new ProjectStore();
  const project = await store.getProject(projectId);

  if (!project) {
    notFound();
  }

  const nodes = await store.getProjectNodes(projectId);

  return <WorkbenchShell nodes={nodes} project={project} />;
}
