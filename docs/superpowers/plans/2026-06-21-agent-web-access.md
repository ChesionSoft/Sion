# Agent Web Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic safe reading of public URLs and an explicit per-session OpenAI Responses Web Search switch without disrupting providers that only support Chat Completions.

**Architecture:** Keep URL reading and Web Search as independent server-side capabilities. Normalize both into persisted `ExternalSource` records, route all model calls through protocol-aware adapters, and keep the session record as the only source of truth for the search switch. Use a pinned-address HTTP reader with manual redirect validation for SSRF protection.

**Tech Stack:** Next.js 16.2.9 Route Handlers, React 19, TypeScript 5, Vitest, OpenAI Chat Completions/Responses HTTP APIs, `undici`, `cheerio`, `ipaddr.js`.

---

## Scope And File Map

Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` before changing Route Handlers. This version uses promised route params and uncached request-time handlers.

Files with one clear responsibility:

- `src/lib/project/types.ts`: persisted provider/session/message/source types and SSE event contracts.
- `src/lib/settings/model-providers.ts`: provider protocol migration and validation.
- `src/lib/project/store.ts`: session preference and message-source persistence.
- `src/lib/project/external-source.ts`: URL normalization, source IDs and deduplication.
- `src/lib/project/url-content.ts`: URL extraction and HTML/plain-text normalization; no network I/O.
- `src/lib/project/url-reader.ts`: DNS validation, pinned network requests, redirects and limits.
- `src/lib/project/openai-responses.ts`: OpenAI Responses request and SSE parsing.
- `src/lib/project/model-chat.ts`: protocol-aware non-streaming and streaming model dispatch.
- `src/lib/project/node-fact-judge.ts`: external-evidence downgrade and traceability rules.
- `src/app/api/projects/[projectId]/chat/route.ts`: orchestration only: session, URL reads, model stream, persistence and fact judge.
- `src/app/api/projects/[projectId]/chat/sessions/[sessionId]/route.ts`: session preference PATCH endpoint.
- `src/components/workbench/chat-panel.tsx`: search switch, URL status, unavailable notice and sources UI.
- `src/components/workbench/model-config-panel.tsx`: explicit provider protocol selection.

Do not put network reads in Client Components. Do not add a generic search-provider registry, browser automation, authenticated URL fetching or search-result scraping.

### Task 1: Add Provider Protocol With Backward-Compatible Migration

**Files:**
- Modify: `src/lib/project/types.ts`
- Modify: `src/lib/settings/model-providers.ts`
- Modify: `src/lib/settings/model-providers.test.ts`
- Modify: `src/components/workbench/model-config-panel.tsx`
- Modify: `src/components/workbench/model-config-panel.test.tsx`

- [ ] **Step 1: Write failing store migration and validation tests**

Add tests that create a legacy provider JSON without `protocol`, verify it reads as `chat_completions`, create a provider with `openai_responses`, and reject an unknown protocol through `createProvider`.

```ts
it("migrates a provider without protocol to chat_completions", async () => {
  await writeFile(filePath, JSON.stringify([{ ...legacyProvider, protocol: undefined }]));
  expect((await store.listProviders())[0].protocol).toBe("chat_completions");
});

it("persists an OpenAI Responses provider", async () => {
  const provider = await store.createProvider({
    name: "OpenAI Responses",
    apiBaseUrl: "https://api.openai.com",
    apiKey: "secret",
    protocol: "openai_responses",
    models: [{ name: "gpt-5", isDefault: true }],
  });
  expect(provider.protocol).toBe("openai_responses");
});

it("rejects an unknown provider protocol", async () => {
  await expect(store.createProvider({ ...validInput, protocol: "other" as never }))
    .rejects.toThrow("不支持的 API 协议");
});
```

- [ ] **Step 2: Run the focused store tests and verify RED**

Run: `npm run test -- src/lib/settings/model-providers.test.ts`

Expected: FAIL because `protocol` is absent from the types and migration.

- [ ] **Step 3: Add the provider protocol type and migration**

Add the exact type and make it required in the normalized persisted object:

```ts
export type ModelProviderProtocol = "chat_completions" | "openai_responses";

export type ModelProvider = {
  // existing fields
  protocol: ModelProviderProtocol;
};
```

Update inputs and normalization:

```ts
export type CreateModelProviderInput = {
  // existing fields
  protocol?: ModelProviderProtocol;
};

