# Sion Chat Experience Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a professional desktop chat experience with explicit Agent activity, live collapsed reasoning feedback, safe Markdown rendering, document-quality delivery preview, and per-turn/session token accounting.

**Architecture:** Extend the existing provider-neutral model layer with normalized usage events and collect every model call under a server-created `turnId`. Persist the aggregate on the assistant message and return that authoritative message in the final SSE event. Split the large chat UI into focused activity, reasoning, Markdown, and usage components while retaining the current local JSON store and three-column workbench.

**Tech Stack:** Next.js 16.2.9 App Router Route Handlers, React 19 Client Components, TypeScript 5, Tailwind CSS 4, react-markdown 10, remark-gfm 4, Vitest 4, Testing Library.

---

## Preparation

The repository may contain unrelated in-progress browser-search changes. At execution time, use `superpowers:using-git-worktrees` if those changes are still present, or otherwise preserve them and stage only files named by each task. Before changing Next.js code, retain the conventions confirmed in these bundled guides:

- `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/02-guides/streaming.md`

## File Map

**Create**

- `src/lib/project/token-usage.ts`: token validation, fallback estimation, per-call construction, and turn/session aggregation.
- `src/lib/project/token-usage.test.ts`: deterministic unit coverage for the usage domain.
- `src/components/workbench/markdown-content.tsx`: shared safe GFM renderer with chat/document variants.
- `src/components/workbench/markdown-content.test.tsx`: Markdown semantics and safety tests.
- `src/components/workbench/agent-activity.tsx`: stage indicator and live elapsed-time presentation.
- `src/components/workbench/agent-activity.test.tsx`: stage, timer, completion, and reduced-motion-facing markup tests.
- `src/components/workbench/token-usage-details.tsx`: per-message and session usage disclosure UI.
- `src/components/workbench/token-usage-details.test.tsx`: exact, estimated, mixed, and unavailable UI tests.
- `src/components/workbench/chat-message.tsx`: user/system/assistant presentation and collapsed reasoning disclosure.
- `src/components/workbench/chat-message.test.tsx`: Markdown, reasoning, source, duration, and usage integration tests.

**Modify**

- `src/lib/project/types.ts`: persisted usage, activity, and SSE contracts.
- `src/lib/project/model-tools.ts`: internal model-turn usage event.
- `src/lib/project/llm.ts`: Chat Completions usage parsing and detailed non-stream result.
- `src/lib/project/llm.test.ts`: Chat Completions exact/fallback usage behavior.
- `src/lib/project/openai-responses.ts`: Responses usage parsing and detailed non-stream result.
- `src/lib/project/openai-responses.test.ts`: Responses exact/fallback usage behavior.
- `src/lib/project/model-chat.ts`: provider-neutral usage tracking wrappers.
- `src/lib/project/model-chat.test.ts`: protocol dispatch and callback tests.
- `src/lib/project/web-tool-orchestrator.ts`: call-category propagation for answer and tool-planning calls.
- `src/lib/project/web-tool-orchestrator.test.ts`: multi-call usage callback coverage.
- `src/lib/project/node-fact-judge.ts`: report fact-judge usage into the current turn.
- `src/lib/project/node-fact-judge.test.ts`: judge usage callback coverage.
- `src/lib/project/store.test.ts`: persisted message usage and legacy compatibility coverage.
- `src/app/api/projects/[projectId]/chat/route.ts`: authoritative activity events, turn lifecycle, whole-turn usage, and final assistant message.
- `src/app/api/projects/[projectId]/chat/chat-api.test.ts`: SSE ordering, persistence, usage, error, and abort coverage.
- `src/components/workbench/chat-panel.tsx`: consume activity/final-message events and compose extracted components.
- `src/components/workbench/chat-panel.test.tsx`: streaming activity, interruption, usage, and session totals.
- `src/components/workbench/markdown-panel.tsx`: shared renderer and document-preview metadata.
- `src/components/workbench/markdown-panel.test.tsx`: preview semantics and streaming behavior.
- `src/components/workbench/node-sidebar.tsx`: collapsed desktop navigation.
- `src/components/workbench/workbench-shell.tsx`: constrained responsive grid and sidebar state.
- `src/components/workbench/workbench-shell.test.tsx`: collapse behavior and overflow classes.
- `src/app/globals.css`: chat Markdown, document paper, activity, motion, and overflow styles.

