"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  Globe2Icon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  StopCircleIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { WORKFLOW_NODES } from "@/lib/project/nodes";
import { aggregateUsageFromMessages } from "@/lib/project/token-usage";
import type {
  AgentActivityStage,
  ChatMessage,
  ChatSession,
  ExternalSource,
  ModelProvider,
  ProjectFile,
  ProjectNode,
  ReasoningEffort,
} from "@/lib/project/types";
import type { MarkdownGenerationState, SharedWorkbenchContext } from "./markdown-generation-types";
import { AgentActivity } from "./agent-activity";
import { ChatMessageView, type ChatMessageActivity } from "./chat-message";
import { TokenUsageDetails } from "./token-usage-details";

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
];

type StreamingTextBufferState = {
  content: string;
  reasoningContent: string;
};

type StreamingTextBufferOptions = {
  intervalMs?: number;
  minChunkSize?: number;
  maxChunkSize?: number;
};

type PendingVerification = {
  verificationId: string;
  engine: string;
  originalMessage: string;
  status: "required" | "opening" | "opened" | "error";
};

export function createStreamingTextBuffer(
  onUpdate: (state: StreamingTextBufferState) => void,
  options: StreamingTextBufferOptions = {},
) {
  const intervalMs = options.intervalMs ?? 18;
  const minChunkSize = options.minChunkSize ?? 2;
  const maxChunkSize = options.maxChunkSize ?? 14;
  let pendingContent = "";
  let pendingReasoning = "";
  let visibleContent = "";
  let visibleReasoning = "";
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let idleResolvers: Array<() => void> = [];

  function resolveIdleIfNeeded() {
    if (timerId !== null || pendingContent || pendingReasoning) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }

  function nextChunkSize(length: number) {
    if (length <= minChunkSize) return length;
    return Math.min(maxChunkSize, Math.max(minChunkSize, Math.ceil(length / 12)));
  }

  function emitNextChunk() {
    timerId = null;

    if (pendingReasoning) {
      const size = nextChunkSize(pendingReasoning.length);
      visibleReasoning += pendingReasoning.slice(0, size);
      pendingReasoning = pendingReasoning.slice(size);
    } else if (pendingContent) {
      const size = nextChunkSize(pendingContent.length);
      visibleContent += pendingContent.slice(0, size);
      pendingContent = pendingContent.slice(size);
    }

    onUpdate({ content: visibleContent, reasoningContent: visibleReasoning });

    if (pendingReasoning || pendingContent) {
      schedule();
      return;
    }

    resolveIdleIfNeeded();
  }

  function schedule() {
    if (timerId !== null) return;
    timerId = setTimeout(emitNextChunk, intervalMs);
  }

  return {
    push(type: "content" | "reasoning", chunk: string) {
      if (!chunk) return;
      if (type === "reasoning") {
        pendingReasoning += chunk;
      } else {
        pendingContent += chunk;
      }
      schedule();
    },
    waitUntilIdle() {
      if (timerId === null && !pendingContent && !pendingReasoning) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => idleResolvers.push(resolve));
    },
    stop() {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      pendingContent = "";
      pendingReasoning = "";
      resolveIdleIfNeeded();
    },
  };
}

