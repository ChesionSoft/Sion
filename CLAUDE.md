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
- `store.ts` — `ProjectStore`: the filesystem-backed repository. Owns `projects/<id>/{project.json,nodes/,chat/,exports/,...}`. Server-side only.
- `paths.ts` — `assertSafeProjectId`: **always** validate project ids from the URL with this before any filesystem operation. It blocks traversal, separators, and absolute paths.
- `agents.ts` / `agent-overrides.ts` — loads node agent rules from `agents/<NN-name>.md`; per-project overrides live in `projects/<id>/agent-overrides/`. Default rules are read-only; copies become project-custom rules.
- `llm.ts` — `callOpenAICompatibleChat`: single OpenAI-compatible Chat Completions client used everywhere. Supports `apiUrlMode: "base" | "full"` and an `AbortSignal`.
- `markdown.ts` / `docx.ts` / `exports.ts` — assembles `PROJECT_DESIGN.md`, `SPEC.md`, `TASKS.md`, `AGENTS.md`, and `项目开发设计文档.docx` into `projects/<id>/exports/`.
- `files.ts` — project file pool: uploaded materials normalized to `.txt` for LLM context.

### Model providers — `src/lib/settings/model-providers.ts`

OpenAI-compatible providers (OpenAI, DeepSeek, Qwen, SiliconFlow, …) stored in `settings/model-providers.json`. Shared across projects. UI: `ModelConfigPanel`.

### Next.js layer — `src/app`

- `src/app/page.tsx` — project list + model config entry.
- `src/app/projects/[projectId]/page.tsx` — the 3-column workbench (node sidebar / agent chat / markdown delivery).
- `src/app/api/projects/[projectId]/{nodes,chat,agents,files,exports}/route.ts` — REST endpoints over `ProjectStore`. Project id is always validated via `assertSafeProjectId`.
- `src/app/api/settings/model-providers/...` — provider CRUD.

### Components — `src/components/workbench`

The workbench UI shell and panels (`workbench-shell`, `node-sidebar`, `chat-panel`, `markdown-panel`, `export-panel`, `file-pool-dialog`, `model-config-panel`). `src/components/ui` holds shadcn primitives.

### Agent rules — `agents/`

`01-basic-info.md` … `12-final-export.md`: one Markdown rule file per node, loaded by `agents.ts` and injected as the system prompt for that node's chat. Editing these changes default agent behavior for **all** projects; per-project customization goes through `agent-overrides`.

### Templates — `templates/`

`project-design-word.md` feeds the `.docx` export.

## Conventions to keep

- **Filesystem writes are server-side only** (per `AGENTS.md`). Domain modules use `node:fs/promises`; never import them into client components.
- **Write tests before behavior changes** (per `AGENTS.md`). Tests sit next to source.
- **Run `npm run test` and `npm run lint` before claiming completion** (per `AGENTS.md`).
- **Do not commit generated project exports** (`projects/**/exports/`) or `settings/model-providers.json` (contains API keys) — see `AGENTS.md`. `projects/` and `settings/` are working data, not source.
- Project ids from any request path go through `assertSafeProjectId` before touching the disk.