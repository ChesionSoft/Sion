# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev          # Next.js dev server on http://localhost:3000
npm run build        # Production build
npm run lint         # ESLint (flat config, eslint.config.mjs)
npm run test         # Vitest, one-shot (jsdom + globals)
npm run test:watch   # Vitest watch mode
npm run typecheck    # tsc --noEmit
```

Run a single test file or pattern:

```bash
npx vitest run src/lib/project/store.test.ts
npx vitest run -t "creates a project"
```

Tests are colocated with source (`*.test.ts` / `*.test.tsx`). Vitest excludes `.claude/worktrees/**`.

## Stack notes

- Next.js **16.2.9**, React **19.2.4**, TypeScript **5** strict, Tailwind **4**, Base UI (`@base-ui/react`) + shadcn, Zod **4**, `docx` for Word export, `react-markdown` + `remark-gfm`.
- The `@/*` path alias maps to `src/*` (tsconfig + vitest config).
- See `AGENTS.md`: this Next.js has breaking changes — read `node_modules/next/dist/docs/` before writing Next.js code, and heed deprecation notices.

## Architecture

Sion is a **local-first** workbench for producing project design documents. All project state lives on the local filesystem under `projects/<project-id>/`; nothing is persisted in a database.

### Domain core — `src/lib/project`

This is where the project domain logic lives (per `AGENTS.md`, keep new domain logic here). Key modules:

- `types.ts` — `Project`, `ProjectNode`, `WorkflowNodeId` (the 12 fixed node ids), `ChatSession`/`ChatMessage`, `ModelProvider`/`ModelEntry`, `ProjectFile`, `AgentOverrideSetting`.
- `nodes.ts` — `WORKFLOW_NODES`: the ordered 12-node design pipeline (basic-info → goals → roles-permissions → … → final-export), each with `dependsOn` and an `agentRuleFile`.
- `store.ts` — `ProjectStore`: the filesystem-backed repository. Owns `projects/<id>/{project.json,nodes/<nodeId>/{content.md,status,...},chat/<nodeId>/{sessions.json,<sessionId>.json},exports/,agent-overrides/,files/,verifications/}`. Server-side only.
- `paths.ts` — `assertSafeProjectId`: **always** validate project ids from the URL with this before any filesystem operation. It blocks traversal, separators, and absolute paths.
- `agents.ts` / `agent-overrides.ts` — loads node agent rules from `agents/<NN-name>.md`; per-project overrides live in `projects/<id>/agent-overrides/`. Default rules are read-only; copies become project-custom rules.
- `llm.ts` — low-level OpenAI-compatible Chat Completions client (`callOpenAICompatibleChat`, streaming variants). Supports `apiUrlMode: "base" | "full"` and an `AbortSignal`. Not called directly by routes anymore — see `model-chat.ts`.
- `model-chat.ts` — the provider/protocol dispatcher routes now use. Selects between `chat_completions` (via `llm.ts`) and `openai_responses` (via `openai-responses.ts`) based on `ModelProvider.protocol`, normalizes tool definitions / conversation items / usage events into a provider-neutral shape, and records per-call token usage. New model calls should go through here, not `llm.ts`.
- `markdown.ts` / `docx.ts` / `exports.ts` — assembles `PROJECT_DESIGN.md`, `SPEC.md`, `TASKS.md`, `AGENTS.md`, and `项目开发设计文档.docx` into `projects/<id>/exports/`.
- `files.ts` — project file pool: uploaded materials normalized to `.txt` for LLM context.

### Chat turn pipeline — `src/app/api/projects/[projectId]/chat/route.ts`

A node chat turn is no longer a single LLM call; the route orchestrates a multi-stage stream (`ChatStreamEvent`s over a single response):

1. **Web tool orchestration** (`web-tool-orchestrator.ts` + `model-chat.ts`) — if the session has web search/fetch enabled (or the user message contains direct URLs), the orchestrator gives tool-capable models `web_search` / `web_fetch` function tools (contracts in `model-tools.ts`); models without tool support fall back to a strict one-shot JSON planner (`search-planner.ts`) that returns `{"queries":[...]}`. Per-turn fetch/search budgets are enforced by `web-tool-budget.ts`. Fetched content is formatted as **untrusted** context (`untrusted-web-context.ts`, `external-source.ts`) and surfaced back to the model.
2. **Fact judging** (`node-fact-judge.ts`) — after the assistant answers, a second model call judges whether the turn's claims should update the node's Markdown, emitting `NodeMarkdownPatch`es with evidence.
3. **Markdown patching** (`node-markdown-patcher.ts`, `node-delivery-schemas.ts`, `node-markdown-content.ts`, `agent-markdown.ts`) — patches are applied to the node's `content.md` via an mdast-based patcher; `UnpatchableError` means the patch was rejected. The `/nodes/[nodeId]/patch` and `/nodes/[nodeId]/rewrite` routes expose explicit patch/rewrite.
4. **Token usage** (`token-usage.ts`) — provider-reported usage is normalized (bogus totals → null → deterministic estimate); usage is aggregated per turn and project, surfaced via the session usage popover.

### Browser & network safety — `src/lib/project` (browser subsystem)

All outbound network is server-side and locked down. **Never** add a new outbound fetch path that bypasses this:

- `network-policy.ts` — `resolvePublicTarget`: every outbound connection (URL reader **and** browser egress) resolves DNS once and connects to the pinned public address; private/loopback/link-local addresses are rejected. A single unsafe DNS answer rejects the whole target.
- `browser-manager.ts` / `browser-web-service.ts` / `browser-egress-proxy.ts` / `playwright-loader.ts` — a single persistent browser profile, serialized; Playwright is lazily loaded (`playwright-loader.ts`). Browser egress is forced through the safe proxy. `BrowserManager`/`BrowserWebService` accept injected discovery + Playwright so tests stay deterministic.
- `url-reader.ts` / `url-content.ts` — server-side URL → text extraction (mammoth/pdf-parse/xlsx for uploads; the URL reader goes through `network-policy`).
- `google-search.ts` / `baidu-search.ts` / `search-engine.ts` — search engine adapters behind the orchestrator.

### Model providers — `src/lib/settings/model-providers.ts`

OpenAI-compatible providers (OpenAI, DeepSeek, Qwen, SiliconFlow, …) stored in `settings/model-providers.json`. Each provider carries a `protocol: "chat_completions" | "openai_responses"` (drives `model-chat.ts` dispatch) and a model list. Shared across projects. UI: `ModelConfigPanel`.

### Browser search settings — `src/lib/settings/browser-search.ts`

Web search engine config (`SearchEngineId`: `google` | `baidu`, default engine, API keys) stored in `settings/browser-search.json`. Shared across projects. UI: `BrowserSearchConfigPanel`. The chat route reads this to decide whether/which search engine to wire into the orchestrator; a browser-verification step may emit a `browser_verification_required` event that the UI must confirm before live search runs.

### Next.js layer — `src/app`

- `src/app/page.tsx` — project list + model config entry.
- `src/app/projects/[projectId]/page.tsx` — the 3-column workbench (node sidebar / agent chat / markdown delivery).
- `src/app/api/projects/[projectId]/{nodes,chat,agents,files,exports}/route.ts` — REST endpoints over `ProjectStore`. Project id is always validated via `assertSafeProjectId`.
  - `chat/route.ts` runs the multi-stage pipeline above and streams `ChatStreamEvent`s. Sub-routes: `chat/sessions/...` (per-node chat sessions), `chat/verifications/[verificationId]/route.ts` (confirm a browser-search verification).
  - `nodes/[nodeId]/{patch,rewrite}/route.ts` — explicit Markdown patch / rewrite.
- `src/app/api/settings/{model-providers,browser-search}/...` — provider + search-engine CRUD.

### Components — `src/components/workbench`

The workbench UI shell and panels (`workbench-shell`, `node-sidebar`, `chat-panel` + `chat-message` + `agent-activity`, `markdown-panel` + `markdown-content`, `export-panel`, `file-pool-dialog`, `model-config-panel`, `browser-search-config-panel`, `session-usage-button` + `token-usage-details`, `patch-preview`). `src/components/ui` holds shadcn primitives.

### Agent rules — `agents/`

`01-basic-info.md` … `12-final-export.md`: one Markdown rule file per node, loaded by `agents.ts` and injected as the system prompt for that node's chat. Editing these changes default agent behavior for **all** projects; per-project customization goes through `agent-overrides`.

### Templates — `templates/`

`project-design-word.md` feeds the `.docx` export.

## Conventions to keep

- **Filesystem writes are server-side only** (per `AGENTS.md`). Domain modules use `node:fs/promises`; never import them into client components.
- **Write tests before behavior changes** (per `AGENTS.md`). Tests sit next to source.
- **Run `npm run test` and `npm run lint` before claiming completion** (per `AGENTS.md`).
- **Do not commit generated project exports** (`projects/**/exports/`) or `settings/*.json` (`model-providers.json` and `browser-search.json` contain API keys) — see `AGENTS.md`. `projects/` and `settings/` are working data, not source.
- Project ids from any request path go through `assertSafeProjectId` before touching the disk.
- **All outbound network goes through `network-policy.resolvePublicTarget`** — both `url-reader.ts` and the browser egress path. Do not add a `fetch`/browser navigation that bypasses it; private/loopback addresses must stay blocked.