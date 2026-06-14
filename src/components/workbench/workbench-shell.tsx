"use client";

import { useMemo, useState } from "react";
import { WORKFLOW_NODES } from "@/lib/project/nodes";
import type { Project, ProjectNode, WorkflowNodeId } from "@/lib/project/types";
import { ChatPanel } from "./chat-panel";
import { ExportPanel } from "./export-panel";
import { MarkdownPanel } from "./markdown-panel";
import { NodeSidebar } from "./node-sidebar";

export function WorkbenchShell({ project, nodes }: { project: Project; nodes: ProjectNode[] }) {
  const [activeNodeId, setActiveNodeId] = useState<WorkflowNodeId>(nodes[0]?.id ?? "basic-info");
  const [draftNodes, setDraftNodes] = useState<ProjectNode[]>(nodes);

  const activeNode = useMemo(
    () => draftNodes.find((node) => node.id === activeNodeId) ?? draftNodes[0],
    [activeNodeId, draftNodes],
  );

  function updateActiveMarkdown(markdown: string) {
    setDraftNodes((current) =>
      current.map((node) => (node.id === activeNodeId ? { ...node, markdown, status: "draft" } : node)),
    );
  }

  if (!activeNode) {
    return null;
  }

  return (
    <main className="flex h-screen min-h-[720px] flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{project.name}</h1>
          <p className="text-xs text-muted-foreground">本地项目设计文档工作台</p>
        </div>
        <ExportPanel projectId={project.id} />
      </header>
      <section className="grid min-h-0 flex-1 grid-cols-[280px_minmax(360px,0.9fr)_minmax(420px,1.1fr)]">
        <NodeSidebar activeNodeId={activeNodeId} definitions={WORKFLOW_NODES} nodes={draftNodes} onSelect={setActiveNodeId} />
        <ChatPanel activeNode={activeNode} projectId={project.id} />
        <MarkdownPanel node={activeNode} onChange={updateActiveMarkdown} />
      </section>
    </main>
  );
}
