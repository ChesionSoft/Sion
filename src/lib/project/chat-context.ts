import { getNodeDefinition } from "./nodes";
import type { ProjectNode, WorkflowNodeId } from "./types";

/** Strict cap for dependency context injected into system prompt. */
export const MAX_CONTEXT_MARKDOWN_CHARS = 12_000;

/** Strict cap for all selected project files combined. */
export const MAX_FILE_CONTEXT_CHARS = 12_000;

/** Strict cap per single dependency node section. */
export const MAX_PER_NODE_CONTEXT_CHARS = 4_000;

/** Maximum sizes for non-file project text placed in a chat model call. */
export const MAX_CURRENT_NODE_CHARS = 8_000;
export const MAX_AGENT_RULE_CHARS = 6_000;
export const MAX_USER_MESSAGE_CHARS = 8_000;
export const MAX_HISTORY_CHARS = 8_000;
export const MAX_REWRITE_HISTORY_CHARS = 6_000;
export const MAX_CHAT_SYSTEM_PROMPT_CHARS = 32_000;
export const MAX_SELECTED_FILES = 4;

const TRUNCATION_MARKER = "\n\n…（内容已截断）";

/** Return text that is never longer than `maxChars`, marker included. */
export function truncateForPrompt(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxChars);
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function sectionWithinBudget(header: string, body: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (header.length >= maxChars) return truncateForPrompt(header, maxChars);
  return header + truncateForPrompt(body, maxChars - header.length);
}

export function buildDependencyContextMarkdown(
  nodeId: WorkflowNodeId,
  nodes: ProjectNode[],
): string {
  const def = getNodeDefinition(nodeId);
  if (!def || def.dependsOn.length === 0) return "";

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  let used = 0;

  for (const depId of def.dependsOn) {
    const dep = byId.get(depId);
    if (!dep) continue;
    const heading = getNodeDefinition(depId)?.documentHeading ?? depId;
    const body = dep.markdown.trim();
    if (!body) continue;
    const separator = parts.length ? "\n\n" : "";
    const remaining = MAX_CONTEXT_MARKDOWN_CHARS - used - separator.length;
    if (remaining <= 0) break;
    const section = sectionWithinBudget(
      `### ${heading}\n\n`,
      body,
      Math.min(MAX_PER_NODE_CONTEXT_CHARS, remaining),
    );
    if (!section) break;
    parts.push(section);
    used += separator.length + section.length;
  }

  return parts.join("\n\n");
}

export type FileSectionInput = { name: string; content: string };

export type PromptMessage = { content: string };

/** Keep the newest messages within a strict budget, preserving their order. */
export function collectBudgetedConversation<T extends PromptMessage>(
  messages: T[],
  maxChars: number,
): T[] {
  const kept: T[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const message = messages[index];
    const content = truncateForPrompt(message.content, remaining);
    kept.push({ ...message, content });
    used += content.length;
  }
  return kept.reverse();
}

export function assembleBudgetedPrompt(contextParts: string[], requiredTail: string): string {
  if (requiredTail.length > MAX_CHAT_SYSTEM_PROMPT_CHARS) {
    throw new Error("Required chat prompt instructions exceed their declared budget");
  }
  const context = contextParts.filter(Boolean).join("\n\n");
  const separator = context && requiredTail ? "\n\n" : "";
  const contextBudget = MAX_CHAT_SYSTEM_PROMPT_CHARS - requiredTail.length - separator.length;
  return `${truncateForPrompt(context, contextBudget)}${separator}${requiredTail}`;
}

export function collectBudgetedFileSections(files: FileSectionInput[]): string[] {
  const out: string[] = [];
  let used = 0;

  for (const file of files) {
    if (used >= MAX_FILE_CONTEXT_CHARS) break;
    const separator = out.length ? "\n\n" : "";
    const remaining = MAX_FILE_CONTEXT_CHARS - used - separator.length;
    if (remaining <= 0) break;
    const section = sectionWithinBudget(`## 引用文件：${file.name}\n\n`, file.content, remaining);
    if (!section) break;
    out.push(section);
    used += separator.length + section.length;
  }

  return out;
}
