# Live Public Reasoning and Provider Error Design

**Date:** 2026-07-18
**Status:** Approved for planning

## Goal

Improve the active conversation turn in two focused ways:

1. Let the user expand an “Agent 正在思考” disclosure while a response is streaming and see provider-supplied public reasoning summaries arrive live.
2. Replace opaque provider failures such as `model provider returned HTTP 504 Gateway Timeout` with safe, actionable Chinese reasons.

The feature must not expose or persist hidden chain-of-thought, retry requests automatically, or add a retry button.

## Current Behavior and Root Cause

`sion-agent` already parses two distinct stream delta types:

- `OutputText`, used for visible assistant text.
- `ReasoningSummary`, used only for provider-declared public reasoning summaries.

The desktop orchestrator currently emits `OutputText` through `agent-token` but deliberately drops `ReasoningSummary` while the run is active. The accumulated public summary is saved only after successful completion, so the UI cannot display it during generation.

Provider HTTP errors are currently reduced to a string in `model_stream`. A 504 response therefore reaches the run summary as the technical string `model provider returned HTTP 504 Gateway Timeout`. The `reqwest` client does not impose a Sion request timeout in this path; the observed 504 was returned by the provider or its upstream gateway.

## Safety Boundary

The application will continue to distinguish public reasoning summaries from hidden reasoning content:

- `reasoning_summary` and `response.reasoning_summary_text.delta` may enter the public reasoning stream.
- `reasoning_content`, hidden analysis, internal prompts, raw provider frames, and raw error bodies never enter frontend events or project records.
- The live and persisted public summary is bounded to 2,000 Unicode characters.
- Providers that expose only hidden reasoning content will show the live execution state but no reasoning text.

This boundary is enforced in Rust before IPC, not left to the React UI.

## Chosen Approach

Use a dedicated public-reasoning event and typed provider failures.

Alternatives rejected:

- Updating and persisting the entire conversation turn for every reasoning delta would create high event and disk churn.
- Showing only a frontend animation would not reflect real provider-supplied public reasoning.
- Parsing technical failure strings in React would duplicate transport knowledge and create a brittle security boundary.

## Runtime Data Flow

### Public reasoning stream

1. `model_stream` parses a provider frame into `StreamDelta::ReasoningSummary` only for documented public-summary fields. Hidden reasoning fields remain ignored.
2. The Tauri conversation orchestrator emits a new `agent-reasoning-summary` event containing only `runId`, `projectId`, `nodeId`, `sessionId`, and the public `delta`.
3. `App` accepts the event only when all active project/node/session identifiers match and stores a bounded transient value keyed by `runId`.
4. `ConversationPane` passes the active turn’s transient public reasoning into `ConversationTurnCard`.
5. On successful completion, the existing terminal turn snapshot remains the durable source of truth. On failure, cancellation, project/node/session changes, or run replacement, transient data is cleared.

Delivery regeneration continues to ignore reasoning summaries because this design is scoped to the central conversation turn.

### Provider failures

`model_stream` will return a typed failure category rather than an already formatted technical string. The Tauri boundary maps the category to a safe public reason for both the failed turn and the durable run summary.

Required mappings:

| Failure | Public reason |
|---|---|
| HTTP 401/403 | API Key 无效，或当前账号没有该模型权限 |
| HTTP 404 | 接口地址、协议或模型名称不匹配 |
| HTTP 429 | 模型服务请求过于频繁，请稍后重新发送 |
| HTTP 502/503 | 模型服务暂时不可用，请稍后重新发送 |
| HTTP 504 | 模型服务上游网关超时（HTTP 504），请稍后重新发送 |
| Connect failure | 无法连接模型服务，请检查地址和网络 |
| Stream read/incomplete failure | 模型流式回复中断，本次未保存未完成内容 |
| Other HTTP status | 模型服务返回 HTTP `<status>` |

Provider response bodies remain bounded for internal classification and are never echoed into public state.

## UI Behavior

During a queued or running turn, the compact status area includes a disclosure labeled “Agent 正在思考”:

- It is collapsed by default.
- It is a semantic button with `aria-expanded` and keyboard support.
- When expanded with no public summary received, it shows “模型暂未提供公开思考内容”.
- Public summary deltas append live without affecting assistant response streaming.
- The panel is visually subordinate to the assistant response and uses the existing GPT-style single-column conversation flow.

After the run ends, the disclosure remains available when a persisted public summary exists. Failed turns show the mapped failure reason directly in the turn status/activity area. Run Details uses the same public failure reason. There is no automatic retry and no new retry button.

## State and Compatibility

- The transient public-reasoning map is frontend-only and never serialized.
- The existing optional `ConversationTurn.reasoningSummary` field remains the durable representation, so no project schema migration is required.
- Historical turns without a public summary render normally without an empty disclosure.
- Existing run details remain backward compatible.

## Testing

Implementation will follow test-driven development.

Rust transport tests:

- Public summary fields produce `ReasoningSummary` deltas.
- Hidden `reasoning_content` never produces a delta.
- HTTP and network failures map to the required typed categories.
- A 504 fixture produces the exact safe Chinese public reason without leaking its response body.

Tauri command/runtime tests:

- Active conversation runs emit scoped public-reasoning events.
- The stored terminal summary is bounded to 2,000 characters.
- Failed turn and run summaries use the same mapped public reason.
- No automatic second provider request is made.

Frontend tests:

- The disclosure is collapsed by default and exposes `aria-expanded`.
- Live deltas are scoped by project, node, session, and run.
- Transient summaries clear on every terminal or navigation boundary.
- No-summary providers display the empty live state while running.
- 504 failure text appears without a new retry control.

Full verification includes TypeScript lint/build, UI tests, both Rust test suites, storage/no-browser contract checks, and Clippy with warnings denied.

## Out of Scope

- Displaying raw hidden chain-of-thought or `reasoning_content`.
- Automatic retry, retry backoff, or a new failed-run retry button.
- Provider-specific reasoning UI beyond the two supported OpenAI-compatible protocols.
- Persisting partial public reasoning for cancelled or failed runs.
