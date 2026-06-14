"use client";

import { useState } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectNode } from "@/lib/project/types";

export function ChatPanel({ activeNode, projectId }: { activeNode: ProjectNode; projectId: string }) {
  const [message, setMessage] = useState("");

  return (
    <section className="flex min-h-0 flex-col border-r">
      <div className="border-b px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">节点 Agent</p>
        <h2 className="text-sm font-semibold">{activeNode.id}</h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-between gap-3 p-4">
        <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
          当前会话会围绕本节点内容推进。项目 ID：{projectId}
        </div>
        <div className="flex flex-col gap-2">
          <Textarea
            className="min-h-28 resize-none"
            onChange={(event) => setMessage(event.target.value)}
            placeholder="和当前节点 Agent 讨论..."
            value={message}
          />
          <Button className="self-end" disabled={!message.trim()} type="button">
            <SendIcon data-icon="inline-start" />
            发送
          </Button>
        </div>
      </div>
    </section>
  );
}
