"use client";

import { useEffect, useRef, useState } from "react";
import { FileIcon, Trash2Icon, UploadIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { ProjectFile } from "@/lib/project/types";

const statusLabels: Record<ProjectFile["status"], string> = {
  available: "可读取",
  unsupported: "不支持",
  read_failed: "读取失败",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
          <DialogDescription>上传和管理项目文件，可读取的文件将作为模型上下文引用。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <input
              accept="*/*"
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
              {uploading ? "上传中..." : "上传文件"}
            </Button>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无文件。</p>
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
                        <Badge variant={file.status === "available" ? "secondary" : "outline"}>
                          {statusLabels[file.status]}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatSize(file.byteSize)}
                        {file.characterCount ? ` · ${file.characterCount.toLocaleString()} 字符` : ""}
                        {" · "}
                        {new Date(file.uploadedAt).toLocaleString("zh-CN")}
                      </p>
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
