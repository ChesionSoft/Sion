// Pure conversation turn reducer: snapshot merging, message/turn grouping, and
// display helpers. No React, no IPC — fully testable in Node.

import type { ChatMessage, ConversationTurn, DeliveryOutcome } from "./types.ts";

// ---------------------------------------------------------------------------
// Visual-phase helpers
//
// The live conversation UI derives every transient visual phase from turn
// state plus the transient public-reasoning and token streams. These helpers
// never persist new data and never touch hidden reasoning: they only decide
// how already-public values are presented.
// ---------------------------------------------------------------------------

export type TurnVisualPhase =
  | "queued"
  | "thinking"
  | "reasoning"
  | "output"
  | "terminal";

/** Deterministic display phase for a turn. `liveReasoning` is the transient
 * public reasoning summary; `hasStreamingOutput` marks that an assistant
 * `stream-*` message for this run is present in the message list. */
export function turnVisualPhase(
  turn: ConversationTurn,
  liveReasoning?: string,
  hasStreamingOutput = false,
): TurnVisualPhase {
  if (turn.status === "queued") return "queued";
  if (turn.status === "running") {
    if (hasStreamingOutput) return "output";
    if (liveReasoning) return "reasoning";
    return "thinking";
  }
  return "terminal";
}

/** True when a turn has any public reasoning to show, live or persisted. */
export function turnHasPublicReasoning(
  turn: ConversationTurn,
  liveReasoning?: string,
): boolean {
  return Boolean(liveReasoning || turn.reasoningSummary);
}

// ---------------------------------------------------------------------------
// Elapsed-time helpers
// ---------------------------------------------------------------------------

function parseTimestamp(value?: string): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Elapsed duration of a turn in milliseconds, or null when it cannot be
 * derived conservatively (malformed timestamps, or a terminal turn that never
 * recorded a finish time). Active turns measure from `startedAt` to `now`. */
export function turnElapsedMs(turn: ConversationTurn, now: number): number | null {
  const started = parseTimestamp(turn.startedAt);
  if (started === null) return null;
  const finished = parseTimestamp(turn.finishedAt);
  if (finished !== null) return Math.max(0, finished - started);
  if (turn.status === "running" || turn.status === "queued") {
    return Math.max(0, now - started);
  }
  return null;
}

