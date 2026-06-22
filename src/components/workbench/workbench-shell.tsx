"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WORKFLOW_NODES } from "@/lib/project/nodes";
import type { Project, ProjectNode, WorkflowNodeId } from "@/lib/project/types";
import { ChatPanel } from "./chat-panel";
import { ExportPanel } from "./export-panel";
import { FilePoolDialog } from "./file-pool-dialog";
import { MarkdownPanel } from "./markdown-panel";
import { NodeSidebar } from "./node-sidebar";
import type { MarkdownGenerationState, SharedWorkbenchContext } from "./markdown-generation-types";

const INITIAL_GEN_STATE: MarkdownGenerationState = { phase: "idle" };

export function WorkbenchShell({ project, nodes }: { project: Project; nodes: ProjectNode[] }) {
  const [activeNodeId, setActiveNodeId] = useState<WorkflowNodeId>(nodes[0]?.id ?? "basic-info");
  const [draftNodes, setDraftNodes] = useState<ProjectNode[]>(nodes);
  const [showFilePool, setShowFilePool] = useState(false);
  const [genState, setGenState] = useState<MarkdownGenerationState>(INITIAL_GEN_STATE);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Shared context state (lifted from ChatPanel)
  const [activeSessionId, setActiveSessionId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high" | "xhigh">("medium");
  const [providers, setProviders] = useState<import("@/lib/project/types").ModelProvider[]>([]);

  const activeNode = useMemo(
    () => draftNodes.find((node) => node.id === activeNodeId) ?? draftNodes[0],
    [activeNodeId, draftNodes],
  );

  const sharedContext: SharedWorkbenchContext = {
    activeSessionId,
    setActiveSessionId: useCallback((id: string) => setActiveSessionId(id), []),
    providerId,
    setProviderId: useCallback((id: string) => setProviderId(id), []),
    model,
    setModel: useCallback((m: string) => setModel(m), []),
    reasoningEffort,
    setReasoningEffort: useCallback(
      (r: "low" | "medium" | "high" | "xhigh") => setReasoningEffort(r),
      [],
    ),
    providers,
    setProviders: useCallback((p: import("@/lib/project/types").ModelProvider[]) => setProviders(p), []),
  };

  function handleSelectNode(nodeId: WorkflowNodeId) {
    // Ignore selection during generation phases
    if (
      genState.phase === "checking" ||
      genState.phase === "previewing_increment" ||
      genState.phase === "submitting_increment" ||
      genState.phase === "previewing_rewrite"
    ) {
      return;
    }
    setActiveNodeId(nodeId);
  }

  function updateActiveMarkdown(markdown: string) {
    // Prevent user edits during animation/submit phases
    if (
      genState.phase === "previewing_increment" ||
      genState.phase === "submitting_increment" ||
      genState.phase === "previewing_rewrite"
    ) {
      return;
    }
    setDraftNodes((current) =>
      current.map((node) =>
        node.id === activeNodeId ? { ...node, markdown, status: "draft" } : node,
      ),
    );
  }

  function onSavedNode(node: ProjectNode) {
    setDraftNodes((current) =>
      current.map((item) => (item.id === node.id ? node : item)),
    );
  }

  if (!activeNode) {
    return null;
  }

  return (
    <main className="flex h-screen min-h-[720px] min-w-0 flex-col overflow-hidden bg-background text-foreground">
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
      <section
        className={cn(
          "grid min-h-0 min-w-0 flex-1 overflow-hidden",
          sidebarCollapsed
            ? "grid-cols-[64px_minmax(0,0.9fr)_minmax(0,1.1fr)]"
            : "grid-cols-[240px_minmax(0,0.9fr)_minmax(0,1.1fr)]",
        )}
      >
        <NodeSidebar
          activeNodeId={activeNodeId}
          definitions={WORKFLOW_NODES}
          nodes={draftNodes}
          onSelect={handleSelectNode}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
        />
        <ChatPanel
          activeNode={activeNode}
          key={activeNode.id}
          projectId={project.id}
          sharedContext={sharedContext}
          onGenStateChange={setGenState}
        />
        <MarkdownPanel
          node={activeNode}
          onChange={updateActiveMarkdown}
          onSavedNode={onSavedNode}
          projectId={project.id}
          genState={genState}
          setGenState={setGenState}
          sharedContext={{
            activeSessionId: sharedContext.activeSessionId,
            providerId: sharedContext.providerId,
            model: sharedContext.model,
            reasoningEffort: sharedContext.reasoningEffort,
            providers: sharedContext.providers,
          }}
        />
      </section>
    </main>
  );
}