function normalizeProtocol(value: unknown): ModelProviderProtocol {
  if (value === undefined) return "chat_completions";
  if (value === "chat_completions" || value === "openai_responses") return value;
  throw new ValidationError("不支持的 API 协议");
}
```

Call `normalizeProtocol` from create, update and `migrateProvider`. Do not silently normalize an explicitly invalid value.

- [ ] **Step 4: Run provider store tests and verify GREEN**

Run: `npm run test -- src/lib/settings/model-providers.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing protocol-selector UI tests**

Add tests that open the add/edit dialogs, choose `OpenAI Responses`, and verify the submitted object contains `protocol: "openai_responses"`. Also assert the URL hint becomes `/v1/responses`.

```ts
await user.selectOptions(screen.getByLabelText("API 协议"), "openai_responses");
expect(screen.getByText("系统会自动补全 /v1/responses。")).toBeInTheDocument();
```

- [ ] **Step 6: Run the focused UI test and verify RED**

Run: `npm run test -- src/components/workbench/model-config-panel.test.tsx`

Expected: FAIL because the protocol selector does not exist.

- [ ] **Step 7: Add protocol selectors to both provider dialogs**

Use a labeled native select in add and edit forms:

```tsx
<Label htmlFor="mp-protocol">API 协议</Label>
<select
  id="mp-protocol"
  value={protocol}
  onChange={(event) => setProtocol(event.target.value as ModelProviderProtocol)}
>
  <option value="chat_completions">OpenAI-compatible Chat Completions</option>
  <option value="openai_responses">OpenAI Responses（支持原生联网）</option>
</select>
```

The base URL hint must depend on protocol. Full URL mode remains supported and means the configured URL is used unchanged.

- [ ] **Step 8: Run Task 1 tests and commit**

Run: `npm run test -- src/lib/settings/model-providers.test.ts src/components/workbench/model-config-panel.test.tsx`

Expected: PASS.

```bash
git add src/lib/project/types.ts src/lib/settings/model-providers.ts src/lib/settings/model-providers.test.ts src/components/workbench/model-config-panel.tsx src/components/workbench/model-config-panel.test.tsx
git commit -m "feat(settings): add model provider protocol"
```

### Task 2: Persist Session Search Preference And Message Sources

**Files:**
- Modify: `src/lib/project/types.ts`
- Modify: `src/lib/project/store.ts`
- Modify: `src/lib/project/store.test.ts`
- Modify: `src/app/api/projects/[projectId]/chat/sessions/[sessionId]/route.ts`
- Modify: `src/app/api/projects/[projectId]/chat/sessions/chat-sessions-api.test.ts`

- [ ] **Step 1: Write failing store tests for migration, updates and sources**

Cover all three persisted behaviors:

```ts
it("defaults legacy sessions to web search disabled", async () => {
  await writeLegacySessionIndex([{ ...legacySession }]);
  expect((await store.listSessions(projectId, "feature-design"))[0].webSearchEnabled).toBe(false);
});

it("updates web search without changing message metadata", async () => {
  const updated = await store.updateSessionWebSearch(projectId, "feature-design", session.id, true);
  expect(updated.webSearchEnabled).toBe(true);
  expect(updated.messageCount).toBe(session.messageCount);
});

it("persists assistant external sources", async () => {
  await store.appendChatMessage(projectId, "feature-design", {
    id: "a-1",
    role: "assistant",
    content: "参考结论",
    sources: [source],
    createdAt: now,
  }, session.id);
  expect((await store.getChatMessages(projectId, "feature-design", session.id))[0].sources).toEqual([source]);
});
```

- [ ] **Step 2: Run store tests and verify RED**

Run: `npm run test -- src/lib/project/store.test.ts`

Expected: FAIL because session preference and source types do not exist.

- [ ] **Step 3: Add persisted source and session types**

```ts
export type ExternalSource = {
  id: string;
  kind: "provided_url" | "web_search";
  url: string;
  title: string;
  domain: string;
  snippet?: string;
  retrievedAt: string;
};

export type ChatMessage = {
  // existing fields
  sources?: ExternalSource[];
};

export type ChatSession = {
  // existing fields
  webSearchEnabled: boolean;
};
```

