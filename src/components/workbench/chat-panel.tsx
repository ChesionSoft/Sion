"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, FileIcon, PaperclipIcon, PlusIcon, SendIcon, StopCircleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChatMessage, ChatSession, ModelProvider, ProjectFile, ProjectNode, ReasoningEffort } from "@/lib/project/types";

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
];

export function ChatPanel({ activeNode, projectId }: { activeNode: ProjectNode; projectId: string }) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSubmenuOpen, setModelSubmenuOpen] = useState(false);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [filePopoverOpen, setFilePopoverOpen] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const filePopoverRef = useRef<HTMLDivElement>(null);

  async function loadSessionMessages(sessionId: string) {
    const response = await fetch(
      `/api/projects/${projectId}/chat/sessions/${sessionId}?nodeId=${activeNode.id}`,
    );
    const data = (await response.json()) as { messages?: ChatMessage[]; error?: string };

    if (!response.ok) {
      setError(data.error ?? "读取会话失败");
      return;
    }

    setMessages(data.messages ?? []);
  }

  async function createSession() {
    setError("");
    const response = await fetch(`/api/projects/${projectId}/chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: activeNode.id }),
    });
    const data = (await response.json()) as { session?: ChatSession; error?: string };

    if (!response.ok || !data.session) {
      setError(data.error ?? "创建会话失败");
      return;
    }

    setSessions((current) => [data.session as ChatSession, ...current].slice(0, 10));
    setActiveSessionId(data.session.id);
    setMessages([]);
  }

  useEffect(() => {
    fetch("/api/settings/model-providers")
      .then((r) => r.json())
      .then((d: { providers: ModelProvider[] }) => {
        setProviders(d.providers);
        const def = d.providers.find((p) => p.isDefault);
        if (def) {
          setSelectedProviderId(def.id);
          const defaultModelName = def.models.find((m) => m.isDefault)?.name ?? def.models[0]?.name ?? "";
          setSelectedModel(defaultModelName);
        }
      })
      .catch(() => setError("读取模型配置失败"));
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!modelMenuRef.current?.contains(event.target as Node)) {
        setModelMenuOpen(false);
        setModelSubmenuOpen(false);
      }
      if (!filePopoverRef.current?.contains(event.target as Node)) {
        setFilePopoverOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setModelMenuOpen(false);
        setModelSubmenuOpen(false);
        setFilePopoverOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/files`)
      .then((r) => r.json())
      .then((d: { files: ProjectFile[] }) => setProjectFiles(d.files))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/projects/${projectId}/chat/sessions?nodeId=${activeNode.id}`)
      .then(async (response) => {
        const data = (await response.json()) as { sessions?: ChatSession[]; error?: string };
        return { data, ok: response.ok };
      })
      .then(({ data, ok }) => {
        if (cancelled) return;

        if (!ok) {
          setError(data.error ?? "读取会话失败");
          setSessions([]);
          setActiveSessionId("");
          setMessages([]);
          return;
        }

        if (data.sessions?.length) {
          setSessions(data.sessions);
          setActiveSessionId(data.sessions[0].id);
          loadSessionMessages(data.sessions[0].id);
          return;
        }

        createSession();
      })
      .catch(() => {
        if (!cancelled) setError("读取会话失败");
      });

    return () => {
      cancelled = true;
    };
    // createSession/loadSessionMessages intentionally use current node state for this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, activeNode.id]);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const selectedReasoning = REASONING_OPTIONS.find((option) => option.value === reasoningEffort) ?? REASONING_OPTIONS[1];
  const selectedFiles = projectFiles.filter((f) => selectedFileIds.includes(f.id));

  function selectModel(provider: ModelProvider, model: string) {
    setSelectedProviderId(provider.id);
    setSelectedModel(model);
    setModelMenuOpen(false);
    setModelSubmenuOpen(false);
  }

  function toggleFile(fileId: string) {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId],
    );
  }

  async function sendMessage() {
    if (!message.trim() || sending) return;
    setError("");

    const userContent = message.trim();

    // Show user message immediately and clear input
    const userMessageId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: "user" as const, content: userContent, createdAt: new Date().toISOString() },
    ]);
    setMessage("");

    setSending(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: activeNode.id,
          message: userContent,
          providerId: selectedProviderId,
          model: selectedModel,
          reasoningEffort,
          fileIds: selectedFileIds,
          sessionId: activeSessionId || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "发送失败");
        return;
      }

      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant" as const, content: "", createdAt: new Date().toISOString() },
      ]);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);

          try {
            const event = JSON.parse(payload) as {
              type: string;
              content?: string;
              sessionId?: string;
              error?: string;
            };

            if (event.type === "reasoning" && event.content) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, reasoningContent: `${m.reasoningContent ?? ""}${event.content}` }
                    : m,
                ),
              );
            } else if (event.type === "token" && event.content) {
              fullContent += event.content;
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m)),
              );
            } else if (event.type === "done" && event.sessionId) {
              setActiveSessionId(event.sessionId);
              setSessions((current) =>
                current.map((session) =>
                  session.id === event.sessionId
                    ? { ...session, messageCount: session.messageCount + 2, updatedAt: new Date().toISOString() }
                    : session,
                ),
              );
            } else if (event.type === "error" && event.error) {
              setError(event.error);
            }
          } catch {
            // skip malformed events
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setError("请求失败，请检查网络连接");
    } finally {
      setSending(false);
      abortControllerRef.current = null;
    }
  }

  function abortSendMessage() {
    abortControllerRef.current?.abort();
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const viewport = scrollRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [messages]);

  return (
    <section className="flex min-h-0 flex-col border-r">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">节点 Agent</p>
          <h2 className="truncate text-sm font-semibold">{activeNode.id}</h2>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`chat-session-${activeNode.id}`}>
            会话
          </label>
          <select
            className="h-8 max-w-44 rounded-md border bg-background px-2 text-xs"
            id={`chat-session-${activeNode.id}`}
            onChange={(event) => {
              const nextSessionId = event.target.value;
              setActiveSessionId(nextSessionId);
              loadSessionMessages(nextSessionId);
            }}
            value={activeSessionId}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} · {session.messageCount} 条
              </option>
            ))}
          </select>
          <Button onClick={createSession} size="sm" type="button" variant="outline">
            <PlusIcon data-icon="inline-start" />
            新会话
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
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
                  {msg.reasoningContent ? (
                    <details className="mb-2 rounded-md border bg-background/60 px-2 py-1.5" open>
                      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                        思考过程
                      </summary>
                      <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                        {msg.reasoningContent}
                      </div>
                    </details>
                  ) : null}
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="flex flex-col rounded-lg border">
          <Textarea
            className="min-h-28 resize-none border-0 shadow-none focus-visible:ring-0"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder="和当前节点 Agent 讨论... (Enter 发送，Shift+Enter 换行)"
            value={message}
          />
          {error ? <p className="px-3 py-1 text-sm text-destructive">{error}</p> : null}
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1" ref={filePopoverRef}>
              <button
                className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted"
                onClick={() => setFilePopoverOpen((open) => !open)}
                title="添加文件附件"
                type="button"
              >
                <PaperclipIcon className="h-4 w-4" />
              </button>
              {selectedFiles.map((file) => (
                <span
                  key={file.id}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs"
                >
                  <FileIcon className="h-3 w-3" />
                  {file.originalName}
                  <button
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => toggleFile(file.id)}
                    type="button"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {filePopoverOpen ? (
                <div className="absolute bottom-10 left-0 z-30 w-56 rounded-xl border bg-popover p-1.5 shadow-xl">
                  {projectFiles.filter((f) => f.status === "available").length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">暂无可添加的文件</p>
                  ) : (
                    projectFiles
                      .filter((f) => f.status === "available")
                      .map((file) => (
                        <label
                          key={file.id}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
                        >
                          <input
                            checked={selectedFileIds.includes(file.id)}
                            onChange={() => toggleFile(file.id)}
                            type="checkbox"
                          />
                          <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate flex-1">{file.originalName}</span>
                          {file.characterCount ? (
                            <span className="text-xs text-muted-foreground shrink-0">
                              {file.characterCount > 50000 ? "⚠️ " : ""}
                              {file.characterCount.toLocaleString()}字
                            </span>
                          ) : null}
                        </label>
                      ))
                  )}
                </div>
              ) : null}
            </div>
            <div className="relative flex shrink-0 items-center gap-2" ref={modelMenuRef}>
              {providers.length > 0 ? (
                <>
                  <button
                    aria-label={`模型 ${selectedModel || selectedProvider?.models.find((m) => m.isDefault)?.name || selectedProvider?.models[0]?.name || "未选择"}，推理 ${selectedReasoning.label}`}
                    aria-expanded={modelMenuOpen}
                    aria-haspopup="menu"
                    className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border bg-background px-3 text-xs font-medium shadow-sm transition hover:bg-muted/60"
                    onClick={() => {
                      setModelMenuOpen((open) => !open);
                      setModelSubmenuOpen(false);
                    }}
                    type="button"
                  >
                    <span className="truncate">{selectedModel || selectedProvider?.models.find((m) => m.isDefault)?.name || selectedProvider?.models[0]?.name || "选择模型"}</span>
                    <span className="text-muted-foreground">{selectedReasoning.label}</span>
                    <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>

                  {modelMenuOpen ? (
                    <div className="absolute bottom-10 right-0 z-30 w-52 rounded-xl border bg-popover p-1.5 text-sm shadow-xl">
                      <p className="px-2 py-1 text-xs text-muted-foreground">推理</p>
                      {REASONING_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          className="flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-sm hover:bg-muted"
                          onClick={() => setReasoningEffort(option.value)}
                          type="button"
                        >
                          <span>{option.label}</span>
                          {reasoningEffort === option.value ? <CheckIcon className="h-4 w-4" /> : null}
                        </button>
                      ))}

                      <div className="my-1 h-px bg-border" />

                      <button
                        className={cn(
                          "flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-sm hover:bg-muted",
                          modelSubmenuOpen && "bg-muted",
                        )}
                        onClick={() => setModelSubmenuOpen((open) => !open)}
                        onMouseEnter={() => setModelSubmenuOpen(true)}
                        type="button"
                      >
                        <span className="truncate">{selectedModel || "模型"}</span>
                        <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
                      </button>

                      {modelSubmenuOpen ? (
                        <div className="absolute bottom-0 left-[calc(100%+6px)] z-40 max-h-72 w-56 overflow-auto rounded-xl border bg-popover p-1.5 shadow-xl">
                          <p className="px-2 py-1 text-xs text-muted-foreground">模型</p>
                          {providers.map((provider) => (
                            <div key={provider.id}>
                              {providers.length > 1 ? (
                                <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                                  {provider.name}
                                </p>
                              ) : null}
                              {provider.models.map((model) => {
                                const active = provider.id === selectedProviderId && model.name === selectedModel;
                                return (
                                  <button
                                    key={`${provider.id}-${model.name}`}
                                    className="flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
                                    onClick={() => selectModel(provider, model.name)}
                                    type="button"
                                  >
                                    <span className="truncate">{model.name}</span>
                                    {active ? <CheckIcon className="h-4 w-4 shrink-0" /> : null}
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  暂无配置的模型提供商，请先在主菜单配置。
                </p>
              )}
              <Button
                className={sending ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
                disabled={!message.trim() || !selectedProviderId || !selectedModel || !activeSessionId}
                onClick={sending ? abortSendMessage : sendMessage}
                type="button"
              >
                {sending ? <StopCircleIcon data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
                {sending ? "中断" : "发送"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
