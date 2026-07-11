"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, DownloadIcon, FileIcon, RefreshCwIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "./markdown-content";
import { ModelPicker } from "./model-picker";
import { EXPORT_FILENAMES, type ExportFileInfo } from "@/lib/project/export-files";
import type { ModelProvider, ReasoningEffort } from "@/lib/project/types";

type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "md"; filename: string; markdown: string }
  | { kind: "docx"; filename: string; html: string };

export function ExportCenter({
  projectId,
  projectName,
  initialFiles,
}: {
  projectId: string;
  projectName: string;
  initialFiles: ExportFileInfo[];
}) {
  const [files, setFiles] = useState<ExportFileInfo[]>(initialFiles);
  const [selected, setSelected] = useState<string | null>(initialFiles[0]?.filename ?? null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState("");

  // Load model providers + pick the default (same as the chat panel).
  useEffect(() => {
    fetch("/api/settings/model-providers")
      .then((r) => r.json())
      .then((d: { providers: ModelProvider[] }) => {
        setProviders(d.providers);
        const def = d.providers.find((p) => p.isDefault);
        if (def) {
          setProviderId(def.id);
          setModel(def.models.find((m) => m.isDefault)?.name ?? def.models[0]?.name ?? "");
        }
      })
      .catch(() => setMessage("读取模型配置失败"));
  }, []);

  const loadPreview = useCallback(
    async (filename: string | null) => {
      if (!filename) {
        setPreview({ kind: "error", message: "还没有交付文档" });
        return;
      }
      setPreview({ kind: "loading" });
      try {
        const base = `/api/projects/${projectId}/exports/${encodeURIComponent(filename)}`;
        if (filename.endsWith(".docx")) {
          const res = await fetch(`${base}?as=html`);
          if (!res.ok) throw new Error("docx 预览失败");
          const { html } = (await res.json()) as { html?: string };
          if (!html) throw new Error("docx 预览失败");
          setPreview({ kind: "docx", filename, html });
        } else {
          const res = await fetch(base);
          if (!res.ok) throw new Error("文件尚未生成");
          const markdown = await res.text();
          setPreview({ kind: "md", filename, markdown });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "预览失败";
        setPreview({
          kind: "error",
          message: reason === "文件尚未生成" ? "该文件尚未生成,点重新生成" : reason,
        });
      }
    },
    [projectId],
  );

  useEffect(() => {
    void loadPreview(selected);
  }, [selected, loadPreview]);

  async function refreshList() {
    const res = await fetch(`/api/projects/${projectId}/exports`);
    if (!res.ok) return;
    const { files: list } = (await res.json()) as { files: ExportFileInfo[] };
    setFiles(list);
    setSelected(list[0]?.filename ?? null);
  }

  async function generate() {
    if (!providerId || !model || generating) return;
    setGenerating(true);
    setMessage("正在综合整理并生成文档…");
    try {
      const res = await fetch(`/api/projects/${projectId}/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, model, reasoningEffort }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage(data.error || "综合整理失败,请重试");
        return;
      }
      setMessage("已生成交付文档");
      await refreshList();
    } catch {
      setMessage("综合整理失败,请重试");
    } finally {
      setGenerating(false);
    }
  }

  const hasFiles = files.length > 0;
  const lastMtime = files.reduce((max, f) => Math.max(max, f.mtime), 0);
  const canGenerate = Boolean(providerId && model) && !generating;

  return (
    <main className="flex h-screen min-h-[720px] flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            href={`/projects/${projectId}`}
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
            返回工作台
          </Link>
          <h1 className="truncate text-base font-semibold leading-tight">{projectName}</h1>
          <span className="text-xs text-muted-foreground">导出中心</span>
        </div>
        <div className="flex items-center gap-2">
          <ModelPicker
            providers={providers}
            providerId={providerId}
            model={model}
            reasoningEffort={reasoningEffort}
            onProviderIdChange={setProviderId}
            onModelChange={setModel}
            onReasoningEffortChange={setReasoningEffort}
            placement="bottom"
          />
          <Button disabled={!canGenerate} onClick={generate} size="sm" type="button" variant="outline">
            <RefreshCwIcon data-icon="inline-start" className={generating ? "animate-spin" : ""} />
            {generating ? "生成中…" : hasFiles ? "重新生成" : "生成交付文档"}
          </Button>
        </div>
      </header>

      {message ? (
        <div className="border-b bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">{message}</div>
      ) : null}

      <section className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] overflow-hidden">
        <aside className="overflow-y-auto border-r p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">交付产物</p>
          <ul className="space-y-1">
            {EXPORT_FILENAMES.map((name) => {
              const exists = files.some((f) => f.filename === name);
              const active = selected === name;
              return (
                <li key={name}>
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      active
                        ? "bg-primary/10 text-foreground"
                        : exists
                          ? "hover:bg-muted"
                          : "text-muted-foreground/50",
                    )}
                    disabled={!exists}
                    onClick={() => setSelected(name)}
                    type="button"
                  >
                    <FileIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {hasFiles ? (
            <p className="mt-3 text-xs text-muted-foreground">
              上次生成
              <br />
              {new Date(lastMtime).toLocaleString()}
            </p>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">尚未生成任何产物</p>
          )}
        </aside>

        <div className="flex min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between border-b px-4">
            <span className="truncate text-sm font-medium">{selected ?? "-"}</span>
            {selected ? (
              <a
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-xs")}
                download={selected}
                href={`/api/projects/${projectId}/exports/${encodeURIComponent(selected)}?download=1`}
              >
                <DownloadIcon data-icon="inline-start" />
                下载
              </a>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {preview.kind === "loading" ? (
              <div className="p-8 text-sm text-muted-foreground">加载预览…</div>
            ) : preview.kind === "error" ? (
              <div className="p-8 text-sm text-muted-foreground">{preview.message}</div>
            ) : preview.kind === "docx" ? (
              <div className="p-4">
                <div className="mb-3 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
                  内容预览(mammoth HTML)。Word 排版(封面/目录/页眉页脚/分页)请下载 .docx 查看。
                </div>
                <div
                  className="markdown-content markdown-document"
                  dangerouslySetInnerHTML={{ __html: preview.html }}
                />
              </div>
            ) : (
              <div className="p-4">
                <MarkdownContent markdown={preview.markdown} variant="document" />
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