/** Compact human duration such as `3.2 秒` or `1 分 5 秒`; empty when unknown. */
export function formatTurnElapsed(ms: number | null): string {
  if (ms === null) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} 分${rest > 0 ? ` ${rest} 秒` : ""}`;
}

// ---------------------------------------------------------------------------
// Delivery presentation helpers
// ---------------------------------------------------------------------------

export type DeliveryPresentationTone = "success" | "neutral" | "warning" | "error" | "pending";

export type DeliveryPresentation = {
  kind: DeliveryOutcome["kind"];
  headline: string;
  detail?: string;
  tone: DeliveryPresentationTone;
  retryable: boolean;
};

/** Terminal (and pending) delivery result as a Sion-specific presentation
 * card, including retry eligibility and conflict / dirty-draft language. */
export function turnDeliveryPresentation(
  turn: ConversationTurn,
  dirty: boolean,
): DeliveryPresentation | null {
  const outcome = turn.deliveryOutcome;
  if (!outcome) return null;
  switch (outcome.kind) {
    case "pending":
      return { kind: "pending", headline: "等待交付判断", tone: "pending", retryable: false };
    case "unchanged":
      return { kind: "unchanged", headline: "已判断，无需更新交付稿", tone: "neutral", retryable: false };
    case "patch_applied": {
      const detail = outcome.sectionTitles.length > 0
        ? `更新章节：${outcome.sectionTitles.join("、")}`
        : undefined;
      return {
        kind: "patch_applied",
        headline: `交付稿已更新 · revision ${outcome.revision}`,
        detail,
        tone: "success",
        retryable: false,
      };
    }
    case "awaiting_manual_draft_resolution":
      return {
        kind: "awaiting_manual_draft_resolution",
        headline: "回复已完成，等待处理未保存草稿",
        detail: dirty
          ? "当前文稿有未保存的修改，请先保存或撤销后再重新判断。"
          : "本次交付稿暂未写入，可重新判断。",
        tone: "warning",
        retryable: !dirty,
      };
    case "conflict":
      return {
        kind: "conflict",
        headline: "交付稿版本已变化，本次未覆盖",
        detail: `预期 revision ${outcome.expectedRevision}，实际 ${outcome.actualRevision}。`,
        tone: "error",
        retryable: !dirty,
      };
    case "failed":
      return {
        kind: "failed",
        headline: outcome.stage === "response"
          ? outcome.publicError || "回复生成失败"
          : "回复已完成，交付稿更新失败",
        detail: outcome.stage === "response"
          ? undefined
          : outcome.publicError || `失败阶段：${outcome.stage}`,
        tone: "error",
        retryable: outcome.stage !== "response" && !dirty,
      };
    case "cancelled":
      return { kind: "cancelled", headline: "已取消，未保存未完成内容", tone: "neutral", retryable: false };
  }
}

// ---------------------------------------------------------------------------
// Streaming presentation seam
//
// Transient assistant messages are keyed `stream-<runId>` and never persisted.
// These helpers associate such a message with its active run without changing
// stored messages or their `groupConversation` ordering.
// ---------------------------------------------------------------------------

export function streamMessageId(runId: string): string {
  return `stream-${runId}`;
}

/** The run id a transient message belongs to, or null for a persisted message. */
export function streamRunId(message: ChatMessage): string | null {
  return message.id.startsWith("stream-") ? message.id.slice("stream-".length) : null;
}

export function isStreamingMessage(message: ChatMessage): boolean {
  return message.id.startsWith("stream-");
}

// ---------------------------------------------------------------------------
// Fenced-code completeness guard
//
// While a fenced-code block is still open in a streaming reply, keep the
// partial content as stable plain text; only let the Markdown code-block
// component render once every fence is closed. Deterministic and streaming-safe.
// ---------------------------------------------------------------------------

export function hasUnclosedCodeFence(markdown: string): boolean {
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of markdown.split("\n")) {
    if (fenceChar) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith(fenceChar)
        && trimmed.replaceAll(fenceChar, "").trim() === ""
        && trimmed.length >= fenceLen
      ) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      fenceChar = match[1][0];
      fenceLen = match[1].length;
    }
  }
  return fenceChar !== "";
}

export function isFencedCodeComplete(markdown: string): boolean {
  return !hasUnclosedCodeFence(markdown);
}

// ---------------------------------------------------------------------------
// Snapshot merging, grouping, and display labels
// ---------------------------------------------------------------------------

export type ConversationItem =
  | {
    kind: "turn";
    turn: ConversationTurn;
    userMessage?: ChatMessage;
    assistantMessage?: ChatMessage;
    /** Ephemeral `stream-<runId>` output, rendered inside its owning turn. */
    streamingMessage?: ChatMessage;
  }
  | { kind: "legacy_message"; message: ChatMessage };

export function mergeTurnSnapshot(
  turns: ConversationTurn[],
  incoming: ConversationTurn,
): ConversationTurn[] {
  return [...turns.filter((turn) => turn.id !== incoming.id), incoming].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

export function groupConversation(
  messages: ChatMessage[],
  turns: ConversationTurn[],
): ConversationItem[] {
  const consumed = new Set<string>();
  const items: Array<{ at: string; item: ConversationItem }> = turns.map((turn) => {
    const userMessage = messages.find(
      (message) => message.id === turn.userMessageId || (message.turnId === turn.id && message.role === "user"),
    );
    const assistantMessage = messages.find(
      (message) => message.id === turn.assistantMessageId || (message.turnId === turn.id && message.role === "assistant"),
    );
    const streamingMessage = messages.find((message) => message.id === streamMessageId(turn.runId));
    if (userMessage) consumed.add(userMessage.id);
    if (assistantMessage) consumed.add(assistantMessage.id);
    if (streamingMessage) consumed.add(streamingMessage.id);
    return {
      at: userMessage?.createdAt ?? turn.startedAt,
      item: { kind: "turn", turn, userMessage, assistantMessage, streamingMessage },
    };
  });
  for (const message of messages) {
    if (!consumed.has(message.id)) {
      items.push({ at: message.createdAt, item: { kind: "legacy_message", message } });
    }
  }
  return items.sort((left, right) => left.at.localeCompare(right.at)).map(({ item }) => item);
}

export function turnHeadline(turn: ConversationTurn): string {
  if (turn.status === "cancelled") return "已取消，未保存未完成内容";
  if (turn.status === "interrupted") return "运行在应用退出前中断";
  if (turn.harness) {
    if (turn.status === "queued") return "Agent 已排队";
    if (turn.status === "running") return "Sion 正在处理";
    const ready = turn.harness.proposals.filter((proposal) => proposal.status === "ready").length;
    if (ready > 0) return `已准备 ${ready} 项文稿提案`;
    if (turn.status === "failed") return "文档 Harness 运行失败";
    return "对话已完成";
  }
  const outcome = turn.deliveryOutcome;
  if (!outcome) return turn.status === "failed" ? "对话运行失败" : "对话已完成";
  switch (outcome.kind) {
    case "patch_applied":
      return `交付稿已更新 · revision ${outcome.revision}`;
    case "unchanged":
      return "已判断，无需更新交付稿";
    case "awaiting_manual_draft_resolution":
      return "回复已完成，等待处理未保存草稿";
    case "conflict":
      return "交付稿版本已变化，本次未覆盖";
    case "failed":
      return outcome.stage === "response"
        ? outcome.publicError
        : "回复已完成，交付稿更新失败";
    case "cancelled":
      return "已取消，未保存未完成内容";
    case "pending":
      return turn.status === "queued" ? "Agent 已排队" : "Sion 正在处理";
  }
}
