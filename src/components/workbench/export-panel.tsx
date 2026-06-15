"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ExportPanel({ projectId }: { projectId: string }) {
  const [message, setMessage] = useState("");

  async function exportDocuments() {
    const response = await fetch(`/api/projects/${projectId}/exports`, { method: "POST" });
    if (!response.ok) {
      setMessage("导出失败，请检查项目节点内容后重试");
      return;
    }
    setMessage("已生成 Word 文档和 AI 开发上下文包");
  }

  return (
    <div className="flex items-center gap-3">
      {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
      <Button onClick={exportDocuments} type="button" variant="outline">
        <DownloadIcon data-icon="inline-start" />
        生成交付文档
      </Button>
    </div>
  );
}