### Task 1: Define the token-usage domain

**Files:**
- Create: `src/lib/project/token-usage.ts`
- Create: `src/lib/project/token-usage.test.ts`
- Modify: `src/lib/project/types.ts`

- [ ] **Step 1: Write failing domain tests**

Add tests covering exact normalization, mixed Chinese/Latin estimation, invalid values, mixed-source aggregation, and legacy messages:

```ts
import { describe, expect, it } from "vitest";
import {
  aggregateTokenUsage,
  aggregateUsageFromMessages,
  buildModelCallUsage,
  estimateTokenCount,
  normalizeProviderUsage,
} from "./token-usage";

describe("token usage", () => {
  it("normalizes valid provider usage and rejects negative values", () => {
    expect(normalizeProviderUsage({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }))
      .toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(normalizeProviderUsage({ inputTokens: -1, outputTokens: 8, totalTokens: 7 }))
      .toBeNull();
  });

  it("estimates mixed text deterministically", () => {
    expect(estimateTokenCount("你好abcd")).toBe(3);
  });

  it("marks a turn mixed when exact and estimated calls are combined", () => {
    const calls = [
      buildModelCallUsage({ id: "c1", category: "answer", model: "m", providerId: "p", exact: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, inputText: "", outputText: "" }),
      buildModelCallUsage({ id: "c2", category: "fact_judge", model: "m", providerId: "p", inputText: "你好", outputText: "结果" }),
    ];
    expect(aggregateTokenUsage("turn-1", calls)).toMatchObject({ source: "mixed", callCount: 2 });
  });

  it("ignores legacy messages without usage", () => {
    expect(aggregateUsageFromMessages([{ id: "old", role: "assistant", content: "old", createdAt: "2026-06-22T00:00:00Z" }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run: `npm run test -- src/lib/project/token-usage.test.ts`

Expected: FAIL because `./token-usage` and the new types do not exist.

- [ ] **Step 3: Add persisted usage contracts**

Add these contracts to `src/lib/project/types.ts` and make `usage` and `reasoningDurationMs` optional on `ChatMessage` for backward compatibility:

```ts
export type TokenUsageSource = "exact" | "estimated" | "mixed";
export type ModelCallCategory = "answer" | "tool_planning" | "fact_judge" | "document_update";

export type ProviderTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ModelCallUsage = ProviderTokenUsage & {
  id: string;
  category: ModelCallCategory;
  providerId: string;
  model: string;
  source: Exclude<TokenUsageSource, "mixed">;
  status: "completed" | "interrupted" | "failed";
};

export type TurnTokenUsage = ProviderTokenUsage & {
  turnId: string;
  source: TokenUsageSource;
  callCount: number;
  calls: ModelCallUsage[];
};
```

Extend `ChatMessage` with `turnId?: string`, `usage?: TurnTokenUsage`, and `reasoningDurationMs?: number`.

- [ ] **Step 4: Implement validation, estimation, and aggregation**

Implement `token-usage.ts` with the following public behavior:

```ts
import type { ChatMessage, ModelCallUsage, ModelCallCategory, ProviderTokenUsage, TurnTokenUsage } from "./types";

export function normalizeProviderUsage(value: ProviderTokenUsage): ProviderTokenUsage | null {
  const values = [value.inputTokens, value.outputTokens, value.totalTokens];
  if (values.some((item) => !Number.isFinite(item) || item < 0 || !Number.isInteger(item))) return null;
  if (value.totalTokens !== value.inputTokens + value.outputTokens) return null;
  return value;
}

export function estimateTokenCount(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk + other / 4);
}

