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
        <nav className="flex flex-col gap-0.5 p-2">
          {definitions.map((definition) => {
            const node = nodes.find((item) => item.id === definition.id);
            const active = definition.id === activeNodeId;

            return (
              <Button
                key={definition.id}
                className={cn(
                  "relative h-auto justify-start px-3 py-2.5 text-left",
                  active && "bg-muted font-medium"
                )}
                onClick={() => onSelect(definition.id)}
                type="button"
                variant="ghost"
              >
                {active ? (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-foreground" />
                ) : null}
                <span className="flex min-w-0 flex-1 items-start gap-2 pl-1">
                  <span className="mt-0.5 w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{definition.order}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{definition.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{definition.documentHeading}</span>
                  </span>
                  <Badge
                    className="shrink-0 px-1.5 py-0 text-[10px]"
                    variant={node?.status === "confirmed" ? "secondary" : "outline"}
                  >
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
