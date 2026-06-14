"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ProjectNode, WorkflowNodeDefinition, WorkflowNodeId } from "@/lib/project/types";

const statusLabels: Record<ProjectNode["status"], string> = {
  not_started: "未开始",
  draft: "草稿",
  generated: "已生成",
  confirmed: "已确认",
  needs_confirmation: "待确认",
};

export function NodeSidebar({
  activeNodeId,
  definitions,
  nodes,
  onSelect,
}: {
  activeNodeId: WorkflowNodeId;
  definitions: WorkflowNodeDefinition[];
  nodes: ProjectNode[];
  onSelect: (nodeId: WorkflowNodeId) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-r bg-muted/20">
      <div className="border-b px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">流程节点</p>
        <h2 className="text-sm font-semibold">12 节点设计路径</h2>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-1 p-2">
          {definitions.map((definition) => {
            const node = nodes.find((item) => item.id === definition.id);
            const active = definition.id === activeNodeId;

            return (
              <Button
                key={definition.id}
                className={cn("h-auto justify-start px-3 py-2 text-left", active && "bg-muted")}
                onClick={() => onSelect(definition.id)}
                type="button"
                variant="ghost"
              >
                <span className="flex min-w-0 flex-1 items-start gap-2">
                  <span className="mt-0.5 w-5 shrink-0 text-xs text-muted-foreground">{definition.order}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{definition.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{definition.documentHeading}</span>
                  </span>
                  <Badge variant={node?.status === "confirmed" ? "secondary" : "outline"}>
                    {statusLabels[node?.status ?? "not_started"]}
                  </Badge>
                </span>
              </Button>
            );
          })}
        </nav>
      </ScrollArea>
    </aside>
  );
}
