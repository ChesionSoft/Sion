import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Heading, Root, Text } from "mdast";
import { streamOpenAICompatibleChat } from "./llm";
import { getDeliverySchema } from "./node-delivery-schemas";
import { getNodeDefinition, WORKFLOW_NODES } from "./nodes";
import type { ApiUrlMode, ChatMessage, ReasoningEffort, WorkflowNodeId } from "./types";

// ---------------------------------------------------------------------------
// Stream node markdown rewrite
// ---------------------------------------------------------------------------

export type StreamNodeMarkdownRewriteInput = {
  apiBaseUrl: string;
  apiUrlMode?: ApiUrlMode;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  nodeId: WorkflowNodeId;
  currentMarkdown: string;
  contextMarkdown: string;
  recentMessages: ChatMessage[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export async function* streamNodeMarkdownRewrite(
  input: StreamNodeMarkdownRewriteInput,
): AsyncGenerator<string, void, void> {
  const schema = getDeliverySchema(input.nodeId);
  const nodeDef = getNodeDefinition(input.nodeId);

  // Build system prompt with schema sections
  const systemParts: string[] = [
    `You are rewriting the Markdown for the workflow node "${input.nodeId}".`,
    "",
    "Output ONLY the complete updated Markdown for the current node.",
    "Start with the node's H1 heading:",
    `# ${nodeDef?.title ?? input.nodeId}`,
    "",
    "Follow this section order (headings without ## prefix):",
  ];

  if (schema) {
    for (const section of schema.sections) {
      const prefix = "#".repeat(section.level);
      const tableHint = section.tableColumns
        ? ` (table columns: ${section.tableColumns.join(", ")})`
        : "";
      const requiredHint = section.required ? " [REQUIRED]" : " [OPTIONAL]";
      systemParts.push(`- ${prefix} ${section.heading}${requiredHint}${tableHint}`);
    }
  }

  systemParts.push(
    "",
    "Rules:",
    "- Fill REQUIRED sections with content. If no content, write \"[本节暂无]\".",
    "- OMIT optional sections entirely if they have no content.",
    "- Do NOT include headings from other workflow nodes.",
    "- Do NOT wrap the output in a code fence.",
    "- Do NOT include any explanatory prose outside the Markdown body.",
    "- Preserve confirmed content from the current node markdown.",
    "- Relocate scattered conclusions into the correct skeleton sections.",
    "- Remove chat-like prose and conversational text.",
  );

  // Build user prompt
  const recentMessages = input.recentMessages.slice(-20);
  const formattedMessages = recentMessages
    .map((msg) => `${msg.role === "user" ? "用户" : "Assistant"}：${msg.content}`)
    .join("\n\n");

  const userParts: string[] = [
    `Current node id: ${input.nodeId}`,
    "",
    "## Current node Markdown",
    input.currentMarkdown || "[Empty]",
    "",
    "## Read-only context from other nodes",
    input.contextMarkdown || "No other confirmed context.",
    "",
    "## Recent chat messages",
    formattedMessages || "No recent messages.",
  ];

  const stream = streamOpenAICompatibleChat({
    apiBaseUrl: input.apiBaseUrl,
    apiUrlMode: input.apiUrlMode,
    apiKey: input.apiKey,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    messages: [
      { role: "system", content: systemParts.join("\n") },
      { role: "user", content: userParts.join("\n") },
    ],
  });

  for await (const part of stream) {
    if (part.type === "content") {
      yield part.content;
    }
  }
}

// ---------------------------------------------------------------------------
// Validate rewritten node markdown
// ---------------------------------------------------------------------------

export function validateRewrittenNodeMarkdown(
  nodeId: WorkflowNodeId,
  markdown: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return { ok: false, error: "重写结果为空" };
  }

  const nodeDef = getNodeDefinition(nodeId);
  if (!nodeDef) {
    return { ok: false, error: "未知节点" };
  }

  const schema = getDeliverySchema(nodeId);
  if (!schema) {
    return { ok: false, error: "未知节点骨架" };
  }

  let root: Root;
  try {
    root = fromMarkdown(trimmed, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Root;
  } catch {
    return { ok: false, error: "Markdown 解析失败" };
  }

  // 1. Check exactly one H1 and its text matches the node title
  const headings = root.children.filter(
    (child): child is Heading => child.type === "heading",
  );
  const h1s = headings.filter((h) => h.depth === 1);

  if (h1s.length !== 1) {
    return { ok: false, error: "一级标题不匹配" };
  }

  const h1Text = extractHeadingText(h1s[0]);
  if (h1Text !== nodeDef.title) {
    return { ok: false, error: "一级标题不匹配" };
  }

  // 2. Check all required schema sections present
  const sectionHeadings = headings.filter((h) => h.depth >= 2);
  const sectionHeadingTexts = sectionHeadings.map((h) => extractHeadingText(h));

  for (const section of schema.sections) {
    if (!section.required) continue;
    const found = sectionHeadingTexts.some((text) => text === section.heading);
    if (!found) {
      return { ok: false, error: `缺少必填小节：${section.heading}` };
    }
  }

  // 3. Check section order matches schema (skip optional sections that are omitted)
  const schemaOrderedHeadings = schema.sections.map((s) => s.heading);
  const presentHeadings = sectionHeadingTexts.filter((text) =>
    schemaOrderedHeadings.includes(text),
  );

  // Filter schema headings to only those present in the markdown
  const expectedOrder = schemaOrderedHeadings.filter((h) => presentHeadings.includes(h));

  // Check that present headings appear in the same relative order as schema
  let schemaIdx = 0;
  for (const heading of presentHeadings) {
    // Find this heading in the remaining schema headings
    const foundIdx = expectedOrder.indexOf(heading, schemaIdx);
    if (foundIdx === -1) {
      // Heading not in expected order at all — will be caught by cross-node check
      continue;
    }
    schemaIdx = foundIdx + 1;
  }

  // More precise order check: the present headings must be a subsequence of expectedOrder
  let ei = 0;
  for (const h of presentHeadings) {
    while (ei < expectedOrder.length && expectedOrder[ei] !== h) {
      ei++;
    }
    if (ei >= expectedOrder.length) {
      return { ok: false, error: "小节顺序与骨架不一致" };
    }
    ei++;
  }

  // 4. Check no cross-node headings
  for (const otherNode of WORKFLOW_NODES) {
    if (otherNode.id === nodeId) continue;
    for (const heading of sectionHeadings) {
      const text = extractHeadingText(heading);
      if (text === otherNode.title) {
        return { ok: false, error: "包含其他节点的标题" };
      }
    }
  }

  return { ok: true };
}

function extractHeadingText(heading: Heading): string {
  return heading.children
    .filter((child): child is Text => child.type === "text")
    .map((child) => child.value)
    .join("")
    .trim();
}
