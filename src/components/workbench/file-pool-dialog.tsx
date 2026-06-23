"use client";

import { useEffect, useRef, useState } from "react";
import { FileIcon, Trash2Icon, UploadIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { ProjectFile } from "@/lib/project/types";

const kindLabels: Record<NonNullable<ProjectFile["kind"]>, string> = {
  markdown: "Markdown",
  text: "文本",
  json: "JSON",
  csv: "表格",
  pdf: "PDF",
  word: "Word",
  excel: "Excel",
  unsupported: "未知",
};

function getStatusLabel(file: ProjectFile): string {
  const status = file.extractionStatus ?? (file.status === "available" ? "available" : file.status === "unsupported" ? "unsupported" : "failed");
  if (status === "available") return "可引用";
  if (status === "failed") return "解析失败";
  return "暂不支持";
}

function getKindLabel(file: ProjectFile): string {
  return file.kind ? kindLabels[file.kind] : file.extension.replace(".", "").toUpperCase() || "文件";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMeta(file: ProjectFile): string {
  const parts = [formatSize(file.byteSize)];
  if (file.characterCount) parts.push(`${file.characterCount.toLocaleString()} 字符`);
  if (file.pageCount) parts.push(`${file.pageCount.toLocaleString()} 页`);
  if (file.sheetCount) parts.push(`${file.sheetCount.toLocaleString()} 个工作表`);
  if (file.truncated) parts.push("已截断");
  parts.push(new Date(file.uploadedAt).toLocaleString("zh-CN"));
  return parts.join(" · ");
}

export function FilePoolDialog({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadFiles() {
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/files`);
      const data = (await res.json()) as { files: ProjectFile[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? "读取文件列表失败");
        return;
      }
      setFiles(data.files);
    } catch {
      setError("读取文件列表失败");
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setError("");
      try {
        const res = await fetch(`/api/projects/${projectId}/files`);
        const data = (await res.json()) as { files: ProjectFile[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "读取文件列表失败");
          return;
        }
        setFiles(data.files);
      } catch {
        if (!cancelled) setError("读取文件列表失败");
      }
    })();
    return () => { cancelled = true; };
  }, [open, projectId]);

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError("");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as { file?: ProjectFile; error?: string };
      if (!res.ok || !data.file) {
        setError(data.error ?? "上传失败");
        return;
      }
      await loadFiles();
    } catch {
      setError("上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(fileId: string) {
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "删除失败");
        return;
      }
      await loadFiles();
    } catch {
      setError("删除失败");
    }
  }

  return (
    <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>项目文件池</DialogTitle>
          <DialogDescription>
            上传项目资料。可解析的 PDF、DOCX、Excel、Markdown 和文本文件会在聊天时交给 Agent 阅读。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <input
              accept=".md,.markdown,.txt,.log,.json,.csv,.tsv,.pdf,.docx,.xlsx,.xls,.doc,text/markdown,text/plain,application/pdf"
              className="hidden"
              onChange={handleUpload}
              ref={fileInputRef}
              type="file"
            />
            <Button
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              type="button"
              variant="outline"
            >
              <UploadIcon data-icon="inline-start" />
              {uploading ? "正在读取文件..." : "上传项目资料"}
            </Button>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无文件。可以上传需求说明、会议纪要或补充资料，之后在聊天框里按需引用。
            </p>
          ) : (
            <ScrollArea className="max-h-80">
              <div className="flex flex-col gap-2">
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium">{file.originalName}</span>
                        <Badge variant="outline">{getKindLabel(file)}</Badge>
                        <Badge variant={file.status === "available" ? "secondary" : "outline"}>
                          {getStatusLabel(file)}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{formatMeta(file)}</p>
                      {file.extractionError ? (
                        <p className="text-xs text-muted-foreground">{file.extractionError}</p>
                      ) : null}
                    </div>
                    <Button
                      onClick={() => handleDelete(file.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon data-icon="inline-start" />
                      删除
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}

          <div className="flex justify-end">
            <Button onClick={onClose} type="button" variant="outline">
              <XIcon data-icon="inline-start" />
              关闭
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
