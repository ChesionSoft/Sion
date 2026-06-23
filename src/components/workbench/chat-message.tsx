"use client";

import { BotIcon, CopyIcon, UserIcon } from "lucide-react";
import { toast } from "sonner";
import type { AgentActivityStage, ChatMessage, ExternalSource } from "@/lib/project/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "./markdown-content";
import { TokenUsageDetails } from "./token-usage-details";

export type ChatMessageActivity = {
  stage: AgentActivityStage;
  summary: string;
  /** Parent-computed elapsed seconds, or null while idle. */
  elapsedSeconds: number | null;
};

export type ChatMessageViewProps = {
  message: ChatMessage;
  /** Live activity for the streaming assistant message, or null for history. */
  activity?: ChatMessageActivity | null;
};

const ACTIVE_STAGES: ReadonlySet<AgentActivityStage> = new Set([
  "thinking",
  "reading_files",
  "searching_web",
  "generating_answer",
  "updating_document",
]);

function isStageActive(stage: AgentActivityStage | undefined): stage is AgentActivityStage {
  return !!stage && ACTIVE_STAGES.has(stage);
}

async function copyMessage(message: ChatMessage) {
  try {
    await navigator.clipboard.writeText(message.content);
    toast.success("已复制到剪贴板");
  } catch {
    toast.error("复制失败");
  }
}

/**
 * Renders a single chat message with a hover-revealed copy button and an icon
 * avatar. User/system messages stay plain; assistant bodies delegate to the
 * shared safe Markdown renderer. Reasoning, sources, and per-turn usage sit
 * below the content.
 */
export function ChatMessageView({ message, activity }: ChatMessageViewProps) {
  const copyButton = (
    <Button
      aria-label="复制"
      className="chat-message-copy absolute right-2 top-2 h-6 w-6 p-0"
      onClick={() => copyMessage(message)}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      <CopyIcon className="h-3.5 w-3.5" />
    </Button>
  );

  if (message.role === "system") {
    return (
      <div className="chat-message chat-message-system mx-auto max-w-[90%] rounded-lg bg-muted/20 px-3 py-2 text-center text-xs text-muted-foreground">
        {message.content}
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div
        className="chat-message chat-message-user group relative flex max-w-[85%] flex-col gap-1 self-end rounded-2xl bg-foreground p-3.5 text-sm text-background"
        data-role="user"
      >
        {copyButton}
        <span className="flex items-center gap-1.5 text-xs text-background/70">
          <span className="chat-avatar bg-background/15 text-background/80">
            <UserIcon className="h-3 w-3" />
          </span>
          你
        </span>
        <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
      </div>
    );
  }

  // assistant
  const active = isStageActive(activity?.stage);
  const hasReasoning = !!message.reasoningContent;
  const showReasoning = hasReasoning || active;

  return (
    <div
      className="chat-message chat-message-assistant group relative flex max-w-[85%] flex-col gap-1 self-start rounded-2xl border bg-muted/40 p-3.5 text-sm text-foreground"
      data-role="assistant"
    >
      {copyButton}
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="chat-avatar">
          <BotIcon className="h-3 w-3" />
        </span>
        Agent
      </span>
      {showReasoning ? (
        <details className="chat-reasoning group mb-2 rounded-md border bg-background/60 px-2 py-1.5" open={false}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground">
            <span>{active ? <ReasoningSummary activity={activity!} message={message} /> : <HistoricalReasoning message={message} />}</span>
          </summary>
          {hasReasoning ? (
            <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {message.reasoningContent}
            </div>
          ) : null}
        </details>
      ) : null}
      <MarkdownContent markdown={message.content} variant="chat" />
      {message.sources && message.sources.length > 0 ? (
        <div className="chat-sources mt-1 flex flex-col gap-1 border-t pt-2">
          {message.sources.map((source) => (
            <SourceLink key={source.id} source={source} />
          ))}
        </div>
      ) : null}
      <TokenUsageDetails usage={message.usage} showEmpty />
    </div>
  );
}

function ReasoningSummary({ activity, message }: { activity: ChatMessageActivity; message: ChatMessage }) {
  const elapsed =
    activity.elapsedSeconds != null
      ? activity.elapsedSeconds
      : message.reasoningDurationMs != null
        ? Math.round(message.reasoningDurationMs / 1000)
        : null;
  return (
    <span>
      {activity.summary}
      {elapsed == null ? "" : ` · ${elapsed} 秒`}
    </span>
  );
}

function HistoricalReasoning({ message }: { message: ChatMessage }) {
  const seconds =
    message.reasoningDurationMs != null ? Math.round(message.reasoningDurationMs / 1000) : null;
  return <span>{seconds == null ? "思考过程" : `已思考 ${seconds} 秒`}</span>;
}

function SourceLink({ source }: { source: ExternalSource }) {
  return (
    <a
      className={cn(
        "flex items-center justify-between gap-2 rounded-md bg-background/60 px-2 py-1 text-xs hover:underline",
      )}
      href={source.url}
      rel="noreferrer noopener"
      target="_blank"
    >
      <span className="truncate">{source.title || source.url}</span>
      <span className="shrink-0 text-muted-foreground">{source.domain}</span>
    </a>
  );
}