"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReasoningEffort } from "@/lib/project/types";

export function ExportPanel({
  projectId,
  providerId,
  model,
  reasoningEffort,
}: {
  projectId: string;
  providerId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function exportDocuments() {
    if (!providerId || !model) {
      setMessage("请先在聊天面板选择模型");
      return;
    }
    setBusy(true);
    setMessage("正在综合整理并生成文档…");
    try {
      const response = await fetch(`/api/projects/${projectId}/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, model, reasoningEffort }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage(data.error || "导出失败,请重试");
        return;
      }
      setMessage("已生成 Word 文档和 AI 开发上下文包");
    } catch {
      setMessage("导出失败,请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
      <Button disabled={busy} onClick={exportDocuments} type="button" variant="outline">
        <DownloadIcon data-icon="inline-start" />
        {busy ? "生成中…" : "生成交付文档"}
      </Button>
    </div>
  );
}