export function buildModelCallUsage(input: {
  id: string; category: ModelCallCategory; providerId: string; model: string;
  inputText: string; outputText: string; exact?: ProviderTokenUsage | null;
  status?: ModelCallUsage["status"];
}): ModelCallUsage {
  const exact = input.exact ? normalizeProviderUsage(input.exact) : null;
  const estimated = {
    inputTokens: estimateTokenCount(input.inputText),
    outputTokens: estimateTokenCount(input.outputText),
  };
  const counts = exact ?? { ...estimated, totalTokens: estimated.inputTokens + estimated.outputTokens };
  return { ...counts, id: input.id, category: input.category, providerId: input.providerId, model: input.model, source: exact ? "exact" : "estimated", status: input.status ?? "completed" };
}

export function aggregateTokenUsage(turnId: string, calls: ModelCallUsage[]): TurnTokenUsage | null {
  if (calls.length === 0) return null;
  const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const outputTokens = calls.reduce((sum, call) => sum + call.outputTokens, 0);
  const sources = new Set(calls.map((call) => call.source));
  return { turnId, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, source: sources.size > 1 ? "mixed" : calls[0].source, callCount: calls.length, calls };
}

export function aggregateUsageFromMessages(messages: ChatMessage[]): TurnTokenUsage | null {
  const turns = messages.flatMap((message) => message.usage?.calls ?? []);
  return aggregateTokenUsage("session", turns);
}
```

- [ ] **Step 5: Run and commit**

Run: `npm run test -- src/lib/project/token-usage.test.ts`

Expected: PASS.

Commit:

```bash
git add src/lib/project/types.ts src/lib/project/token-usage.ts src/lib/project/token-usage.test.ts
git commit -m "feat(chat): add token usage domain"
```

### Task 2: Extract exact usage from both model protocols

**Files:**
- Modify: `src/lib/project/llm.ts`
- Modify: `src/lib/project/llm.test.ts`
- Modify: `src/lib/project/openai-responses.ts`
- Modify: `src/lib/project/openai-responses.test.ts`
- Modify: `src/lib/project/model-tools.ts`

- [ ] **Step 1: Add failing Chat Completions adapter tests**

Test a final streaming usage chunk and a non-stream response:

```ts
it("emits exact usage from the final streaming chunk", async () => {
  const parts = await collect(streamOpenAICompatibleChat({
    ...input,
    fetchImpl: mockSse([
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } },
    ]),
  }));
  expect(parts.at(-1)).toEqual({ type: "usage", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
});
```

Also assert that the request includes `stream_options: { include_usage: true }`. Add a test that a 400 response mentioning `stream_options` is retried once without that field.

- [ ] **Step 2: Add failing Responses adapter tests**

Use a `response.completed` event containing `usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 }` and expect the same normalized usage event.

- [ ] **Step 3: Run the focused tests and verify failures**

Run: `npm run test -- src/lib/project/llm.test.ts src/lib/project/openai-responses.test.ts`

Expected: FAIL because adapter event unions do not contain `usage`.

- [ ] **Step 4: Implement normalized adapter events**

Add an internal event to `LlmStreamPart`, `ModelStreamPart`, and `ModelTurnEvent`:

```ts
| { type: "usage"; usage: ProviderTokenUsage }
```

For Chat Completions, parse `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.total_tokens`. For Responses, parse `response.usage.input_tokens`, `output_tokens`, and `total_tokens` on `response.completed`. Normalize field names before yielding. Add `stream_options: { include_usage: true }` to streaming Chat Completions and retry once without it only when the initial response is `400` and its body mentions `stream_options`.

Add detailed non-stream helpers while preserving existing string-returning APIs:

```ts
export type ModelTextResult = { content: string; usage: ProviderTokenUsage | null };