Normalize every item returned by `readSessionIndex` with `webSearchEnabled: raw.webSearchEnabled === true`. Set `false` in new and legacy-migrated sessions.

- [ ] **Step 4: Add a public session lookup and preference update**

```ts
async getSession(projectId: string, nodeId: WorkflowNodeId, sessionId: string): Promise<ChatSession> {
  const session = (await this.listSessions(projectId, nodeId)).find((item) => item.id === sessionId);
  if (!session) throw new Error("会话不存在");
  return session;
}

async updateSessionWebSearch(
  projectId: string,
  nodeId: WorkflowNodeId,
  sessionId: string,
  enabled: boolean,
): Promise<ChatSession> {
  return this.updateSession(projectId, nodeId, sessionId, { webSearchEnabled: enabled });
}
```

Widen private `updateSession` to `Partial<Pick<ChatSession, "messageCount" | "updatedAt" | "webSearchEnabled">>` and return the normalized updated session.

- [ ] **Step 5: Run store tests and verify GREEN**

Run: `npm run test -- src/lib/project/store.test.ts`

Expected: PASS.

- [ ] **Step 6: Write failing PATCH route tests**

Import `PATCH` from the session route. Assert `{ nodeId, webSearchEnabled: true }` returns the updated session; missing node, non-boolean values and a session from another node return 400/404 without mutation.

- [ ] **Step 7: Run the session API tests and verify RED**

Run: `npm run test -- src/app/api/projects/\[projectId\]/chat/sessions/chat-sessions-api.test.ts`

Expected: FAIL because `PATCH` is not exported.

- [ ] **Step 8: Implement the session PATCH endpoint**

```ts
export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const { projectId, sessionId } = await context.params;
  const body = await request.json() as { nodeId?: string; webSearchEnabled?: unknown };
  if (!body.nodeId || !isWorkflowNodeId(body.nodeId) || typeof body.webSearchEnabled !== "boolean") {
    return NextResponse.json({ error: "会话设置无效" }, { status: 400 });
  }
  const store = new ProjectStore();
  if (!await store.getProject(projectId)) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  try {
    const session = await store.updateSessionWebSearch(
      projectId, body.nodeId, sessionId, body.webSearchEnabled,
    );
    return NextResponse.json({ session });
  } catch {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }
}
```

- [ ] **Step 9: Run Task 2 tests and commit**

Run: `npm run test -- src/lib/project/store.test.ts src/app/api/projects/\[projectId\]/chat/sessions/chat-sessions-api.test.ts`

Expected: PASS.

```bash
git add src/lib/project/types.ts src/lib/project/store.ts src/lib/project/store.test.ts 'src/app/api/projects/[projectId]/chat/sessions/[sessionId]/route.ts' 'src/app/api/projects/[projectId]/chat/sessions/chat-sessions-api.test.ts'
git commit -m "feat(chat): persist session web search preference"
```

### Task 3: Normalize URLs, External Sources And Page Text

**Files:**
- Create: `src/lib/project/external-source.ts`
- Create: `src/lib/project/external-source.test.ts`
- Create: `src/lib/project/url-content.ts`
- Create: `src/lib/project/url-content.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install structured parsing dependencies**

Run: `npm install cheerio ipaddr.js undici`

Expected: dependencies and lockfile update successfully. Do not import transitive Next.js packages directly.

- [ ] **Step 2: Write failing pure-function tests**

Tests must cover trailing Chinese/ASCII punctuation, URL deduplication, the three-URL cap, stable source IDs, HTML element removal and plain text normalization.

```ts
expect(extractHttpUrls("看 https://a.test/x，另见 https://a.test/x。和 https://b.test"))
  .toEqual(["https://a.test/x", "https://b.test/"]);

expect(extractHttpUrls("https://a.test https://b.test https://c.test https://d.test"))
  .toHaveLength(3);

expect(extractPageText("text/html", "<title>A</title><nav>菜单</nav><main>正文 <b>内容</b></main>"))
  .toEqual({ title: "A", text: "正文 内容" });
```

- [ ] **Step 3: Run pure-function tests and verify RED**

Run: `npm run test -- src/lib/project/external-source.test.ts src/lib/project/url-content.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement URL and source normalization**

`external-source.ts` must expose:

