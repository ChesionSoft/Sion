"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WORKFLOW_NODES } from "@/lib/project/nodes";
import type { Project, ProjectNode, WorkflowNodeId } from "@/lib/project/types";
import { ChatPanel } from "./chat-panel";
import { ExportPanel } from "./export-panel";
import { FilePoolDialog } from "./file-pool-dialog";
import { MarkdownPanel } from "./markdown-panel";
import { NodeSidebar } from "./node-sidebar";

export function WorkbenchShell({ project, nodes }: { project: Project; nodes: ProjectNode[] }) {
  const [activeNodeId, setActiveNodeId] = useState<WorkflowNodeId>(nodes[0]?.id ?? "basic-info");
  const [draftNodes, setDraftNodes] = useState<ProjectNode[]>(nodes);
  const [showFilePool, setShowFilePool] = useState(false);

  const activeNode = useMemo(
    () => draftNodes.find((node) => node.id === activeNodeId) ?? draftNodes[0],
    [activeNodeId, draftNodes],
  );

  function updateActiveMarkdown(markdown: string) {
    setDraftNodes((current) =>
      current.map((node) => (node.id === activeNodeId ? { ...node, markdown, status: "draft" } : node)),
    );
  }

  function updateNodeFromAgent(node: ProjectNode) {
    setDraftNodes((current) => current.map((item) => (item.id === node.id ? node : item)));
  }

  if (!activeNode) {
    return null;
  }

  return (
    <main className="flex h-screen min-h-[720px] flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4 bg-background">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            href="/"
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
            返回主菜单
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight">{project.name}</h1>
            <p className="text-xs text-muted-foreground">本地优先的项目设计文档工作台</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowFilePool(true)} size="sm" type="button" variant="outline">
            <FolderOpenIcon data-icon="inline-start" />
            项目文件池
          </Button>
          <ExportPanel projectId={project.id} />
        </div>
        <FilePoolDialog
          onClose={() => setShowFilePool(false)}
          open={showFilePool}
          projectId={project.id}
        />
      </header>
      <section className="grid min-h-0 flex-1 grid-cols-[280px_minmax(360px,0.9fr)_minmax(420px,1.1fr)]">
        <NodeSidebar activeNodeId={activeNodeId} definitions={WORKFLOW_NODES} nodes={draftNodes} onSelect={setActiveNodeId} />
        <ChatPanel activeNode={activeNode} key={activeNode.id} onNodeUpdated={updateNodeFromAgent} projectId={project.id} />
        <MarkdownPanel node={activeNode} onChange={updateActiveMarkdown} projectId={project.id} />
      </section>
    </main>
  );
}