export async function callOpenAICompatibleChatDetailed(input: CallOpenAICompatibleChatInput): Promise<ModelTextResult>;
export async function callOpenAIResponsesDetailed(input: ResponsesInput): Promise<ModelTextResult>;
```

Existing `callOpenAICompatibleChat` and `callOpenAIResponses` call the detailed helpers and return `.content`.

- [ ] **Step 5: Run and commit**

Run: `npm run test -- src/lib/project/llm.test.ts src/lib/project/openai-responses.test.ts`

Expected: PASS.

Commit:

```bash
git add src/lib/project/llm.ts src/lib/project/llm.test.ts src/lib/project/openai-responses.ts src/lib/project/openai-responses.test.ts src/lib/project/model-tools.ts
git commit -m "feat(chat): read provider token usage"
```

### Task 3: Track every provider-neutral model call

**Files:**
- Modify: `src/lib/project/model-chat.ts`
- Modify: `src/lib/project/model-chat.test.ts`
- Modify: `src/lib/project/web-tool-orchestrator.ts`
- Modify: `src/lib/project/web-tool-orchestrator.test.ts`
- Modify: `src/lib/project/node-fact-judge.ts`
- Modify: `src/lib/project/node-fact-judge.test.ts`

- [ ] **Step 1: Write failing model tracking tests**

Cover exact usage, fallback estimation when no usage event arrives, and interrupted status. Use this tracking contract:

```ts
export type ModelUsageContext = {
  turnId: string;
  category: ModelCallCategory;
  providerId: string;
  onUsage: (usage: ModelCallUsage) => void;
};
```

Assert that content/reasoning events remain unchanged while exactly one usage callback fires per provider request.

- [ ] **Step 2: Run the model tests and verify failures**

Run: `npm run test -- src/lib/project/model-chat.test.ts`

Expected: FAIL because `ModelUsageContext` is absent.

- [ ] **Step 3: Implement provider-neutral tracking**

Add optional `usageContext` to `ModelChatInput` and `ModelTurnInput`. Wrap both stream protocols so the wrapper:

1. serializes the actual messages/conversation as `inputText`;
2. accumulates content and reasoning deltas as `outputText`;
3. captures an exact adapter usage event when present;
4. calls `buildModelCallUsage` once when the request completes, fails, or aborts;
5. never forwards the internal usage event to UI consumers.

Use `randomUUID()` for call IDs on the server. Pass `status: "interrupted"` when `signal.aborted`, `"failed"` when the provider throws, and `"completed"` otherwise.

- [ ] **Step 4: Add failing orchestration tests for call categories**

In `web-tool-orchestrator.test.ts`, simulate one tool-planning call plus one final-answer call and assert two callback records categorized as `tool_planning` and `answer`. In `node-fact-judge.test.ts`, assert the judge reports `fact_judge` into the supplied turn.

- [ ] **Step 5: Propagate usage context through orchestration and judging**

Extend `WebOrchestratorInput` with `turnId`, `providerId`, and `onUsage`. Pass category `tool_planning` to tool-capable rounds and fallback planning, and `answer` to the final no-tools call. Extend `JudgeNodeFactsInput` with the same turn identity/callback and pass category `fact_judge` to `callModelChat`.

Keep dependency injection compatible by allowing test `streamTurn`/`callText` functions to omit usage; only the default model-backed functions report it.

- [ ] **Step 6: Run and commit**

Run: `npm run test -- src/lib/project/model-chat.test.ts src/lib/project/web-tool-orchestrator.test.ts src/lib/project/node-fact-judge.test.ts`

Expected: PASS.

Commit:

```bash
git add src/lib/project/model-chat.ts src/lib/project/model-chat.test.ts src/lib/project/web-tool-orchestrator.ts src/lib/project/web-tool-orchestrator.test.ts src/lib/project/node-fact-judge.ts src/lib/project/node-fact-judge.test.ts
git commit -m "feat(chat): track whole-turn model usage"
```

### Task 4: Make activity and persisted assistant messages authoritative

**Files:**
- Modify: `src/lib/project/types.ts`
- Modify: `src/lib/project/store.test.ts`
- Modify: `src/app/api/projects/[projectId]/chat/route.ts`
- Modify: `src/app/api/projects/[projectId]/chat/chat-api.test.ts`

- [ ] **Step 1: Add failing store compatibility tests**

Persist an assistant message containing `turnId`, `reasoningDurationMs`, and `usage`, then reload it and expect exact equality. Retain the existing legacy fixture and assert messages lacking these optional fields still load.

- [ ] **Step 2: Add failing API contract tests**

Assert the success stream contains ordered activity stages and an authoritative final message:

```ts
expect(events).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: "activity", stage: "thinking" }),
  expect.objectContaining({ type: "activity", stage: "generating_answer" }),
  expect.objectContaining({ type: "activity", stage: "updating_document" }),
  expect.objectContaining({
    type: "done",
    sessionId: expect.any(String),
    assistantMessage: expect.objectContaining({ turnId: expect.any(String), usage: expect.objectContaining({ callCount: 2 }) }),
  }),
]));
```

Add separate tests for selected files (`reading_files`), search events (`searching_web`), sanitized failure (`failed`), and aborted partial persistence without a `done` event.

- [ ] **Step 3: Run the route/store tests and verify failures**

Run: `npm run test -- src/lib/project/store.test.ts 'src/app/api/projects/[projectId]/chat/chat-api.test.ts'`

Expected: FAIL because activity and final-message contracts are absent.

- [ ] **Step 4: Add activity contracts**

Add to `types.ts`:

```ts
export type AgentActivityStage = "idle" | "thinking" | "reading_files" | "searching_web" | "generating_answer" | "updating_document" | "completed" | "failed" | "interrupted";
export type AgentActivityEvent = { type: "activity"; stage: Exclude<AgentActivityStage, "idle">; summary: string; at: string };
```

Include `AgentActivityEvent` in `ChatStreamEvent`, change `done` to include `assistantMessage: ChatMessage`, and allow `error` to include an optional persisted `assistantMessage`.

- [ ] **Step 5: Refactor the chat Route Handler lifecycle**

Inside `POST`, create `turnId`, `assistantMessageId`, `turnStartedAt`, a `ModelCallUsage[]`, and an `onUsage` collector before streaming. Move selected-file reads into `ReadableStream.start` so `reading_files` is emitted before the work actually occurs. Emit stages with these summaries:

```ts
sendActivity("thinking", "正在分析需求");
sendActivity("reading_files", "正在读取所选项目文件");
sendActivity("searching_web", "正在检索外部资料");
sendActivity("generating_answer", "正在生成回复");
sendActivity("updating_document", "正在检查交付稿更新");
```

Pass the collector through `runWebOrchestrator` and `judgeNodeFacts`. Record the time of the first content token and compute `reasoningDurationMs` from request start to first content, or to completion when no content token arrives.

On success, aggregate calls, append one assistant message after the judge completes, emit `completed`, then emit `done` with that saved message. On a non-abort error, save partial content/reasoning and valid usage when present, emit `failed`, then emit sanitized `error`. On abort, save partial data in `finally` but do not enqueue after the request signal aborts.

Ensure a single helper guarded by `assistantPersisted` prevents duplicate assistant messages across success, error, and abort paths.

- [ ] **Step 6: Run and commit**

Run: `npm run test -- src/lib/project/store.test.ts 'src/app/api/projects/[projectId]/chat/chat-api.test.ts'`

Expected: PASS.

Commit:

```bash
git add src/lib/project/types.ts src/lib/project/store.test.ts 'src/app/api/projects/[projectId]/chat/route.ts' 'src/app/api/projects/[projectId]/chat/chat-api.test.ts'
git commit -m "feat(chat): stream activity and persist turn usage"
```

### Task 5: Build the shared safe Markdown renderer

**Files:**
- Create: `src/components/workbench/markdown-content.tsx`
- Create: `src/components/workbench/markdown-content.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing rendering and safety tests**