```ts
export function normalizeExternalUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.toString();
}

export function createExternalSource(input: Omit<ExternalSource, "id" | "domain">): ExternalSource {
  const url = normalizeExternalUrl(input.url);
  return {
    ...input,
    id: createHash("sha256").update(`${input.kind}:${url}`).digest("hex").slice(0, 20),
    url,
    domain: new URL(url).hostname,
  };
}

export function dedupeExternalSources(sources: ExternalSource[]): ExternalSource[] {
  return [...new Map(sources.map((source) => [`${source.kind}:${source.url}`, source])).values()];
}
```

`url-content.ts` must expose `extractHttpUrls(message, limit = 3)` and `extractPageText(contentType, body)`. Use Cheerio for HTML; remove `script,style,noscript,nav,header,footer,form,svg`, prefer `main,article,[role=main]`, and collapse whitespace. Plain text follows the same whitespace and character limits.

- [ ] **Step 5: Run Task 3 tests and commit**

Run: `npm run test -- src/lib/project/external-source.test.ts src/lib/project/url-content.test.ts`

Expected: PASS.

```bash
git add package.json package-lock.json src/lib/project/external-source.ts src/lib/project/external-source.test.ts src/lib/project/url-content.ts src/lib/project/url-content.test.ts
git commit -m "feat(project): normalize external web content"
```

### Task 4: Build The SSRF-Safe URL Reader

**Files:**
- Create: `src/lib/project/url-reader.ts`
- Create: `src/lib/project/url-reader.test.ts`

- [ ] **Step 1: Write failing security and partial-failure tests**

Inject DNS and one-hop request functions. Cover public IPv4/IPv6, loopback, RFC1918, link-local, unique-local, mapped IPv4, multiple DNS answers, redirects to private addresses, body limits, MIME limits, timeout/abort and partial success.

```ts
it("revalidates every redirect and blocks a redirect to private IP", async () => {
  const lookup = vi.fn()
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
  const fetchOnce = vi.fn().mockResolvedValue({
    status: 302,
    headers: { location: "http://169.254.169.254/latest/meta-data" },
    body: new Uint8Array(),
  });
  await expect(readPublicUrl("https://public.test", { lookup, fetchOnce }))
    .rejects.toThrow("不允许访问非公网地址");
});

it("keeps successful pages when another URL fails", async () => {
  const results = await readPublicUrls([goodUrl, badUrl], deps);
  expect(results.map((item) => item.ok)).toEqual([true, false]);
});
```

- [ ] **Step 2: Run the URL reader tests and verify RED**

Run: `npm run test -- src/lib/project/url-reader.test.ts`

Expected: FAIL because `url-reader.ts` does not exist.

- [ ] **Step 3: Implement explicit public-address validation**

Use `ipaddr.js`; convert IPv4-mapped IPv6 before checking. Only `range() === "unicast"` is allowed. Validate every DNS result, not only the chosen address.

```ts
export function assertPublicAddress(address: string): void {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  if (parsed.range() !== "unicast") {
    throw new UrlReadError("blocked_address", "不允许访问非公网地址");
  }
}
```

Reject embedded credentials and any protocol except HTTP(S) before DNS resolution.

- [ ] **Step 4: Implement pinned one-hop requests and manual redirects**

Production `fetchOnce` must use an `undici.Agent` whose `connect.lookup` returns only a previously validated address. Set `maxRedirections: 0`; follow at most three redirects in `readPublicUrl`, resolving and validating each destination again.

Use fixed limits:

```ts
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARACTERS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain"];
```

Read response chunks while counting bytes; abort immediately above the limit. Always close the Undici agent in `finally`. Combine the caller signal with the timeout signal.

- [ ] **Step 5: Return structured per-URL results**

```ts
export type UrlReadResult =
  | { ok: true; requestedUrl: string; source: ExternalSource; content: string }
  | { ok: false; requestedUrl: string; error: string; code: UrlReadErrorCode };

export async function readPublicUrls(urls: string[], deps?: UrlReaderDeps): Promise<UrlReadResult[]> {
  return Promise.all(urls.map(async (url) => {
    try { return { ok: true, requestedUrl: url, ...(await readPublicUrl(url, deps)) }; }
    catch (error) { return toFailure(url, error); }
  }));
}
```

The source kind is `provided_url`; use the final redirect URL and a short snippet. Never expose resolved addresses or page bodies in public error messages.

