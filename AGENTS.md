<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Repository Agent Notes

This is a local-first Next.js project (Sion) for generating project design documents. All project state lives on the local filesystem under `projects/<project-id>/`; there is no database.

## Commands

```bash
npm run dev          # Next.js dev server (http://localhost:3000)
npm run build        # Production build
npm run lint         # ESLint flat config (eslint.config.mjs)
npm run test         # Vitest one-shot (jsdom + globals)
npm run test:watch   # Vitest watch
npm run typecheck    # tsc --noEmit
npx vitest run src/lib/project/store.test.ts          # single file
npx vitest run -t "creates a project"                 # single test name
```

Tests are colocated with source (`*.test.ts` / `*.test.tsx`). Vitest excludes `.claude/worktrees/**`. `@/*` path alias maps to `src/*` (tsconfig + vitest).

## Stack

Next.js **16.2.9**, React **19.2.4**, TypeScript 5 strict, Tailwind 4, Base UI (`@base-ui/react`) + shadcn, Zod 4, `docx` for Word export, `react-markdown` + `remark-gfm`, `playwright-core` for browser egress.

## Major directories

- `src/lib/project/` - project domain core (see boundaries below). Keep new domain logic here.
- `src/app/` - Next.js layer: `page.tsx` (project list), `projects/[projectId]/page.tsx` (3-column workbench), `app/api/projects/[projectId]/{nodes,chat,agents,files,exports}/` REST endpoints, `app/api/settings/{model-providers,browser-search}/`.
- `src/components/workbench/` - workbench UI shell + panels. `src/components/ui/` holds shadcn primitives.
- `agents/01-basic-info.md` … `12-final-export.md` - one Markdown rule file per workflow node, injected as that node's system prompt. Editing these changes default behavior for **all** projects; per-project customization goes through `agent-overrides`.
- `templates/project-design-word.md` - feeds the `.docx` export.
- `projects/` and `settings/` - local working data, not source.

## Architecture boundaries and layer rules

- **Filesystem writes are server-side only.** Domain modules use `node:fs/promises`; never import them into client components.
- **Project ids from any request path go through `assertSafeProjectId`** (`src/lib/project/paths.ts`) before touching the disk. It blocks traversal, separators, and absolute paths.
- **All outbound network goes through `network-policy.resolvePublicTarget`** (`src/lib/project/network-policy.ts`) - both `url-reader.ts` and the browser egress path. It resolves DNS once and connects to the pinned public address; private/loopback/link-local addresses are rejected. Never add a `fetch` or browser navigation that bypasses it.
- **New model calls go through `model-chat.ts`**, not `llm.ts`. `model-chat.ts` dispatches between `chat_completions` (via `llm.ts`) and `openai_responses` (via `openai-responses.ts`) based on `ModelProvider.protocol`, normalizes tool definitions / conversation items / usage, and records token usage. `llm.ts` is the low-level OpenAI-compatible client only.
- **A node chat turn is a multi-stage stream** (`src/app/api/projects/[projectId]/chat/route.ts`), not a single LLM call: web tool orchestration -> fact judging (`node-fact-judge.ts`) -> mdast-based Markdown patching (`node-markdown-patcher.ts`; `UnpatchableError` = patch rejected) -> token usage aggregation. Explicit patch/rewrite is exposed via `/nodes/[nodeId]/{patch,rewrite}`.
- **Browser subsystem** (`browser-manager.ts`, `browser-web-service.ts`, `browser-egress-proxy.ts`, `playwright-loader.ts`): single persistent profile, serialized; Playwright is lazily loaded; egress is forced through the safe proxy. `BrowserManager`/`BrowserWebService` accept injected discovery + Playwright so tests stay deterministic.
- **Model providers** (`src/lib/settings/model-providers.ts`) and **browser search settings** (`src/lib/settings/browser-search.ts`) are shared across projects and stored in `settings/*.json`.

## Development Rules

- Use TypeScript for all application code.
- Put project-domain logic in `src/lib/project`.
- Keep filesystem writes server-side only.
- Write tests before behavior changes.
- Run `npm run test` and `npm run lint` before claiming completion.
- Do not put generated project exports in git.
- Do not `git add` local design specs or implementation plans under `docs/`; they are local planning artifacts.
- Do not commit `projects/**/exports/` or `settings/*.json` (`model-providers.json` and `browser-search.json` contain API keys).
