"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { AgentRuleMode, ProjectNode, ReasoningEffort, WorkflowNodeId } from "@/lib/project/types";
import type { MarkdownGenerationState } from "./markdown-generation-types";
import { buildPatchPreviewFrames } from "./patch-preview";

export function MarkdownPanel({
  node,
  onChange,
  onSavedNode,
  projectId,
  genState,
  setGenState,
  sharedContext,
}: {
  node: ProjectNode;
  onChange: (markdown: string) => void;
  onSavedNode: (node: ProjectNode) => void;
  projectId: string;
  genState: MarkdownGenerationState;
  setGenState: (state: MarkdownGenerationState | ((prev: MarkdownGenerationState) => MarkdownGenerationState)) => void;
  sharedContext: {
    activeSessionId: string;
    providerId: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    providers: { id: string; name: string; models: { name: string; isDefault?: boolean }[] }[];
  };
}) {
  const [markdownSaveMsg, setMarkdownSaveMsg] = useState("");
  const [savingMarkdown, setSavingMarkdown] = useState(false);

  // Independent preview buffer for increment animation + rewrite candidate
  const [previewMarkdown, setPreviewMarkdown] = useState("");
  // User draft (textarea edits when idle)
  const [userDraft, setUserDraft] = useState(node.markdown);

  // AbortController for animation (NOT the chat's)
  const animationAbortRef = useRef<AbortController | null>(null);

  // Keep refs to genState/setGenState for the animation callback (updated via effects)
  const genStateRef = useRef(genState);
  const setGenStateRef = useRef(setGenState);

  // Sync refs to latest props
  useEffect(() => { genStateRef.current = genState; }, [genState]);
  useEffect(() => { setGenStateRef.current = setGenState; }, [setGenState]);

  // Track last synced node to avoid set-state-in-effect warnings
  const lastNodeRef = useRef(node);
  useEffect(() => {
    if (lastNodeRef.current.id !== node.id || lastNodeRef.current.markdown !== node.markdown) {
      lastNodeRef.current = node;
      if (genState.phase === "idle" || genState.phase === "conflict" || genState.phase === "error") {
        queueMicrotask(() => setUserDraft(node.markdown));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.markdown, genState.phase]);

  // Agent rule state
  const [agentMode, setAgentMode] = useState<AgentRuleMode>("default");
  const [defaultRuleContent, setDefaultRuleContent] = useState("");
  const [customRuleContent, setCustomRuleContent] = useState("");
  const [agentSaveMsg, setAgentSaveMsg] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [agentTabLoaded, setAgentTabLoaded] = useState(false);

  // ---------------------------------------------------------------------------
  // Submit patches helper (hoisted before the animation effect that calls it)
  // ---------------------------------------------------------------------------

  async function submitPatches(
    patches: import("@/lib/project/types").NodeMarkdownPatch[],
    baseRevision: number,
  ): Promise<void> {
    setGenStateRef.current({ phase: "submitting_increment" });

    const submitAc = new AbortController();
    animationAbortRef.current = submitAc;

    try {
      const res = await fetch(`/api/projects/${projectId}/nodes/${node.id}/patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patches, expectedRevision: baseRevision }),
        signal: submitAc.signal,
      });

      const data = (await res.json()) as Record<string, unknown>;

      if (res.ok && data.node) {
        onSavedNode(data.node as ProjectNode);
        setGenStateRef.current({ phase: "idle" });
        setPreviewMarkdown("");
        setUserDraft((data.node as ProjectNode).markdown);
      } else if (res.status === 409 && data.latestNode) {
        onSavedNode(data.latestNode as ProjectNode);
        setGenStateRef.current({
          phase: "conflict",
          latestNode: data.latestNode as ProjectNode,
        });
        setPreviewMarkdown("");
        setUserDraft((data.latestNode as ProjectNode).markdown);
      } else if (res.status === 422) {
        setGenStateRef.current({
          phase: "error",
          message: (data.error as string) ?? "patch 无效",
        });
        setPreviewMarkdown("");
      } else {
        setGenStateRef.current({ phase: "error", message: "提交失败" });
        setPreviewMarkdown("");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setGenStateRef.current({ phase: "error", message: "提交失败" });
      setPreviewMarkdown("");
    } finally {
      if (animationAbortRef.current === submitAc) {
        animationAbortRef.current = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Increment animation (previewing_increment)
  // ---------------------------------------------------------------------------

  // When genState transitions to previewing_increment with patches, start the animation
  useEffect(() => {
    if (genState.phase !== "previewing_increment" || genState.patches.length === 0) return;

    const ac = new AbortController();
    animationAbortRef.current = ac;

    const frames = buildPatchPreviewFrames(
      node.id as WorkflowNodeId,
      node.markdown,
      genState.patches,
    );

    if (frames.length <= 1) {
      // No animation needed, just the base frame
      animationAbortRef.current = null;
      queueMicrotask(() => {
        void submitPatches(genState.patches, genState.baseRevision);
      });
      return;
    }

    // Use a microtask to defer state update out of the effect body.
    const frameId = requestAnimationFrame(() => {
      setPreviewMarkdown(frames[0]);
    });

    let frameIndex = 1;
    const interval = 40; // ~25fps

    const timer = setInterval(() => {
      if (ac.signal.aborted) {
        clearInterval(timer);
        return;
      }

      if (frameIndex >= frames.length) {
        clearInterval(timer);
        animationAbortRef.current = null;
        setPreviewMarkdown(frames[frames.length - 1]);
        // Animation complete — submit patches
        // Use ref to get latest genState
        const currentGenState = genStateRef.current;
        if (currentGenState.phase === "previewing_increment") {
          void submitPatches(currentGenState.patches, currentGenState.baseRevision);
        }
        return;
      }

      setPreviewMarkdown(frames[frameIndex]);
      frameIndex++;
    }, interval);

    return () => {
      cancelAnimationFrame(frameId);
      clearInterval(timer);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genState.phase]);

  function interruptAnimation(): void {
    if (animationAbortRef.current) {
      animationAbortRef.current.abort();
      animationAbortRef.current = null;
    }
    setPreviewMarkdown("");
    setGenState({ phase: "idle" });
  }

  // ---------------------------------------------------------------------------
  // Rewrite
  // ---------------------------------------------------------------------------

  async function startRewrite(): Promise<void> {
    if (genState.phase !== "idle" && genState.phase !== "conflict" && genState.phase !== "error") return;

    setGenState({ phase: "previewing_rewrite", candidate: "" });
    setPreviewMarkdown("");

    const rewriteAc = new AbortController();
    animationAbortRef.current = rewriteAc;

    try {
      const res = await fetch(`/api/projects/${projectId}/nodes/${node.id}/rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sharedContext.activeSessionId,
          providerId: sharedContext.providerId,
          model: sharedContext.model,
          reasoningEffort: sharedContext.reasoningEffort,
          expectedRevision: node.revision,
        }),
        signal: rewriteAc.signal,
      });

      if (!res.ok) {
        setGenState({ phase: "error", message: "重写请求失败" });
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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

            if (type === "markdown_token" && event.content) {
              setPreviewMarkdown((prev) => prev + (event.content as string));
            } else if (type === "markdown_done" && event.updatedNode) {
              onSavedNode(event.updatedNode as ProjectNode);
              setGenState({ phase: "idle" });
              setPreviewMarkdown("");
              setUserDraft((event.updatedNode as ProjectNode).markdown);
            } else if (type === "markdown_conflict" && event.latestNode) {
              onSavedNode(event.latestNode as ProjectNode);
              setGenState({
                phase: "conflict",
                latestNode: event.latestNode as ProjectNode,
                candidate: (event.candidateMarkdown as string) ?? undefined,
              });
              // Keep previewMarkdown as candidate
            } else if (type === "markdown_error" && event.error) {
              setGenState({ phase: "error", message: event.error as string });
            }
          } catch {
            // skip malformed events
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setGenState({ phase: "error", message: "重写请求失败" });
    } finally {
      if (animationAbortRef.current === rewriteAc) {
        animationAbortRef.current = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  async function saveMarkdown(): Promise<void> {
    setSavingMarkdown(true);
    setMarkdownSaveMsg("");
    try {
      const res = await fetch(`/api/projects/${projectId}/nodes/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: userDraft, expectedRevision: node.revision }),
      });
      const data = (await res.json()) as { node?: ProjectNode; error?: string; latestNode?: ProjectNode };
      if (res.ok && data.node) {
        onSavedNode(data.node);
        setUserDraft(data.node.markdown);
        setMarkdownSaveMsg("已保存");
      } else if (res.status === 409 && data.latestNode) {
        onSavedNode(data.latestNode);
        setUserDraft(data.latestNode.markdown);
        setGenState({ phase: "conflict", latestNode: data.latestNode });
        setMarkdownSaveMsg("节点已被其他操作修改，请基于最新内容重新编辑");
      } else {
        setMarkdownSaveMsg(data.error ?? "保存失败");
      }
    } catch {
      setMarkdownSaveMsg("保存失败");
    } finally {
      setSavingMarkdown(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Agent rule
  // ---------------------------------------------------------------------------

  function loadAgentRule(): void {
    if (agentTabLoaded) return;
    setAgentTabLoaded(true);

    fetch(`/api/projects/${projectId}/agents/${node.id}`)
      .then((r) => r.json())
      .then(
        (d: {
          setting?: { mode: AgentRuleMode };
          defaultContent?: string;
          customContent?: string | null;
          error?: string;
        }) => {
          if (d.setting) setAgentMode(d.setting.mode);
          if (d.defaultContent) setDefaultRuleContent(d.defaultContent);
          if (d.customContent) setCustomRuleContent(d.customContent);
        },
      )
      .catch(() => {});
  }

  async function switchAgentMode(mode: AgentRuleMode): Promise<void> {
    setAgentSaveMsg("");
    try {
      const res = await fetch(`/api/projects/${projectId}/agents/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = (await res.json()) as {
        setting?: { mode: AgentRuleMode };
        defaultContent?: string;
        customContent?: string | null;
        error?: string;
      };
      if (!res.ok || !data.setting) {
        setAgentSaveMsg(data.error ?? "切换失败");
        return;
      }
      setAgentMode(data.setting.mode);
      if (data.customContent) setCustomRuleContent(data.customContent);
    } catch {
      setAgentSaveMsg("切换失败");
    }
  }

  async function saveAgentRule(): Promise<void> {
    setSavingAgent(true);
    setAgentSaveMsg("");
    try {
      const res = await fetch(`/api/projects/${projectId}/agents/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: customRuleContent }),
      });
      const data = (await res.json()) as { setting?: object; error?: string };
      if (!res.ok || !data.setting) {
        setAgentSaveMsg(data.error ?? "保存失败");
        return;
      }
      setAgentSaveMsg("已保存");
    } catch {
      setAgentSaveMsg("保存失败");
    } finally {
      setSavingAgent(false);
    }
  }

  async function resetAgentToDefault(): Promise<void> {
    setAgentSaveMsg("");
    try {
      const res = await fetch(`/api/projects/${projectId}/agents/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetToDefault: true }),
      });
      const data = (await res.json()) as {
        setting?: { mode: AgentRuleMode };
        customContent?: string | null;
        error?: string;
      };
      if (!res.ok || !data.setting) {
        setAgentSaveMsg(data.error ?? "重置失败");
        return;
      }
      if (data.customContent) setCustomRuleContent(data.customContent);
      setAgentSaveMsg("已从默认规则重新复制");
    } catch {
      setAgentSaveMsg("重置失败");
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const isGenActive =
    genState.phase === "checking" ||
    genState.phase === "previewing_increment" ||
    genState.phase === "submitting_increment" ||
    genState.phase === "previewing_rewrite";

  const canSave = !isGenActive && !savingMarkdown;
  const rewriteDisabled = isGenActive || !sharedContext.providerId || !sharedContext.model;

  // Determine what to show in the textarea
  const textareaValue =
    genState.phase === "previewing_increment" ||
    genState.phase === "submitting_increment" ||
    genState.phase === "previewing_rewrite"
      ? previewMarkdown
      : userDraft;

  function handleChange(value: string): void {
    if (isGenActive) return;
    setUserDraft(value);
    onChange(value);
  }

  function copyCandidate(): void {
    if (genState.phase === "conflict" && genState.candidate) {
      void navigator.clipboard.writeText(genState.candidate);
    }
  }

  return (
    <section className="flex min-h-0 flex-col bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-xs font-medium text-muted-foreground">节点交付稿</p>
        <h2 className="text-sm font-semibold">{node.id}</h2>
      </div>

      {/* Generation status bar */}
      {(genState.phase === "previewing_increment" ||
        genState.phase === "submitting_increment" ||
        genState.phase === "previewing_rewrite") && (
        <div className="flex items-center justify-between border-b bg-muted/20 px-5 py-2">
          <span className="text-xs text-muted-foreground">
            {genState.phase === "previewing_increment" && "正在动画展示增量写入..."}
            {genState.phase === "submitting_increment" && "正在提交增量写入..."}
            {genState.phase === "previewing_rewrite" && "按规则重写中..."}
          </span>
          <Button onClick={interruptAnimation} size="sm" type="button" variant="outline">
            中断写入
          </Button>
        </div>
      )}

      {/* Conflict banner */}
      {genState.phase === "conflict" && (
        <div className="flex items-center justify-between border-b bg-destructive/10 px-5 py-2">
          <span className="text-xs text-destructive">
            磁盘内容已变化，本次未覆盖
            {genState.candidate ? "。下方为候选稿（未保存）" : ""}
          </span>
          <div className="flex items-center gap-2">
            {genState.candidate ? (
              <Button onClick={copyCandidate} size="sm" type="button" variant="outline">
                <CopyIcon data-icon="inline-start" />
                复制候选稿
              </Button>
            ) : null}
            <Button
              onClick={() => {
                setGenState({ phase: "idle" });
                setPreviewMarkdown("");
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              返回编辑
            </Button>
          </div>
        </div>
      )}

      {/* Error banner */}
      {genState.phase === "error" && (
        <div className="flex items-center justify-between border-b bg-destructive/10 px-5 py-2">
          <span className="text-xs text-destructive">{genState.message}</span>
          <Button onClick={() => setGenState({ phase: "idle" })} size="sm" type="button" variant="outline">
            返回编辑
          </Button>
        </div>
      )}

      <Tabs className="min-h-0 flex-1 p-5" defaultValue="edit">
        <TabsList variant="line">
          <TabsTrigger className="text-xs" value="edit">编辑 Markdown</TabsTrigger>
          <TabsTrigger className="text-xs" value="preview">预览交付稿</TabsTrigger>
          <TabsTrigger className="text-xs" onClick={loadAgentRule} value="agent">
            Agent 规则
          </TabsTrigger>
        </TabsList>

        <TabsContent className="min-h-0 flex flex-1 flex-col gap-2" value="edit">
          <div className="min-h-0 flex-1 rounded-lg border bg-muted/20 p-1">
            <Textarea
              className="h-full min-h-[280px] resize-none border-0 bg-transparent font-mono text-sm leading-relaxed shadow-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={(event) => handleChange(event.target.value)}
              readOnly={isGenActive || genState.phase === "conflict"}
              value={textareaValue}
            />
          </div>
          <div className="flex shrink-0 items-center justify-between">
            {markdownSaveMsg ? (
              <span className="text-xs text-muted-foreground">{markdownSaveMsg}</span>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button
                disabled={rewriteDisabled}
                onClick={startRewrite}
                type="button"
                variant="outline"
              >
                <RefreshCwIcon data-icon="inline-start" />
                按规则重写交付稿
              </Button>
              <Button disabled={!canSave} onClick={saveMarkdown} type="button">
                <CheckIcon data-icon="inline-start" />
                {savingMarkdown ? "正在保存..." : "保存当前节点交付稿"}
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent className="min-h-0 flex-1 flex flex-col" value="preview">
          <div className="markdown-preview min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/10 p-5 text-sm leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {genState.phase === "previewing_increment" ||
              genState.phase === "submitting_increment" ||
              genState.phase === "previewing_rewrite"
                ? previewMarkdown
                : genState.phase === "conflict" && genState.candidate
                  ? genState.candidate
                  : userDraft}
            </ReactMarkdown>
          </div>
        </TabsContent>

        <TabsContent className="min-h-0 flex flex-1 flex-col gap-3" value="agent">
          <div className="flex shrink-0 items-center gap-3">
            <label className="text-xs font-medium text-muted-foreground">Agent 规则来源</label>
            <select
              className="h-8 rounded-md border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={(e) => switchAgentMode(e.target.value as AgentRuleMode)}
              value={agentMode}
            >
              <option value="default">使用内置默认规则</option>
              <option value="custom">使用项目自定义规则</option>
            </select>
          </div>

          {agentMode === "default" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <p className="text-xs text-muted-foreground">内置默认规则（只读，适合大多数项目）</p>
              <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/10 p-4">
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{defaultRuleContent}</pre>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <p className="text-xs text-muted-foreground">项目自定义规则（会永久保存在当前项目）</p>
              <div className="min-h-0 flex-1 rounded-lg border bg-muted/20 p-1">
                <Textarea
                  className="h-full min-h-[240px] resize-none border-0 bg-transparent font-mono text-xs leading-relaxed shadow-none focus-visible:ring-1 focus-visible:ring-ring"
                  onChange={(e) => setCustomRuleContent(e.target.value)}
                  value={customRuleContent}
                />
              </div>
              <div className="flex shrink-0 items-center justify-between">
                <div className="flex items-center gap-2">
                  {agentSaveMsg ? (
                    <span className="text-xs text-muted-foreground">{agentSaveMsg}</span>
                  ) : null}
                  <Button onClick={resetAgentToDefault} size="sm" type="button" variant="outline">
                    <RefreshCwIcon data-icon="inline-start" />
                    重新复制默认规则
                  </Button>
                </div>
                <Button disabled={savingAgent} onClick={saveAgentRule} type="button">
                  <CheckIcon data-icon="inline-start" />
                  {savingAgent ? "正在保存..." : "保存项目 Agent 规则"}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}