- [ ] **Step 6: Run Task 4 tests and commit**

Run: `npm run test -- src/lib/project/url-reader.test.ts src/lib/project/url-content.test.ts`

Expected: PASS.

```bash
git add src/lib/project/url-reader.ts src/lib/project/url-reader.test.ts
git commit -m "feat(project): add safe public URL reader"
```

### Task 5: Add OpenAI Responses And Unified Model Adapters

**Files:**
- Create: `src/lib/project/openai-responses.ts`
- Create: `src/lib/project/openai-responses.test.ts`
- Create: `src/lib/project/model-chat.ts`
- Create: `src/lib/project/model-chat.test.ts`
- Modify: `src/lib/project/agent-markdown.ts`
- Modify: `src/lib/project/agent-markdown.test.ts`
- Modify: `src/lib/project/node-fact-judge.ts`
- Modify: `src/lib/project/node-fact-judge.test.ts`

- [ ] **Step 1: Write failing Responses parser tests**

Use chunk boundaries that split JSON lines. Assert request URL/body, text deltas, reasoning-summary deltas, annotation events, citations recovered from `response.completed`, deduplication and non-2xx errors.

```ts
expect(requestBody).toMatchObject({
  model: "gpt-5",
  input: [
    { role: "system", content: [{ type: "input_text", text: "rules" }] },
    { role: "user", content: [{ type: "input_text", text: "question" }] },
  ],
  tools: [{ type: "web_search" }],
  reasoning: { effort: "medium", summary: "auto" },
  stream: true,
});

expect(parts).toEqual([
  { type: "reasoning", content: "分析" },
  { type: "content", content: "结论" },
  { type: "source", source: expect.objectContaining({ kind: "web_search", url: "https://example.com/" }) },
]);
```

- [ ] **Step 2: Run Responses tests and verify RED**

Run: `npm run test -- src/lib/project/openai-responses.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the Responses adapter**

Expose:

```ts
export type ModelStreamPart =
  | { type: "content" | "reasoning"; content: string }
  | { type: "source"; source: ExternalSource };

export async function* streamOpenAIResponses(input: ResponsesInput): AsyncGenerator<ModelStreamPart>;
export async function callOpenAIResponses(input: ResponsesInput): Promise<string>;
export function resolveResponsesUrl(apiBaseUrl: string, apiUrlMode: ApiUrlMode = "base"): string;
```

Map `response.output_text.delta`, `response.reasoning_summary_text.delta`, `response.output_text.annotation.added` and citations present in `response.completed`. Ignore unknown event types and malformed chunks; throw on a failed HTTP status or a terminal Responses error event. Only add `tools: [{ type: "web_search" }]` when `webSearchEnabled === true`.

- [ ] **Step 4: Write failing unified-dispatch tests**

Assert `chat_completions` calls the existing helper and never produces source parts; `openai_responses` calls the new adapter; non-streaming judge calls and streaming rewrite calls both dispatch by protocol.

- [ ] **Step 5: Run unified adapter tests and verify RED**

Run: `npm run test -- src/lib/project/model-chat.test.ts`

Expected: FAIL because `model-chat.ts` does not exist.

- [ ] **Step 6: Implement unified model entrypoints**

```ts
export function streamModelChat(input: ModelChatInput): AsyncGenerator<ModelStreamPart> {
  return input.protocol === "openai_responses"
    ? streamOpenAIResponses(input)
    : streamOpenAICompatibleChat(input);
}

