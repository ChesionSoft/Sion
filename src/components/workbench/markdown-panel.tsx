"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { AgentRuleMode, ProjectNode } from "@/lib/project/types";

export function MarkdownPanel({
  node,
  onChange,
  projectId,
}: {
  node: ProjectNode;
  onChange: (markdown: string) => void;
  projectId: string;
}) {
  const [markdownSaveMsg, setMarkdownSaveMsg] = useState("");
  const [savingMarkdown, setSavingMarkdown] = useState(false);

  // Agent rule state
  const [agentMode, setAgentMode] = useState<AgentRuleMode>("default");
  const [defaultRuleContent, setDefaultRuleContent] = useState("");
  const [customRuleContent, setCustomRuleContent] = useState("");
  const [agentSaveMsg, setAgentSaveMsg] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [agentTabLoaded, setAgentTabLoaded] = useState(false);

  async function saveMarkdown() {
    setSavingMarkdown(true);
    setMarkdownSaveMsg("");
    try {
      const res = await fetch(`/api/projects/${projectId}/nodes/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: node.markdown }),
      });
      const data = (await res.json()) as { node?: ProjectNode; error?: string };
      if (!res.ok || !data.node) {
        setMarkdownSaveMsg(data.error ?? "保存失败");
        return;
      }
      setMarkdownSaveMsg("已保存");
    } catch {
      setMarkdownSaveMsg("保存失败");
    } finally {
      setSavingMarkdown(false);
    }
  }

  function loadAgentRule() {
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

  async function switchAgentMode(mode: AgentRuleMode) {
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

  async function saveAgentRule() {
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

  async function resetAgentToDefault() {
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

  return (
    <section className="flex min-h-0 flex-col bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-xs font-medium text-muted-foreground">Markdown 源文档</p>
        <h2 className="text-sm font-semibold">{node.id}</h2>
      </div>
      <Tabs className="min-h-0 flex-1 p-5" defaultValue="edit">
        <TabsList variant="line">
          <TabsTrigger className="text-xs" value="edit">编辑</TabsTrigger>
          <TabsTrigger className="text-xs" value="preview">预览</TabsTrigger>
          <TabsTrigger className="text-xs" onClick={loadAgentRule} value="agent">
            Agent 规则
          </TabsTrigger>
        </TabsList>

        <TabsContent className="min-h-0 flex flex-col gap-2" value="edit">
          <div className="flex-1 rounded-lg border bg-muted/20 p-1">
            <Textarea
              className="h-[calc(100vh-220px)] min-h-[500px] resize-none border-0 bg-transparent font-mono text-sm leading-relaxed shadow-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={(event) => onChange(event.target.value)}
              value={node.markdown}
            />
          </div>
          <div className="flex items-center justify-between">
            {markdownSaveMsg ? (
              <span className="text-xs text-muted-foreground">{markdownSaveMsg}</span>
            ) : (
              <span />
            )}
            <Button disabled={savingMarkdown} onClick={saveMarkdown} type="button">
              <CheckIcon data-icon="inline-start" />
              {savingMarkdown ? "保存中..." : "保存当前节点文档"}
            </Button>
          </div>
        </TabsContent>

        <TabsContent className="min-h-0" value="preview">
          <div className="markdown-preview h-[calc(100vh-170px)] min-h-[540px] overflow-auto rounded-lg border bg-muted/10 p-5 text-sm leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.markdown}</ReactMarkdown>
          </div>
        </TabsContent>

        <TabsContent className="min-h-0 flex flex-col gap-3" value="agent">
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-muted-foreground">规则模式</label>
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
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">内置默认规则（只读）</p>
              <div className="h-[calc(100vh-280px)] min-h-[400px] overflow-auto rounded-lg border bg-muted/10 p-4">
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{defaultRuleContent}</pre>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">自定义规则（可编辑）</p>
              <div className="rounded-lg border bg-muted/20 p-1">
                <Textarea
                  className="h-[calc(100vh-320px)] min-h-[380px] resize-none border-0 bg-transparent font-mono text-xs leading-relaxed shadow-none focus-visible:ring-1 focus-visible:ring-ring"
                  onChange={(e) => setCustomRuleContent(e.target.value)}
                  value={customRuleContent}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {agentSaveMsg ? (
                    <span className="text-xs text-muted-foreground">{agentSaveMsg}</span>
                  ) : null}
                  <Button
                    onClick={resetAgentToDefault}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <RefreshCwIcon data-icon="inline-start" />
                    从默认规则重新复制
                  </Button>
                </div>
                <Button disabled={savingAgent} onClick={saveAgentRule} type="button">
                  <CheckIcon data-icon="inline-start" />
                  {savingAgent ? "保存中..." : "保存 Agent 规则"}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