Test GFM tables, task lists, external links, code copy, raw HTML safety, and render-error fallback:

```tsx
render(<MarkdownContent markdown={'# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>'} variant="chat" />);
expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
expect(screen.getByRole("table")).toBeInTheDocument();
expect(document.querySelector("script")).toBeNull();
```

Also assert external links have `target="_blank"` and `rel="noreferrer noopener"`, while code blocks expose a “复制代码” button. Mock the Markdown renderer to throw once and assert the boundary displays the original content as plain text rather than removing the message.

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test -- src/components/workbench/markdown-content.test.tsx`

Expected: FAIL because `MarkdownContent` does not exist.

- [ ] **Step 3: Implement the shared renderer**

Create a client component using `ReactMarkdown` and `remarkGfm`:

```tsx
export function MarkdownContent({ markdown, variant }: { markdown: string; variant: "chat" | "document" }) {
  return (
    <div className={cn("markdown-content", variant === "document" ? "markdown-document" : "markdown-chat")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href = "", children }) => <a href={href} rel="noreferrer noopener" target="_blank">{children}</a>,
          table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
```

Do not add `rehype-raw`; react-markdown's default raw-HTML behavior is the safety boundary. Implement `CodeBlock` with local copied state and `navigator.clipboard.writeText` using the rendered code text. Wrap the renderer in a small class-based `MarkdownErrorBoundary` because React error boundaries still require `getDerivedStateFromError`; its fallback must render the original Markdown through a plain `<div className="whitespace-pre-wrap">` without `dangerouslySetInnerHTML`.

- [ ] **Step 4: Add scoped Markdown styles**

Replace the old `.markdown-preview` rules with `.markdown-content`, `.markdown-chat`, `.markdown-document`, `.markdown-table-scroll`, and `.markdown-code-block` rules. Explicitly set `min-width: 0`, `overflow-wrap: anywhere`, and local `overflow-x: auto` on tables and code blocks.

- [ ] **Step 5: Run and commit**

Run: `npm run test -- src/components/workbench/markdown-content.test.tsx`

Expected: PASS.

Commit:

```bash
git add src/components/workbench/markdown-content.tsx src/components/workbench/markdown-content.test.tsx src/app/globals.css
git commit -m "feat(chat): add safe shared markdown renderer"
```

### Task 6: Build Agent activity, reasoning, and usage components

**Files:**
- Create: `src/components/workbench/agent-activity.tsx`
- Create: `src/components/workbench/agent-activity.test.tsx`
- Create: `src/components/workbench/token-usage-details.tsx`
- Create: `src/components/workbench/token-usage-details.test.tsx`
- Create: `src/components/workbench/chat-message.tsx`
- Create: `src/components/workbench/chat-message.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing activity tests**

Use fake timers to assert “正在分析需求 · 8 秒”, the stage-specific class/data attribute, and the completed label. The component API is:

```ts
type AgentActivityProps = {
  stage: AgentActivityStage;
  summary: string;
  startedAt: number | null;
};
```

- [ ] **Step 2: Write failing usage disclosure tests**

Render exact, estimated, and mixed summaries. Assert the collapsed trigger shows total tokens and the expanded disclosure shows input/output, “精确”, “估算”, or “含估算”. Render `null` usage as “暂无统计” only when explicitly requested for a historical assistant message.

- [ ] **Step 3: Write failing chat-message tests**

Assert:

- user messages remain right-aligned plain text;
- assistant messages render Markdown headings and tables;
- reasoning uses a closed `<details>` by default;
- active reasoning summary and duration appear while collapsed;
- historical reasoning shows `已思考 12 秒` from `reasoningDurationMs`;
- source links and usage remain visible below content.

- [ ] **Step 4: Run component tests and verify failures**

Run: `npm run test -- src/components/workbench/agent-activity.test.tsx src/components/workbench/token-usage-details.test.tsx src/components/workbench/chat-message.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 5: Implement the components**

Use semantic, testable markup:

```tsx
<div className="agent-activity" data-stage={stage} aria-live="polite">
  <span className="agent-activity-dot" aria-hidden="true" />
  <span>{label}</span>
  <span>{summary}{elapsed === null ? "" : ` · ${elapsed} 秒`}</span>
</div>
```

Use `<details>`/`<summary>` for both reasoning and token disclosures so keyboard behavior works without another UI dependency. `ChatMessage` delegates assistant body rendering to `MarkdownContent variant="chat"` and keeps system/user messages on their existing plain-text paths.

- [ ] **Step 6: Add professional activity and motion styles**

Define stage colors through `data-stage`, use a restrained pulse only for active stages, fade streamed content with a short animation, and add:

```css
@media (prefers-reduced-motion: reduce) {
  .agent-activity-dot,
  .chat-stream-enter { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 7: Run and commit**

Run: `npm run test -- src/components/workbench/agent-activity.test.tsx src/components/workbench/token-usage-details.test.tsx src/components/workbench/chat-message.test.tsx`

Expected: PASS.

Commit:

```bash
git add src/components/workbench/agent-activity.tsx src/components/workbench/agent-activity.test.tsx src/components/workbench/token-usage-details.tsx src/components/workbench/token-usage-details.test.tsx src/components/workbench/chat-message.tsx src/components/workbench/chat-message.test.tsx src/app/globals.css
git commit -m "feat(chat): add professional message activity UI"
```

### Task 7: Integrate authoritative activity and usage into ChatPanel

**Files:**
- Modify: `src/components/workbench/chat-panel.tsx`
- Modify: `src/components/workbench/chat-panel.test.tsx`

- [ ] **Step 1: Update the mock SSE and write failing integration tests**

Make the default mock stream send `activity` events and a `done.assistantMessage` containing usage. Add tests that:

- the collapsed reasoning header keeps updating while tokens stream;
- search and document-update events change the visible stage;
- `done` replaces the optimistic assistant message with the server message;
- single-turn usage is clickable;
- session usage totals all loaded assistant messages;
- pressing stop changes local state to `interrupted` and clears active animation;
- unknown activity stages display “处理中” and do not crash.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run test -- src/components/workbench/chat-panel.test.tsx`

Expected: FAIL because `ChatPanel` ignores activity and final-message payloads.

- [ ] **Step 3: Replace inline message rendering with focused components**

Remove `MessageBubble` from `chat-panel.tsx`. Add state:

```ts
const [activity, setActivity] = useState<{ stage: AgentActivityStage; summary: string; startedAt: number | null }>({
  stage: "idle",
  summary: "等待输入",
  startedAt: null,
});
```

Compose `AgentActivity`, `ChatMessage`, and `TokenUsageDetails`. Derive the session total with `aggregateUsageFromMessages(messages)` using `useMemo`.

- [ ] **Step 4: Consume structured SSE events**

On `activity`, update the stage/summary and preserve the first active `startedAt`. On `done`, await the text animation buffer, replace the temporary assistant message by ID/content with `event.assistantMessage`, set `completed`, and then return to idle after a short timeout. On `error`, use any returned assistant message and set `failed`. On the stop button, abort, stop the text buffer, and set `interrupted` immediately.

Map legacy web events only as a defensive fallback; structured `activity` remains authoritative.

- [ ] **Step 5: Remove duplicate notice strips**

Remove ordinary URL/search/draft progress strips now represented by `AgentActivity`. Keep actionable browser verification and error notices. This prevents two different status systems from disagreeing.

- [ ] **Step 6: Run and commit**

Run: `npm run test -- src/components/workbench/chat-panel.test.tsx`

Expected: PASS.

Commit:

```bash
git add src/components/workbench/chat-panel.tsx src/components/workbench/chat-panel.test.tsx
git commit -m "feat(chat): integrate activity and token usage"
```

### Task 8: Upgrade the delivery document preview

**Files:**
- Modify: `src/components/workbench/markdown-panel.tsx`
- Modify: `src/components/workbench/markdown-panel.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing preview tests**

Switch to the preview tab and assert the document renderer, title, character count, updated time, and copy button. During `previewing_rewrite`, assert the renderer receives the streaming candidate but the active tab is not changed programmatically.

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test -- src/components/workbench/markdown-panel.test.tsx`

Expected: FAIL because the old inline `ReactMarkdown` preview lacks document metadata.

- [ ] **Step 3: Use the shared document renderer**

Remove direct `ReactMarkdown` and `remarkGfm` imports. Calculate `displayMarkdown` once from the existing generation/conflict rules, then render:

```tsx
<div className="document-workspace">
  <header className="document-toolbar">
    <div><strong>{node.id}</strong><span>{displayMarkdown.length.toLocaleString("zh-CN")} 字符 · {new Date(node.updatedAt).toLocaleString("zh-CN")}</span></div>
    <Button onClick={() => navigator.clipboard.writeText(displayMarkdown)} size="sm" variant="outline">复制文档</Button>
  </header>
  <article className="document-paper">
    <MarkdownContent markdown={displayMarkdown} variant="document" />
  </article>
</div>
```

Keep the current edit/preview/agent tab ownership and generation state machine unchanged.

- [ ] **Step 4: Add document-workspace styles**

Use a muted workspace background, centered white paper, `max-width: 52rem`, document padding, restrained shadow, and denser print-quality table styles. Keep all overflow local to the preview panel.

- [ ] **Step 5: Run and commit**

Run: `npm run test -- src/components/workbench/markdown-panel.test.tsx`

Expected: PASS.

Commit:

```bash
git add src/components/workbench/markdown-panel.tsx src/components/workbench/markdown-panel.test.tsx src/app/globals.css
git commit -m "feat(delivery): add document-quality markdown preview"
```

### Task 9: Eliminate desktop page overflow and add sidebar collapse

**Files:**
- Modify: `src/components/workbench/node-sidebar.tsx`
- Modify: `src/components/workbench/workbench-shell.tsx`
- Modify: `src/components/workbench/workbench-shell.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing layout tests**

Assert the workbench root has `overflow-hidden`, all three grid children have `min-w-0`, and the “折叠流程节点” button changes the grid/sidebar state while preserving node selection.

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test -- src/components/workbench/workbench-shell.test.tsx`

Expected: FAIL because no collapse control or constrained grid state exists.

- [ ] **Step 3: Add a controlled collapsed NodeSidebar**

Extend props with `collapsed: boolean` and `onToggle: () => void`. In collapsed mode show the node number and an accessible title, hide document headings and badges, and keep the active indicator. The toggle button label must switch between “折叠流程节点” and “展开流程节点”.

- [ ] **Step 4: Constrain the workbench grid**

In `WorkbenchShell`, add `sidebarCollapsed` state and use:

```tsx
<main className="flex h-screen min-h-[720px] min-w-0 flex-col overflow-hidden bg-background text-foreground">
  <section className={cn(
    "grid min-h-0 min-w-0 flex-1 overflow-hidden",
    sidebarCollapsed
      ? "grid-cols-[64px_minmax(0,0.9fr)_minmax(0,1.1fr)]"
      : "grid-cols-[240px_minmax(0,0.9fr)_minmax(0,1.1fr)]",
  )}>
```

Add `min-w-0 overflow-hidden` to `NodeSidebar`, `ChatPanel`, and `MarkdownPanel` roots. Add a base `body { overflow-x: hidden; }` safeguard, while keeping code/table scrollers functional.

- [ ] **Step 5: Run and commit**

Run: `npm run test -- src/components/workbench/workbench-shell.test.tsx`

Expected: PASS.

Commit:

```bash
git add src/components/workbench/node-sidebar.tsx src/components/workbench/workbench-shell.tsx src/components/workbench/workbench-shell.test.tsx src/components/workbench/chat-panel.tsx src/components/workbench/markdown-panel.tsx src/app/globals.css
git commit -m "fix(workbench): prevent desktop horizontal overflow"
```

### Task 10: Run full regression and browser verification

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
npm run test
npm run lint
npm run typecheck
```

Expected: all commands exit 0. Fix only regressions introduced by this plan, rerunning the affected focused test before the full command.

- [ ] **Step 2: Start the application**

Run: `npm run dev`

Expected: Next.js starts without compilation errors and prints the local URL.

- [ ] **Step 3: Verify the 1280px desktop workflow in the in-app browser**

Use `browser:control-in-app-browser` and verify at a 1280px-wide viewport:

1. no page-level horizontal scrollbar;
2. sidebar collapse and expansion preserve the selected node;
3. sending a message immediately shows `thinking` and elapsed time;
4. the closed reasoning disclosure visibly remains active during streaming;
5. Agent headings, lists, tables, links, and code render as Markdown;
6. only table/code containers scroll horizontally;
7. per-turn usage opens and labels exact/estimated/mixed correctly;
8. session usage equals the sum of visible persisted turns;
9. delivery preview looks like a centered paper document;
10. stopping a response produces `interrupted` and ends animation.

- [ ] **Step 4: Verify reduced motion**

Emulate `prefers-reduced-motion: reduce` in the browser and confirm activity/content animations stop while status text remains visible.

- [ ] **Step 5: Inspect the final diff and commit verification fixes**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended feature files are modified. If verification required fixes, rerun the focused test from the owning task, stage the files with that task's explicit `git add` command, and commit with `git commit -m "fix(chat): address experience verification findings"`. Do not create that commit when verification produced no changes.