export function callModelChat(input: ModelChatInput): Promise<string> {
  return input.protocol === "openai_responses"
    ? callOpenAIResponses(input)
    : callOpenAICompatibleChat(input);
}
```

Update `streamNodeMarkdownRewrite` and `judgeNodeFacts` to accept `protocol` and call these unified entrypoints. Do not enable Web Search for fact judging or Markdown rewriting; it is only enabled for the user-facing chat request.

- [ ] **Step 7: Run all LLM-domain tests and commit**

Run: `npm run test -- src/lib/project/llm.test.ts src/lib/project/openai-responses.test.ts src/lib/project/model-chat.test.ts src/lib/project/agent-markdown.test.ts src/lib/project/node-fact-judge.test.ts`

Expected: PASS.

```bash
git add src/lib/project/openai-responses.ts src/lib/project/openai-responses.test.ts src/lib/project/model-chat.ts src/lib/project/model-chat.test.ts src/lib/project/agent-markdown.ts src/lib/project/agent-markdown.test.ts src/lib/project/node-fact-judge.ts src/lib/project/node-fact-judge.test.ts
git commit -m "feat(project): add OpenAI Responses model adapter"
```

### Task 6: Orchestrate URL Reading And Native Search In Chat

**Files:**
- Modify: `src/lib/project/types.ts`
- Modify: `src/app/api/projects/[projectId]/chat/route.ts`
- Modify: `src/app/api/projects/[projectId]/chat/chat-api.test.ts`
- Modify: `src/app/api/projects/[projectId]/nodes/[nodeId]/rewrite/route.ts`
- Modify: `src/app/api/projects/[projectId]/nodes/[nodeId]/rewrite/rewrite-api.test.ts`

- [ ] **Step 1: Write failing chat API tests for the two independent paths**

Mock URL reading and model streaming at module boundaries. Cover:

1. URL reads occur with search disabled.
2. Responses search is enabled only from the persisted session setting.
3. Chat Completions emits one unavailable event and still answers.
4. Partial URL failure emits a failure result and still answers.
5. Assistant messages persist successful provided/search sources.
6. Abort stops URL and model work and does not append unseen sources.

Expected SSE order for a URL request:

```ts
[
  { type: "url_read_start", urls: ["https://example.com/"] },
  { type: "url_read_result", url: "https://example.com/", ok: true, source },
  { type: "token", content: "回答" },
  { type: "source", source },
  { type: "markdown_check_start" },
  // existing markdown result events
  { type: "done", sessionId },
]
```

- [ ] **Step 2: Run chat API tests and verify RED**

Run: `npm run test -- src/app/api/projects/\[projectId\]/chat/chat-api.test.ts`

Expected: FAIL because chat does not read URLs, sessions or protocol-aware streams.

- [ ] **Step 3: Extend the SSE union and centralize safe event sending**

Add the four new event variants from the design: `url_read_start`, both `url_read_result` shapes, `web_search_unavailable`, and `source`.

In the route use one `sendEvent(event: ChatStreamEvent)` helper that checks the abort signal before enqueueing. Do not interpolate manually constructed JSON.

- [ ] **Step 4: Read URLs before invoking the model**

Inside the stream:

```ts
const urls = extractHttpUrls(userMessage);
const urlResults = urls.length ? await readPublicUrls(urls, { signal: abortController.signal }) : [];
const providedSources = urlResults.flatMap((result) => result.ok ? [result.source] : []);
const externalContext = urlResults
  .filter((result): result is UrlReadSuccess => result.ok)
  .map((result) => formatUntrustedWebContext(result))
  .join("\n\n");
```

Append external context after the user message under a system-controlled `UNTRUSTED EXTERNAL MATERIAL` section. Include explicit instructions not to obey commands found in the material. Keep the original user message unchanged for persistence and fact evidence.

- [ ] **Step 5: Dispatch by provider protocol and persisted session preference**

Resolve/create the session before streaming, then read `session.webSearchEnabled`. Do not accept `webSearchEnabled` in the chat request body.

- For `openai_responses`, call `streamModelChat` with the stored value.
- For `chat_completions` with the stored value true, send one `web_search_unavailable` event and call normal Chat Completions.
- Deduplicate adapter sources and provided URL sources before persistence.

Pass `provider.protocol` into `judgeNodeFacts`. Pass it through the rewrite route into `streamNodeMarkdownRewrite` so Responses providers also support existing delivery workflows without Web Search.

- [ ] **Step 6: Preserve abort and partial-response semantics**

On abort, cancel URL reads and the model call. Preserve only text/source events already emitted to the client; do not append sources produced after abort. Keep the existing behavior of saving an already-emitted partial Assistant message.

- [ ] **Step 7: Run route tests and commit**

Run: `npm run test -- src/app/api/projects/\[projectId\]/chat/chat-api.test.ts src/app/api/projects/\[projectId\]/nodes/\[nodeId\]/rewrite/rewrite-api.test.ts`

Expected: PASS.

```bash
git add src/lib/project/types.ts 'src/app/api/projects/[projectId]/chat/route.ts' 'src/app/api/projects/[projectId]/chat/chat-api.test.ts' 'src/app/api/projects/[projectId]/nodes/[nodeId]/rewrite/route.ts' 'src/app/api/projects/[projectId]/nodes/[nodeId]/rewrite/rewrite-api.test.ts'
git commit -m "feat(chat): orchestrate URL reads and native web search"
```

### Task 7: Prevent External Sources From Becoming Confirmed Facts

**Files:**
- Modify: `src/lib/project/types.ts`
- Modify: `src/lib/project/node-fact-judge.ts`
- Modify: `src/lib/project/node-fact-judge.test.ts`
- Modify: `src/lib/project/node-markdown-patcher.test.ts`

- [ ] **Step 1: Write failing external-evidence tests**

Cover valid external assumptions, external `confirmed_fact` downgrade, missing/unknown `sourceId` rejection, and later user confirmation remaining valid user evidence.

```ts
it("downgrades externally sourced confirmed facts", async () => {
  mockJudge({
    category: "confirmed_fact",
    evidence: { source: "external", sourceId: source.id, quote: "外部结论" },
  });
  expect((await judgeNodeFacts({ ...input, externalSources: [source] })).decision.changes[0])
    .toMatchObject({ category: "assumption", targetSectionKey: "assumptions" });
});