export function ChatPanel({
  activeNode,
  projectId,
  sharedContext,
  onGenStateChange,
}: {
  activeNode: ProjectNode;
  projectId: string;
  sharedContext: SharedWorkbenchContext;
  onGenStateChange: (state: MarkdownGenerationState | ((prev: MarkdownGenerationState) => MarkdownGenerationState)) => void;
}) {
  const activeNodeTitle = WORKFLOW_NODES.find((node) => node.id === activeNode.id)?.title ?? activeNode.id;
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
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
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const [savingWebSearch, setSavingWebSearch] = useState(false);
  const [webNotice, setWebNotice] = useState<string | null>(null);
  const [pendingVerification, setPendingVerification] = useState<PendingVerification | null>(null);
  // Authoritative agent activity for the current turn. Structured activity
  // events from the route drive this; legacy web events only update webNotice.
  const [activity, setActivity] = useState<{
    stage: AgentActivityStage;
    summary: string;
    startedAt: number | null;
  }>({ stage: "idle", summary: "等待输入", startedAt: null });
  const [now, setNow] = useState(() => Date.now());
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const onGenStateChangeRef = useRef(onGenStateChange);
  useEffect(() => { onGenStateChangeRef.current = onGenStateChange; }, [onGenStateChange]);

  // Tick the clock once per second while a turn is active so the reasoning
  // header can show a live duration.
  useEffect(() => {
    if (activity.stage === "idle") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activity.stage]);

  const sessionUsage = useMemo(() => aggregateUsageFromMessages(messages), [messages]);

  const activeSession = sessions.find((s) => s.id === sharedContext.activeSessionId);
  const webSearchEnabled = activeSession?.webSearchEnabled ?? false;

  async function toggleWebSearch() {
    if (!activeSession || savingWebSearch) return;
    const next = !activeSession.webSearchEnabled;
    const previous = activeSession;
    setSavingWebSearch(true);
    // Optimistic update
    setSessions((current) =>
      current.map((s) =>
        s.id === activeSession.id ? { ...s, webSearchEnabled: next } : s,
      ),
    );
    const rollback = () => {
      setSessions((current) =>
        current.map((s) => (s.id === previous.id ? previous : s)),
      );
    };
    try {
      const res = await fetch(
        `/api/projects/${projectId}/chat/sessions/${activeSession.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodeId: activeNode.id, webSearchEnabled: next }),
        },
      );
      const data = (await res.json()) as { session?: ChatSession; error?: string };
      if (!res.ok || !data.session) {
        rollback();
        setError(data.error ?? "切换联网搜索失败");
        return;
      }
      setSessions((current) =>
        current.map((s) => (s.id === data.session!.id ? data.session! : s)),
      );
    } catch {
      rollback();
      setError("切换联网搜索失败");
    } finally {
      setSavingWebSearch(false);
    }
  }

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
    sharedContext.setActiveSessionId(data.session.id);
    setMessages([]);
  }

  useEffect(() => {
    fetch("/api/settings/model-providers")
      .then((r) => r.json())
      .then((d: { providers: ModelProvider[] }) => {
        sharedContext.setProviders(d.providers);
        const def = d.providers.find((p) => p.isDefault);
        if (def) {
          sharedContext.setProviderId(def.id);
          const defaultModelName = def.models.find((m) => m.isDefault)?.name ?? def.models[0]?.name ?? "";
          sharedContext.setModel(defaultModelName);
        }
      })
      .catch(() => setError("读取模型配置失败"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (!sessionMenuRef.current?.contains(event.target as Node)) {
        setSessionMenuOpen(false);
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
          sharedContext.setActiveSessionId("");
          setMessages([]);
          return;
        }

        if (data.sessions?.length) {
          setSessions(data.sessions);
          sharedContext.setActiveSessionId(data.sessions[0].id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, activeNode.id]);

  const selectedProvider = sharedContext.providers.find((p) => p.id === sharedContext.providerId);
  const selectedReasoning = REASONING_OPTIONS.find((option) => option.value === sharedContext.reasoningEffort) ?? REASONING_OPTIONS[1];
  const selectedFiles = projectFiles.filter((f) => selectedFileIds.includes(f.id));

  function selectModel(provider: ModelProvider, modelName: string) {
    sharedContext.setProviderId(provider.id);
    sharedContext.setModel(modelName);
    setModelMenuOpen(false);
    setModelSubmenuOpen(false);
  }

  function toggleFile(fileId: string) {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId],
    );
  }

  async function sendMessage(overrideMessage?: string) {
    const userContent = (overrideMessage ?? message).trim();
    if (!userContent || sending) return;
    setError("");
    // Clear transient notices from the previous send and start the turn.
    setWebNotice(null);
    setPendingVerification(null);
    setActivity({ stage: "thinking", summary: "正在分析需求", startedAt: Date.now() });

    // Show user message immediately and clear input
    const userMessageId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: "user" as const, content: userContent, createdAt: new Date().toISOString() },
    ]);
    if (!overrideMessage) setMessage("");

    setSending(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    let textBuffer: ReturnType<typeof createStreamingTextBuffer> | null = null;
    let pendingPatchRevision: number | null = null;
    const pendingPatches: import("@/lib/project/types").NodeMarkdownPatch[] = [];
    const pendingSources: ExternalSource[] = [];
    const seenSourceIds = new Set<string>();
    let receivedDone = false;
    let turnFailed = false;

    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: activeNode.id,
          message: userContent,
          providerId: sharedContext.providerId,
          model: sharedContext.model,
          reasoningEffort: sharedContext.reasoningEffort,
          fileIds: selectedFileIds,
          sessionId: sharedContext.activeSessionId || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "发送失败");
        setActivity({ stage: "failed", summary: "发送失败", startedAt: null });
        return;
      }

      const assistantId = crypto.randomUUID();
      setStreamingAssistantId(assistantId);
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant" as const, content: "", createdAt: new Date().toISOString() },
      ]);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      textBuffer = createStreamingTextBuffer(({ content, reasoningContent }) => {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            return {
              ...m,
              content,
              ...(reasoningContent ? { reasoningContent } : {}),
            };
          }),
        );
      });

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
            const event = JSON.parse(payload) as Record<string, unknown>;
            const type = event.type as string;

            if (type === "activity" && event.stage) {
              // Structured activity is authoritative — preserve the first
              // active startedAt so the elapsed timer is continuous.
              const stage = event.stage as AgentActivityStage;
              const summary = (event.summary as string) ?? "";
              setActivity((prev) => ({
                stage,
                summary,
                startedAt: prev.startedAt ?? (stage === "idle" ? null : Date.now()),
              }));
            } else if (type === "reasoning" && event.content) {
              textBuffer.push("reasoning", event.content as string);
            } else if (type === "token" && event.content) {
              textBuffer.push("content", event.content as string);
            } else if (type === "url_read_result" && event.ok === true && event.source) {
              const source = event.source as ExternalSource;
              if (!seenSourceIds.has(source.id)) {
                seenSourceIds.add(source.id);
                pendingSources.push(source);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, sources: [...(m.sources ?? []), source] }
                      : m,
                  ),
                );
              }
            } else if (type === "web_fetch_result" && event.ok !== true && event.message) {
              setWebNotice(`链接读取失败：${event.message as string}`);
            } else if (type === "web_search_result" && event.ok !== true && event.message) {
              setWebNotice(`搜索失败：${event.message as string}`);
            } else if (type === "notice" && event.message) {
              setWebNotice(event.message as string);
            } else if (type === "source" && event.source) {
              const source = event.source as ExternalSource;
              if (!seenSourceIds.has(source.id)) {
                seenSourceIds.add(source.id);
                pendingSources.push(source);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, sources: [...(m.sources ?? []), source] }
                      : m,
                  ),
                );
              }
            } else if (type === "browser_verification_required" && event.verificationId) {
              setPendingVerification({
                verificationId: event.verificationId as string,
                engine: (event.engine as string) || "browser",
                originalMessage: userContent,
                status: "required",
              });
            } else if (type === "markdown_check_start") {
              onGenStateChangeRef.current({ phase: "checking" as const });
            } else if (type === "markdown_unchanged") {
              if (event.warning) {
                setError(event.warning as string);
              }
              onGenStateChangeRef.current({ phase: "idle" as const });
            } else if (type === "markdown_start") {
              const mode = event.mode as string;
              if (mode === "increment") {
                pendingPatchRevision = event.baseRevision as number;
              }
            } else if (type === "markdown_patch_preview") {
              const patch = event.patch as import("@/lib/project/types").NodeMarkdownPatch;
              pendingPatches.push(patch);
            } else if (type === "done" && event.sessionId) {
              receivedDone = true;
              if (pendingPatchRevision !== null && pendingPatches.length > 0) {
                onGenStateChangeRef.current({
                  phase: "previewing_increment",
                  patches: [...pendingPatches],
                  baseRevision: pendingPatchRevision,
                });
              }
              // Replace the optimistic assistant message with the server's
              // authoritative message (carrying turnId/usage/reasoningDurationMs).
              const serverMessage = event.assistantMessage as ChatMessage | undefined;
              if (serverMessage) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? serverMessage : m)),
                );
              }
              sharedContext.setActiveSessionId(event.sessionId as string);
              setSessions((current) =>
                current.map((session) =>
                  session.id === event.sessionId
                    ? { ...session, messageCount: session.messageCount + 2, updatedAt: new Date().toISOString() }
                    : session,
                ),
              );
              // Do NOT clear genState here — MarkdownPanel owns the increment lifecycle
            } else if (type === "markdown_error" && event.error) {
              setError(event.error as string);
              onGenStateChangeRef.current({ phase: "idle" });
            } else if (type === "error" && event.error) {
              turnFailed = true;
              setError(event.error as string);
              const serverMessage = event.assistantMessage as ChatMessage | undefined;
              if (serverMessage) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? serverMessage : m)),
                );
              }
              setActivity({ stage: "failed", summary: "生成失败", startedAt: null });
            }
          } catch {
            // skip malformed events
          }
        }
      }

      await textBuffer.waitUntilIdle();
      if (receivedDone && !turnFailed) {
        // Briefly show the completed stage, then return to idle so the activity
        // indicator clears between turns.
        setActivity((prev) => ({ stage: "completed", summary: "已完成", startedAt: prev.startedAt }));
        setTimeout(() => setActivity({ stage: "idle", summary: "等待输入", startedAt: null }), 1200);
      } else if (!turnFailed && !controller.signal.aborted) {
        // Defensive EOF fallback: production routes should end with done or
        // error, but a clean close without either should not leave the activity
        // indicator pulsing forever.
        setActivity({ stage: "idle", summary: "等待输入", startedAt: null });
      }
    } catch (error) {
      textBuffer?.stop();
      if (error instanceof DOMException && error.name === "AbortError") {
        setActivity({ stage: "interrupted", summary: "已中断", startedAt: null });
        return;
      }
      setError("请求失败，请检查网络连接");
      setActivity({ stage: "failed", summary: "生成失败", startedAt: null });
    } finally {
      setSending(false);
      setStreamingAssistantId(null);
      abortControllerRef.current = null;
    }
  }

  function abortSendMessage() {
    abortControllerRef.current?.abort();
    // Stop the text buffer immediately so streaming animation ends, and mark
    // the turn interrupted so the activity indicator stops pulsing.
    setActivity({ stage: "interrupted", summary: "已中断", startedAt: null });
  }

  async function openBrowserVerification() {
    if (!pendingVerification || !sharedContext.activeSessionId) return;
    setPendingVerification((current) =>
      current ? { ...current, status: "opening" } : current,
    );
    try {
      const res = await fetch(
        `/api/projects/${projectId}/chat/verifications/${pendingVerification.verificationId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sharedContext.activeSessionId }),
        },
      );
      if (!res.ok) {
        setPendingVerification((current) =>
          current ? { ...current, status: "error" } : current,
        );
        return;
      }
      setPendingVerification((current) =>
        current ? { ...current, status: "opened" } : current,
      );
    } catch {
      setPendingVerification((current) =>
        current ? { ...current, status: "error" } : current,
      );
    }
  }

  function retryAfterVerification() {
    if (!pendingVerification) return;
    const retryMessage = pendingVerification.originalMessage;
    setPendingVerification(null);
    void sendMessage(retryMessage);
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
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">当前节点 Agent</p>
          <h2 className="truncate text-sm font-semibold">{activeNode.id}</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative" ref={sessionMenuRef}>
            <button
              aria-expanded={sessionMenuOpen}
              aria-haspopup="menu"
              className="inline-flex h-8 max-w-44 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium shadow-sm transition hover:bg-muted/60"
              onClick={() => setSessionMenuOpen((open) => !open)}
              type="button"
            >
              <span className="truncate">
                {sessions.find((s) => s.id === sharedContext.activeSessionId)?.name ?? "会话"}
              </span>
              <span className="text-muted-foreground">
                · {sessions.find((s) => s.id === sharedContext.activeSessionId)?.messageCount ?? 0} 条
              </span>
              <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            {sessionMenuOpen ? (
              <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-56 rounded-xl border bg-popover p-1.5 text-sm shadow-xl">
                <p className="px-2 py-1 text-xs text-muted-foreground">会话</p>
                <div className="flex max-h-60 flex-col gap-0.5 overflow-auto">
                  {sessions.map((session) => {
                    const active = session.id === sharedContext.activeSessionId;
                    return (
                      <button
                        key={session.id}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                          active && "bg-muted"
                        )}
                        onClick={() => {
                          sharedContext.setActiveSessionId(session.id);
                          loadSessionMessages(session.id);
                          setSessionMenuOpen(false);
                        }}
                        type="button"
                      >
                        <span className="truncate">{session.name}</span>
                        <span className="text-xs text-muted-foreground">{session.messageCount} 条</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <Button onClick={createSession} size="sm" type="button" variant="outline">
            <PlusIcon data-icon="inline-start" />
            新会话
          </Button>
          {sessionUsage ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="session-usage">
              <span>会话用量</span>
              <TokenUsageDetails usage={sessionUsage} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
        {activity.stage !== "idle" ? (
          <AgentActivity
            stage={activity.stage}
            summary={activity.summary}
            startedAt={activity.startedAt}
          />
        ) : null}
        {webNotice ? (
          <p className="rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            {webNotice}
          </p>
        ) : null}
        {pendingVerification ? (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span>
              搜索引擎需要浏览器验证（{pendingVerification.engine}）。验证窗口只会打开服务器保存的挑战页面。
            </span>
            {pendingVerification.status === "error" ? (
              <span className="text-destructive">打开验证窗口失败，请重新发起搜索。</span>
            ) : null}
            {pendingVerification.status === "opened" ? (
              <span>验证窗口已打开。完成后可重试这次请求。</span>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pendingVerification.status === "opening" || !sharedContext.activeSessionId}
                onClick={openBrowserVerification}
                size="sm"
                type="button"
                variant="outline"
              >
                {pendingVerification.status === "opening" ? "打开中..." : "打开浏览器验证"}
              </Button>
              <Button
                disabled={pendingVerification.status === "opening" || sending}
                onClick={retryAfterVerification}
                size="sm"
                type="button"
                variant="outline"
              >
                验证后重试
              </Button>
            </div>
          </div>
        ) : null}
        <ScrollArea className="min-h-0 flex-1" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <div className="max-w-xs rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                围绕“{activeNodeTitle}”补充需求、澄清边界，或让 Agent 帮你整理可写入交付稿的内容。
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((msg) => {
                const isStreaming = sending && msg.id === streamingAssistantId;
                const activityForMessage: ChatMessageActivity | null =
                  isStreaming && activity.stage !== "idle" && activity.stage !== "completed"
                    ? {
                        stage: activity.stage,
                        summary: activity.summary,
                        elapsedSeconds:
                          activity.startedAt != null
                            ? Math.max(0, Math.floor((now - activity.startedAt) / 1000))
                            : null,
                      }
                    : null;
                return (
                  <ChatMessageView key={msg.id} message={msg} activity={activityForMessage} />
                );
              })}
            </div>
          )}
        </ScrollArea>

        <div className="flex flex-col rounded-lg border bg-background">
          <Textarea
            className="min-h-[120px] resize-none border-0 bg-transparent px-4 py-3 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder="补充需求、追问边界，或让当前节点 Agent 帮你整理这一节..."
            value={message}
          />
          {error ? (
            <p className="flex items-center gap-1.5 px-4 py-2 text-sm text-destructive">
              <AlertCircleIcon className="h-4 w-4" />
              {error}
            </p>
          ) : null}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2">
            <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5" ref={filePopoverRef}>
              <button
                className="shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted"
                onClick={() => setFilePopoverOpen((open) => !open)}
                title="添加文件附件"
                type="button"
              >
                <PaperclipIcon className="h-4 w-4" />
              </button>
              <button
                aria-label={`联网搜索：${webSearchEnabled ? "开启" : "关闭"}`}
                aria-pressed={webSearchEnabled}
                className={cn(
                  "shrink-0 rounded-full p-2 transition-colors",
                  webSearchEnabled
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted",
                  (!activeSession || savingWebSearch) && "opacity-50",
                )}
                disabled={!activeSession || savingWebSearch}
                onClick={toggleWebSearch}
                title={webSearchEnabled ? "联网搜索已开启" : "联网搜索已关闭"}
                type="button"
              >
                <Globe2Icon className="h-4 w-4" />
              </button>
              {selectedFiles.map((file) => (
                <span
                  key={file.id}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs"
                >
                  <FileIcon className="h-3 w-3 text-muted-foreground" />
                  <span className="max-w-[120px] truncate">{file.originalName}</span>
                  <button
                    className="text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => toggleFile(file.id)}
                    type="button"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {filePopoverOpen ? (
                <div className="absolute bottom-12 left-0 z-30 w-56 rounded-xl border bg-popover p-1.5 shadow-xl">
                  {projectFiles.filter((f) => f.status === "available").length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">暂无可添加的文件</p>
                  ) : (
                    projectFiles
                      .filter((f) => f.status === "available")
                      .map((file) => (
                        <label
                          key={file.id}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                        >
                          <input
                            checked={selectedFileIds.includes(file.id)}
                            onChange={() => toggleFile(file.id)}
                            type="checkbox"
                          />
                          <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate">{file.originalName}</span>
                          {file.characterCount ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
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
              {sharedContext.providers.length > 0 ? (
                <>
                  <button
                    aria-label={`模型 ${sharedContext.model || selectedProvider?.models.find((m) => m.isDefault)?.name || selectedProvider?.models[0]?.name || "未选择"}，推理 ${selectedReasoning.label}`}
                    aria-expanded={modelMenuOpen}
                    aria-haspopup="menu"
                    className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border bg-background px-3 text-xs font-medium shadow-sm transition hover:bg-muted/60"
                    onClick={() => {
                      setModelMenuOpen((open) => !open);
                      setModelSubmenuOpen(false);
                    }}
                    type="button"
                  >
                    <span className="truncate">{sharedContext.model || selectedProvider?.models.find((m) => m.isDefault)?.name || selectedProvider?.models[0]?.name || "选择模型"}</span>
                    <span className="text-muted-foreground">{selectedReasoning.label}</span>
                    <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>

                  {modelMenuOpen ? (
                    <div className="absolute bottom-10 right-0 z-30 w-52 rounded-xl border bg-popover p-1.5 text-sm shadow-xl">
                      <p className="px-2 py-1 text-xs text-muted-foreground">推理强度</p>
                      {REASONING_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          className="flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-sm hover:bg-muted"
                          onClick={() => sharedContext.setReasoningEffort(option.value)}
                          type="button"
                        >
                          <span>{option.label}</span>
                          {sharedContext.reasoningEffort === option.value ? <CheckIcon className="h-4 w-4" /> : null}
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
                        <span className="truncate">{sharedContext.model || "模型"}</span>
                        <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
                      </button>

                      {modelSubmenuOpen ? (
                        <div className="absolute bottom-0 left-[calc(100%+6px)] z-40 max-h-72 w-56 overflow-auto rounded-xl border bg-popover p-1.5 shadow-xl">
                          <p className="px-2 py-1 text-xs text-muted-foreground">选择模型</p>
                          {sharedContext.providers.map((provider) => (
                            <div key={provider.id}>
                              {sharedContext.providers.length > 1 ? (
                                <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                                  {provider.name}
                                </p>
                              ) : null}
                              {provider.models.map((m) => {
                                const active = provider.id === sharedContext.providerId && m.name === sharedContext.model;
                                return (
                                  <button
                                    key={`${provider.id}-${m.name}`}
                                    className="flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
                                    onClick={() => selectModel(provider, m.name)}
                                    type="button"
                                  >
                                    <span className="truncate">{m.name}</span>
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
              ) : null}
              <Button
                className={sending ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
                disabled={
                  (!sharedContext.providerId || !sharedContext.model || !sharedContext.activeSessionId) ||
                  (!sending && !message.trim())
                }
                onClick={() => {
                  if (sending) abortSendMessage();
                  else void sendMessage();
                }}
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
