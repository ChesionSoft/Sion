// Pure conversation turn reducer: snapshot merging, message/turn grouping, and
// display-label helpers. No React, no IPC — fully testable in Node.

import type { ChatMessage, ConversationTurn } from "./types.ts";

export type ConversationItem =
  | { kind: "turn"; turn: ConversationTurn; userMessage?: ChatMessage; assistantMessage?: ChatMessage }
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
    if (userMessage) consumed.add(userMessage.id);
    if (assistantMessage) consumed.add(assistantMessage.id);
    return {
      at: userMessage?.createdAt ?? turn.startedAt,
      item: { kind: "turn", turn, userMessage, assistantMessage },
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
  switch (turn.deliveryOutcome.kind) {
    case "patch_applied":
      return `交付稿已更新 · revision ${turn.deliveryOutcome.revision}`;
    case "unchanged":
      return "已判断，无需更新交付稿";
    case "awaiting_manual_draft_resolution":
      return "回复已完成，等待处理未保存草稿";
    case "conflict":
      return "交付稿版本已变化，本次未覆盖";
    case "failed":
      return turn.deliveryOutcome.stage === "response"
        ? turn.deliveryOutcome.publicError
        : "回复已完成，交付稿更新失败";
    case "cancelled":
      return "已取消，未保存未完成内容";
    case "pending":
      return turn.status === "queued" ? "Agent 已排队" : "Sion 正在处理";
  }
}

export function turnCanRetryDelivery(turn: ConversationTurn, dirty: boolean): boolean {
  return !dirty && turn.deliveryOutcome.kind === "awaiting_manual_draft_resolution";
}