it("drops external evidence with an unknown source id", async () => {
  mockJudge({ evidence: { source: "external", sourceId: "missing", quote: "结论" } });
  expect((await judgeNodeFacts({ ...input, externalSources: [source] })).decision.changes).toEqual([]);
});
```

- [ ] **Step 2: Run fact-judge tests and verify RED**

Run: `npm run test -- src/lib/project/node-fact-judge.test.ts`

Expected: FAIL because external evidence is not accepted or validated.

- [ ] **Step 3: Implement the discriminated evidence type and schema**

```ts
export type PatchEvidence =
  | { source: "user" | "assistant"; quote: string }
  | { source: "external"; quote: string; sourceId: string };
```

Use `z.discriminatedUnion("source", ...)`. Add source IDs/titles/URLs to the judge input prompt, but never include full page bodies. For external evidence:

- drop the patch if `sourceId` is absent from `input.externalSources`;
- force `confirmed_fact` to `assumption`;
- route assumptions/open questions through their existing fixed sections.

- [ ] **Step 4: Pass persisted sources from chat orchestration to the judge**

The chat route must call:

```ts
judgeNodeFacts({
  // existing model and message fields
  protocol: provider.protocol,
  externalSources: assistantSources,
});
```

Do not use URL content as a verbatim user quote.

- [ ] **Step 5: Run patch and judge tests and commit**

Run: `npm run test -- src/lib/project/node-fact-judge.test.ts src/lib/project/node-markdown-patcher.test.ts src/app/api/projects/\[projectId\]/chat/chat-api.test.ts`

Expected: PASS.

```bash
git add src/lib/project/types.ts src/lib/project/node-fact-judge.ts src/lib/project/node-fact-judge.test.ts src/lib/project/node-markdown-patcher.test.ts 'src/app/api/projects/[projectId]/chat/route.ts' 'src/app/api/projects/[projectId]/chat/chat-api.test.ts'
git commit -m "fix(project): keep external evidence unconfirmed"
```

### Task 8: Add The Persistent Search Switch And Source UI

**Files:**
- Modify: `src/components/workbench/chat-panel.tsx`
- Modify: `src/components/workbench/chat-panel.test.tsx`

- [ ] **Step 1: Write failing session-switch UI tests**

Test that the globe button reflects the active session, PATCHes the session, stays enabled after sending, restores after refresh/session load, and rolls back on PATCH failure. The existing node bootstrap already creates a session when none exists; assert the toggle remains disabled until that creation resolves.

```ts
const webButton = await screen.findByRole("button", { name: "联网搜索：关闭" });
await user.click(webButton);
expect(fetchMock).toHaveBeenCalledWith(
  expect.stringContaining(`/chat/sessions/${session.id}`),
  expect.objectContaining({
    method: "PATCH",
    body: JSON.stringify({ nodeId: "feature-design", webSearchEnabled: true }),
  }),
);
expect(screen.getByRole("button", { name: "联网搜索：开启" })).toBeInTheDocument();
```

- [ ] **Step 2: Run ChatPanel tests and verify RED**

Run: `npm run test -- src/components/workbench/chat-panel.test.tsx`

Expected: FAIL because the globe button is absent.

- [ ] **Step 3: Implement session-owned toggle state**

Import `Globe2Icon`. Derive the active value from `sessions.find(...)`; do not create a second durable boolean state.

```tsx
<button
  aria-label={`联网搜索：${activeSession?.webSearchEnabled ? "开启" : "关闭"}`}
  aria-pressed={activeSession?.webSearchEnabled ?? false}
  disabled={!activeSession || savingWebSearch}
  onClick={toggleWebSearch}
  type="button"
