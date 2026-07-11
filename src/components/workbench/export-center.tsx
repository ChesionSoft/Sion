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

type QaIssue = { code: string; message: string; page?: number };
type QaReport = { passed: boolean; pageCount: number; issues: QaIssue[]; renderedAt: string };

type StageState = {
  blueprintDigest?: string;
  blueprintApprovedDigest?: string;
  draftDigest?: string;
  draftApprovedDigest?: string;
  qaStatus?: "passed" | "failed";
  qaReport?: QaReport;
  updatedAt: string;
};

type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "md"; filename: string; markdown: string }
  | { kind: "docx"; filename: string; html: string };

type Step = "blueprint" | "approve-blueprint" | "approve-draft" | "retry-draft" | "done";

function currentStep(stage: StageState | null): Step {
  const g = stage ?? { updatedAt: "" };
  const blueprintApproved = Boolean(g.blueprintDigest && g.blueprintApprovedDigest === g.blueprintDigest);
  if (!g.blueprintDigest) return "blueprint";
  if (!blueprintApproved || !g.draftDigest) return "approve-blueprint";
  if (g.qaStatus === "failed") return "retry-draft";
  if (g.qaStatus === "passed") return "done";
  return "approve-draft";
}

const PRIMARY_LABEL: Record<Step, string> = {
  blueprint: "生成导出蓝图",
  "approve-blueprint": "确认蓝图并生成正文",
  "approve-draft": "确认正文并生成正式 Word",
  "retry-draft": "重新生成正式正文",
  done: "",
};

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
  const [stage, setStage] = useState<StageState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

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
          message: reason === "文件尚未生成" ? "该文件尚未生成,请先生成" : reason,
        });
      }
    },
    [projectId],
  );

  useEffect(() => {
    queueMicrotask(() => {
      void loadPreview(selected);
    });
  }, [selected, loadPreview]);

  // Pull the staged state + file list, then auto-select the latest artifact.
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/exports`);
    if (!res.ok) return;
    const data = (await res.json()) as { files: ExportFileInfo[]; stage: StageState };
    setFiles(data.files);
    setStage(data.stage ?? { updatedAt: "" });
    setSelected(autoSelectFor(data.stage, data.files));
  }, [projectId]);

  useEffect(() => {
    // Deferred via queueMicrotask so setState (inside refresh) is not called
    // synchronously within the effect body (react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      void refresh();
    });
  }, [refresh]);

  const step = currentStep(stage);

  async function postJson(body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const res = await fetch(`/api/projects/${projectId}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  }

  async function runBlueprint() {
    if (!providerId || !model || busy) return;
    setBusy(true);
    setMessage("正在生成导出蓝图…");
    try {
      const { ok, data } = await postJson({ providerId, model, reasoningEffort, operation: "blueprint" });
      if (!ok) {
        setMessage((data.error as string) || "蓝图生成失败,请重试或更换模型");
        return;
      }
      setMessage("导出蓝图已生成。请审阅后确认。");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function approveBlueprintAndDraft() {
    if (!stage?.blueprintDigest || !providerId || !model || busy) return;
    setBusy(true);
    setMessage("正在确认蓝图并生成正文…");
    try {
      const approve = await postJson({
        providerId,
        model,
        reasoningEffort,
        operation: "approve_blueprint",
        artifactDigest: stage.blueprintDigest,
      });
      if (!approve.ok) {
        setMessage((approve.data.error as string) || "蓝图确认失败,请重新生成");
        return;
      }
      const draft = await postJson({ providerId, model, reasoningEffort, operation: "draft" });
      if (!draft.ok) {
        setMessage((draft.data.error as string) || "正文生成失败,请重试");
        return;
      }
      setMessage("正式正文已生成。请审阅后确认。");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function approveDraftAndFinalize() {
    if (!stage?.draftDigest || busy) return;
    setBusy(true);
    setMessage("正在生成正式 Word…");
    try {
      const approve = await postJson({
        operation: "approve_draft",
        artifactDigest: stage.draftDigest,
      });
      if (!approve.ok) {
        setMessage((approve.data.error as string) || "正文确认失败,请重新生成");
        return;
      }
      const finalize = await postJson({ operation: "finalize" });
      if (!finalize.ok) {
        const qa = finalize.data.qaReport as QaReport | undefined;
        if (qa && qa.issues.length > 0) {
          setMessage(`渲染质检未通过：${qa.issues[0].message}`);
        } else {
          setMessage((finalize.data.error as string) || "正式 Word 生成失败,请重试");
        }
        await refresh();
        return;
      }
      setMessage("正式 Word 已生成并通过渲染质检。");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function regenerateDraft() {
    if (!providerId || !model || busy) return;
    setBusy(true);
    setMessage("正在重新生成正式正文…");
    try {
      const draft = await postJson({ providerId, model, reasoningEffort, operation: "draft" });
      if (!draft.ok) {
        setMessage((draft.data.error as string) || "正文生成失败,请重试");
        return;
      }
      setMessage("正式正文已重新生成。请审阅后确认。");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const onPrimary =
    step === "blueprint"
      ? runBlueprint
      : step === "approve-blueprint"
        ? approveBlueprintAndDraft
        : step === "approve-draft"
          ? approveDraftAndFinalize
          : step === "retry-draft"
            ? regenerateDraft
          : null;

  const primaryLabel = PRIMARY_LABEL[step];
  const showModelPicker = step === "blueprint" || step === "approve-blueprint" || step === "retry-draft";
  const canPrimary =
    !!onPrimary &&
    !busy &&
    (step === "approve-draft" || Boolean(providerId && model));

  const qaFailed = stage?.qaStatus === "failed";
  const qaDone = stage?.qaStatus === "passed";

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
          {showModelPicker ? (
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
          ) : null}
          {onPrimary ? (
            <Button disabled={!canPrimary} onClick={onPrimary} size="sm" type="button" variant="outline">
              <RefreshCwIcon data-icon="inline-start" className={busy ? "animate-spin" : ""} />
              {busy ? "处理中…" : primaryLabel}
            </Button>
          ) : null}
        </div>
      </header>

      {message ? (
        <div className="border-b bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">{message}</div>
      ) : null}

      {step === "approve-blueprint" ? (
        <div className="border-b bg-blue-500/10 px-4 py-1.5 text-xs text-blue-700 dark:text-blue-300">
          确认导出蓝图仅锁定对外内容选择，不等于最终排版；确认后将生成正式正文供审阅。
        </div>
      ) : null}

      {qaFailed && stage?.qaReport ? (
        <div className="border-b bg-red-500/10 px-4 py-2 text-xs text-red-700 dark:text-red-300">
          <p className="font-medium">渲染质检未通过，正式 Word 暂不可下载。请调整正文后重新生成。</p>
          {stage.qaReport.issues.map((issue, i) => (
            <p key={i}>· [{issue.code}]{issue.page ? `（第 ${issue.page} 页）` : ""} {issue.message}</p>
          ))}
        </div>
      ) : null}

      {qaDone ? (
        <div className="border-b bg-emerald-500/10 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          正式 Word 已通过渲染质检，可下载。质检报告见侧栏“formal-prd-qa-report.md”。
        </div>
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
        </aside>

        <div className="flex min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between border-b px-4">
            <span className="truncate text-sm font-medium">{selected ?? "—"}</span>
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

function autoSelectFor(stage: StageState | null, files: ExportFileInfo[]): string | null {
  const g = stage ?? { updatedAt: "" };
  const exists = (name: string) => files.some((f) => f.filename === name);
  if (g.qaStatus === "failed") return null; // show the blocking QA banner instead
  if (g.qaStatus === "passed") {
    if (exists("项目开发设计文档.docx")) return "项目开发设计文档.docx";
    if (exists("formal-prd-qa-report.md")) return "formal-prd-qa-report.md";
  }
  if (g.draftDigest) return exists("formal-prd-draft.md") ? "formal-prd-draft.md" : null;
  if (g.blueprintDigest) return exists("export-blueprint.md") ? "export-blueprint.md" : null;
  return files[0]?.filename ?? null;
}
