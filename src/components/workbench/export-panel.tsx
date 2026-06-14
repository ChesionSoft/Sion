"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ExportPanel({ projectId }: { projectId: string }) {
  const [message, setMessage] = useState("");

  async function exportDocuments() {
    const response = await fetch(`/api/projects/${projectId}/exports`, { method: "POST" });
    if (!response.ok) {
      setMessage("导出失败");
      return;
    }
    setMessage("已生成导出文件");
  }

  return (
    <div className="flex items-center gap-3">
      {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
      <Button onClick={exportDocuments} type="button" variant="outline">
        <DownloadIcon data-icon="inline-start" />
        导出文档
      </Button>
    </div>
  );
}