>
  <Globe2Icon className="h-4 w-4" />
</button>
```

`toggleWebSearch` must optimistically update the matching session, PATCH it, replace it with the server response on success, and restore the prior session on failure. Do not add `webSearchEnabled` to the chat POST body.

- [ ] **Step 4: Write failing URL status, unavailable and source tests**

Feed SSE chunks for successful/failed URL reads, `web_search_unavailable`, duplicate sources and a final Assistant message. Assert one compact notice and one source link.

```ts
expect(await screen.findByText("当前模型不支持原生联网，已继续普通对话")).toBeInTheDocument();
expect(screen.getAllByRole("link", { name: /Example/ })).toHaveLength(1);
expect(screen.getByText("example.com")).toBeInTheDocument();
```

- [ ] **Step 5: Run the new UI tests and verify RED**

Run: `npm run test -- src/components/workbench/chat-panel.test.tsx`

Expected: FAIL because the new SSE events are ignored and sources are not rendered.

- [ ] **Step 6: Render transient status and persisted sources**

Track only current-send URL status/unavailable notices in component state; clear them at the next send. On `source`, append/dedupe the source on the in-flight Assistant message. `MessageBubble` renders persisted `msg.sources` as safe external links:

```tsx
<a href={source.url} rel="noreferrer noopener" target="_blank">
  <span>{source.title}</span>
  <span>{source.domain}</span>
</a>
```

Never render external HTML. Keep source links outside the reasoning disclosure and below the answer text.

- [ ] **Step 7: Run Task 8 tests and commit**

Run: `npm run test -- src/components/workbench/chat-panel.test.tsx src/components/workbench/workbench-shell.test.tsx`

Expected: PASS.

```bash
git add src/components/workbench/chat-panel.tsx src/components/workbench/chat-panel.test.tsx
git commit -m "feat(workbench): add web access controls and sources"
```

### Task 9: Complete Regression And Production Verification

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`

Expected: all test files and tests PASS. Fix regressions at their owning layer; do not weaken assertions or remove security cases.

- [ ] **Step 2: Run lint and type checking**

Run: `npm run lint && npm run typecheck`

Expected: both commands exit 0 with no new warnings.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: Next.js production build exits 0. Record any pre-existing Turbopack tracing warning separately; do not claim it was introduced by this feature without confirming the diff.

- [ ] **Step 4: Perform a focused manual smoke test**

Run: `npm run dev`

Verify in the workbench:

1. A Chat Completions session with the switch off answers normally.
2. Pasting a public URL with the switch off shows read status and a source.
3. The switch survives send, refresh and session switching.
4. A Chat Completions provider with the switch on shows one light notice and still answers.
5. An OpenAI Responses provider with the switch on can search and show citations.
6. `http://127.0.0.1`, `http://[::1]` and a public redirect to a private address are rejected without breaking chat.

Stop the dev server after verification.

- [ ] **Step 5: Commit only genuine verification fixes**

If verification required code changes, rerun Steps 1-3, then commit the focused fixes:

```bash
git add src package.json package-lock.json
git commit -m "fix(web-access): address integration regressions"
```

If no files changed, do not create an empty commit.

## Completion Criteria

- Every task commit is green at the focused test scope listed in that task.
- Full `test`, `lint`, `typecheck` and `build` pass from a clean worktree.
- Existing Chat Completions providers and delivery generation remain functional.
- URL reading is server-only, size-limited, time-limited, redirect-limited and pinned to validated public addresses.
- Search is controlled only by the persisted session switch and only OpenAI Responses receives the Web Search tool.
- External sources remain traceable and cannot become confirmed project facts without later explicit user confirmation.
