"use client";

import { useEffect, useRef, useState } from "react";
import { FileIcon, SendIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { ChatMessage, ModelProvider, ProjectFile, ProjectNode } from "@/lib/project/types";

export function ChatPanel({ activeNode, projectId }: { activeNode: ProjectNode; projectId: string }) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/settings/model-providers")
      .then((r) => r.json())
      .then((d: { providers: ModelProvider[] }) => {
        setProviders(d.providers);
        const def = d.providers.find((p) => p.isDefault);
        if (def) {
          setSelectedProviderId(def.id);
          setSelectedModel(def.defaultModel);
        }
      })
      .catch(() => setError("读取模型配置失败"));
  }, []);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/files`)
      .then((r) => r.json())
      .then((d: { files: ProjectFile[] }) => setProjectFiles(d.files))
      .catch(() => {});
  }, [projectId]);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const selectedFiles = projectFiles.filter((f) => selectedFileIds.includes(f.id));
  const readableFiles = selectedFiles.filter((f) => f.status === "available");

  function toggleFile(fileId: string) {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId],
    );
  }

  async function sendMessage() {
    if (!message.trim() || sending) return;
    setError("");
    setSending(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: activeNode.id,
          message: message.trim(),
          providerId: selectedProviderId,
          model: selectedModel,
          fileIds: selectedFileIds,
        }),
      });
      const data = (await res.json()) as {
        messages?: ChatMessage[];
        assistantContent?: string;
        error?: string;
      };

      if (!res.ok || !data.messages) {
        setError(data.error ?? "发送失败");
        return;
      }

      setMessages(data.messages);
      setMessage("");
    } catch {
      setError("请求失败，请检查网络连接");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <section className="flex min-h-0 flex-col border-r">
      <div className="border-b px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">节点 Agent</p>
        <h2 className="text-sm font-semibold">{activeNode.id}</h2>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* Model selector */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">模型选择</label>
          {providers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              暂无配置的模型提供商，请先在主菜单配置。
            </p>
          ) : (
            <div className="flex gap-2">
              <select
                className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs"
                onChange={(e) => {
                  setSelectedProviderId(e.target.value);
                  const p = providers.find((pr) => pr.id === e.target.value);
                  if (p) setSelectedModel(p.defaultModel);
                }}
                value={selectedProviderId}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {selectedProvider ? (
                <select
                  className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs"
                  onChange={(e) => setSelectedModel(e.target.value)}
                  value={selectedModel}
                >
                  {selectedProvider.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          )}
        </div>

        {/* File selector */}
        {projectFiles.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">引用文件</label>
            <div className="flex flex-wrap gap-1">
              {projectFiles.map((file) => {
                const selected = selectedFileIds.includes(file.id);
                const canAttach = file.status === "available";
                return (
                  <button
                    key={file.id}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
                      selected
                        ? "bg-primary/10 border-primary/30 text-primary"
                        : canAttach
                          ? "bg-background hover:bg-muted/50"
                          : "bg-background opacity-50 cursor-not-allowed"
                    }`}
                    disabled={!canAttach}
                    onClick={() => toggleFile(file.id)}
                    title={
                      !canAttach
                        ? "此文件不支持读取"
                        : file.characterCount && file.characterCount > 50000
                          ? `文件较大（${file.characterCount.toLocaleString()} 字符），可能消耗较多 Token`
                          : undefined
                    }
                    type="button"
                  >
                    <FileIcon className="h-3 w-3" />
                    {file.originalName}
                    {!canAttach ? (
                      <Badge className="text-[10px] px-1 py-0" variant="outline">
                        不支持
                      </Badge>
                    ) : null}
                    {selected ? <XIcon className="h-3 w-3" /> : null}
                  </button>
                );
              })}
            </div>
            {readableFiles.some(
              (f) => f.characterCount && f.characterCount > 50000,
            ) ? (
              <p className="text-xs text-amber-600">
                部分选中文件较大，可能消耗较多 Token 并增加响应时间。
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Chat messages */}
        <ScrollArea className="min-h-0 flex-1" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              当前会话会围绕本节点内容推进。项目 ID：{projectId}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`rounded-lg p-3 text-sm ${
                    msg.role === "user"
                      ? "bg-primary/10 ml-8"
                      : msg.role === "assistant"
                        ? "bg-muted/30 mr-8"
                        : "bg-muted/10 mx-4 text-xs"
                  }`}
                >
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    {msg.role === "user" ? "你" : msg.role === "assistant" ? "Agent" : "系统"}
                  </p>
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Error */}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {/* Input */}
        <div className="flex flex-col gap-2">
          <Textarea
            className="min-h-28 resize-none"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder="和当前节点 Agent 讨论... (Cmd+Enter 发送)"
            value={message}
          />
          <Button
            className="self-end"
            disabled={!message.trim() || sending || !selectedProviderId || !selectedModel}
            onClick={sendMessage}
            type="button"
          >
            <SendIcon data-icon="inline-start" />
            {sending ? "发送中..." : "发送"}
          </Button>
        </div>
      </div>
    </section>
  );
}
