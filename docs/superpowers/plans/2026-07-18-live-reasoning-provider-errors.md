# Live Public Reasoning and Provider Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream provider-supplied public reasoning into an accessible conversation disclosure and replace technical model failures, including HTTP 504, with safe Chinese reasons.

**Architecture:** `sion-agent` owns typed transport failures and continues to reject hidden reasoning fields. The Tauri conversation orchestrator emits a dedicated scoped public-reasoning event and maps typed failures at one safe boundary; React keeps only bounded transient reasoning by run and renders it through a focused disclosure component.

**Tech Stack:** Rust 2024, Tokio, reqwest, Tauri 2 events, React 19, TypeScript, Node test runner, CSS.

## Global Constraints

- Never expose, emit, persist, log, or render raw `reasoning_content`, hidden analysis, raw provider frames, full prompts, API keys, or provider error bodies.
- Only `reasoning_summary` and `response.reasoning_summary_text.delta` may become public reasoning text.
- Bound live and durable public reasoning to 2,000 Unicode characters.
- Do not retry HTTP 502/503/504 or any other provider failure automatically.
- Do not add a failed-run retry button; the existing “重新判断交付稿” control remains limited to delivery resolution.
- HTTP 504 public copy is exactly `模型服务上游网关超时（HTTP 504），请稍后重新发送`.
- The same safe public failure reason must appear in the failed turn and durable run detail.
- Keep delivery-regeneration reasoning summaries out of the central conversation UI.
- Preserve the user’s existing uncommitted changes in the main worktree. Begin execution with `superpowers:using-git-worktrees`; do not copy, stage, or commit those changes.
- Keep the desktop runtime free of browser search, browser automation, Playwright, and web-fetch subsystems.

---

## File Map

**Create**

- `src/reasoning-stream.ts` — pure scoped reducer for bounded transient public reasoning.
- `src/components/workspace/ConversationReasoningDisclosure.tsx` — accessible collapsed/expanded public-reasoning UI.
- `tests/reasoning-stream.test.ts` — reducer scope, Unicode bound, and cleanup tests.

**Modify**

- `crates/sion-agent/src/model_stream.rs` — typed stream failures, status classification, and transport tests.
- `src-tauri/src/turn_runtime.rs` — single safe Chinese failure mapping and response-failure outcome.
- `src-tauri/src/lib.rs` — reasoning event payload/emission and typed failure plumbing.
- `src/types.ts` — frontend event contract.
- `src/App.tsx` — event listener and transient run-scoped state lifecycle.
- `src/components/workspace/ProjectWorkspace.tsx` — pass transient reasoning into the conversation pane.
- `src/components/workspace/ConversationPane.tsx` — select each turn’s live public reasoning.
- `src/components/workspace/ConversationTurnCard.tsx` — compose disclosure and failed-turn status.
- `src/conversation-turns.ts` — response failures use the mapped public reason as the headline.
- `src/components/workspace/RunDetailDialog.tsx` — preserve the same safe reason in details.
- `src/styles/workspace.css` — subordinate GPT-style disclosure layout.
- `tests/conversation-turns.test.ts` — failure headline regression.
- `tests/workspace-regressions.test.ts` — IPC/UI safety contracts and no retry control.
- `README.md`, `README.en.md` — document public live reasoning and safe provider failures.

---

### Task 1: Typed Provider Failures and Safe Public Reasons

**Files:**
- Modify: `crates/sion-agent/src/model_stream.rs:29-152,404-510`
- Modify: `src-tauri/src/turn_runtime.rs:320-350,500-530`
- Modify: `src-tauri/src/lib.rs:2140-2200,2390-2440,2586-2825`

**Interfaces:**
- Produces: `ProviderRejection`, `StreamFailure`, and `Result<StreamOutcome, StreamFailure>` from `stream_text` / `stream_text_with`.
- Produces: `turn_runtime::public_model_failure(&StreamFailure) -> String` and `turn_runtime::response_failure(&StreamFailure) -> DeliveryOutcome`.
- Consumes: no later-task interfaces.

- [ ] **Step 1: Replace string-error expectations with failing typed transport tests**

Add these test cases to `crates/sion-agent/src/model_stream.rs` before changing production signatures:

```rust
#[tokio::test]
async fn gateway_timeout_is_a_typed_non_retrying_failure() {
    let url = serve_response(
        b"HTTP/1.1 504 Gateway Timeout\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"error\":{\"message\":\"upstream waited for secret\"}}"
            .to_vec(),
    )
    .await;
    let error = stream_text(
        &Client::new(),
        &request(url, ProviderProtocol::ChatCompletions),
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error,
        StreamFailure::ProviderHttp {
            status: 504,
            rejection: ProviderRejection::Other,
        }
    );
    assert!(!format!("{error:?}").contains("secret"));
}

#[test]
fn request_failure_flags_map_without_provider_text() {
    assert_eq!(request_failure_kind(true, false), StreamFailure::RequestConnect);
    assert_eq!(request_failure_kind(false, true), StreamFailure::RequestTimeout);
    assert_eq!(request_failure_kind(false, false), StreamFailure::RequestOther);
}
```

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```bash
cargo test -p sion-agent gateway_timeout_is_a_typed_non_retrying_failure
cargo test -p sion-agent request_failure_flags_map_without_provider_text
```

Expected: compilation fails because `StreamFailure`, `ProviderRejection`, and `request_failure_kind` do not exist and the stream functions still return `String`.

- [ ] **Step 3: Add the typed failure model and minimal transport mapping**

Add the following public types near `StreamOutcome`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRejection {
    Reasoning,
    Context,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamFailure {
    UnsupportedProtocol,
    RequestConnect,
    RequestTimeout,
    RequestOther,
    ProviderHttp { status: u16, rejection: ProviderRejection },
    ProviderStream { rejection: ProviderRejection },
    StreamRead,
    StreamIncomplete,
    InvalidFrame,
}
```

Change both stream functions to return `Result<StreamOutcome, StreamFailure>`. Map request errors without retaining their text:

```rust
fn request_failure_kind(is_connect: bool, is_timeout: bool) -> StreamFailure {
    if is_connect {
        StreamFailure::RequestConnect
    } else if is_timeout {
        StreamFailure::RequestTimeout
    } else {
        StreamFailure::RequestOther
    }
}

.send()
.await
.map_err(|error| request_failure_kind(error.is_connect(), error.is_timeout()))?;
```

Classify provider text only into `ProviderRejection`:

```rust
fn provider_rejection(provider_text: &str) -> ProviderRejection {
    let normalized = provider_text.to_ascii_lowercase();
    if normalized.contains("reasoning") {
        ProviderRejection::Reasoning
    } else if normalized.contains("context") || normalized.contains("token limit") {
        ProviderRejection::Context
    } else {
        ProviderRejection::Other
    }
}
```

Convert non-success status with `status.as_u16()`. Convert body-stream failures to `StreamRead`, premature EOF to `StreamIncomplete`, invalid JSON to `InvalidFrame`, and SSE-declared failures to `ProviderStream`. Do not add a retry loop.

- [ ] **Step 4: Add failing public-copy and consistency tests at the Tauri boundary**

Add to `src-tauri/src/turn_runtime.rs`:

```rust
#[test]
fn gateway_timeout_has_exact_safe_public_copy() {
    let error = sion_agent::model_stream::StreamFailure::ProviderHttp {
        status: 504,
        rejection: sion_agent::model_stream::ProviderRejection::Other,
    };
    assert_eq!(
        public_model_failure(&error),
        "模型服务上游网关超时（HTTP 504），请稍后重新发送"
    );
    let outcome = response_failure(&error);
    assert!(matches!(
        outcome,
        DeliveryOutcome::Failed { stage: DeliveryStage::Response, public_error }
            if public_error == "模型服务上游网关超时（HTTP 504），请稍后重新发送"
    ));
}

#[test]
fn provider_failure_copy_covers_common_statuses() {
    for (status, expected) in [
        (401, "API Key 无效，或当前账号没有该模型权限"),
        (403, "API Key 无效，或当前账号没有该模型权限"),
        (404, "接口地址、协议或模型名称不匹配"),
        (429, "模型服务请求过于频繁，请稍后重新发送"),
        (502, "模型服务暂时不可用，请稍后重新发送"),
        (503, "模型服务暂时不可用，请稍后重新发送"),
    ] {
        let failure = sion_agent::model_stream::StreamFailure::ProviderHttp {
            status,
            rejection: sion_agent::model_stream::ProviderRejection::Other,
        };
        assert_eq!(public_model_failure(&failure), expected);
    }
}
```

- [ ] **Step 5: Run the Tauri tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml gateway_timeout_has_exact_safe_public_copy
```

Expected: FAIL because `public_model_failure` and `response_failure` do not exist.

- [ ] **Step 6: Implement the single safe mapping and typed orchestration**

Implement `public_model_failure` with the exact design table. HTTP status mappings take precedence, so a 504 body mentioning reasoning still produces the exact 504 copy. Use `ProviderRejection::Reasoning` and `ProviderRejection::Context` only for provider-stream failures or otherwise unmapped HTTP statuses; reasoning rejection preserves the existing guidance to turn reasoning off, and context rejection states that the provider rejected the input context. Implement:

```rust
pub fn response_failure(error: &sion_agent::model_stream::StreamFailure) -> DeliveryOutcome {
    DeliveryOutcome::Failed {
        stage: DeliveryStage::Response,
        public_error: public_model_failure(error),
    }
}
```

Change conversation and regeneration completion inputs from `Result<StreamOutcome, String>` to `Result<StreamOutcome, StreamFailure>`. Update `completion_from_stream` and its existing tests to the same error type. Use one `public_error` value for `response_failure`, `scheduler.fail`, and regeneration failure state. Replace unsupported-protocol strings with `StreamFailure::UnsupportedProtocol`. Keep `safe_delivery_error` for decision/validation/save failures only.

For `completed_activities`, attach a response-stage failure’s `public_error` to the failed “Agent 回复” activity instead of a skipped delivery-check activity.

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

Run:

```bash
cargo test -p sion-agent model_stream::tests
cargo test --manifest-path src-tauri/Cargo.toml turn_runtime::tests
npm run test:rust
```

Expected: all tests pass; the 504 assertion matches exactly and no raw fixture body appears in serialized public state.

- [ ] **Step 8: Commit Task 1**

```bash
git add crates/sion-agent/src/model_stream.rs src-tauri/src/turn_runtime.rs src-tauri/src/lib.rs
git commit -m "fix(agent): classify provider failures safely"
```

---

### Task 2: Dedicated Live Public-Reasoning Event

**Files:**
- Modify: `src-tauri/src/lib.rs:100-115,2139-2201,3180-3255`
- Modify: `src/types.ts:175-185`
- Modify: `tests/workspace-regressions.test.ts`

**Interfaces:**
- Consumes: `StreamDelta::ReasoningSummary(String)` from Task 1.
- Produces: Rust and TypeScript `AgentReasoningSummaryEvent { runId, projectId, nodeId, sessionId, delta }` and event name `agent-reasoning-summary`.

- [ ] **Step 1: Add failing Rust payload and source-contract tests**

Add a test that refers to the missing payload type:

```rust
#[test]
fn public_reasoning_event_contains_only_scoped_delta_fields() {
    let event = AgentReasoningSummaryEvent {
        run_id: "run-1".into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: "session-1".into(),
        delta: "公开思考".into(),
    };
    let value = serde_json::to_value(event).unwrap();
    assert_eq!(value["delta"], "公开思考");
    assert!(value.get("reasoningContent").is_none());
    assert_eq!(value.as_object().unwrap().len(), 5);
}
```

Extend `tests/workspace-regressions.test.ts`:

```ts
test("conversation emits public reasoning summaries but never hidden reasoning", async () => {
  const source = await readFile("src-tauri/src/lib.rs", "utf8");
  assert.match(source, /"agent-reasoning-summary"/);
  assert.match(source, /StreamDelta::ReasoningSummary\(text\)/);
  const start = source.indexOf("struct AgentReasoningSummaryEvent");
  const end = source.indexOf("struct AgentFinishedEvent", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /reasoning_content/);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml public_reasoning_event_contains_only_scoped_delta_fields
node --test --experimental-strip-types --test-name-pattern="emits public reasoning" tests/*.test.ts
```

Expected: Rust compilation fails because the payload is missing; the source test fails because the event is not emitted.

- [ ] **Step 3: Emit only public reasoning for conversation runs**

Define `AgentReasoningSummaryEvent` with exactly five fields. In `spawn_agent_run`, replace the ignored branch with:

```rust
sion_agent::model_stream::StreamDelta::ReasoningSummary(text) => {
    let _ = event_app.emit(
        "agent-reasoning-summary",
        AgentReasoningSummaryEvent {
            run_id: event_run.id.clone(),
            project_id: event_run.project_id.clone(),
            node_id: event_run.node_id,
            session_id: event_session.clone(),
            delta: text.to_string(),
        },
    );
}
```

Leave the regeneration match arm as `ReasoningSummary(_) => {}`.

Add to `src/types.ts`:

```ts
export type AgentReasoningSummaryEvent = {
  runId: string;
  projectId: string;
  nodeId: NodeId;
  sessionId: string;
  delta: string;
};
```

- [ ] **Step 4: Run Task 2 tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml public_reasoning_event_contains_only_scoped_delta_fields
node --test --experimental-strip-types --test-name-pattern="emits public reasoning" tests/*.test.ts
```

Expected: PASS; payload serialization contains no hidden-reasoning field.

- [ ] **Step 5: Commit Task 2**

```bash
git add src-tauri/src/lib.rs src/types.ts tests/workspace-regressions.test.ts
git commit -m "feat(desktop): stream public reasoning summaries"
```

---

### Task 3: Scoped and Bounded Frontend Reasoning State

**Files:**
- Create: `src/reasoning-stream.ts`
- Create: `tests/reasoning-stream.test.ts`
- Modify: `src/App.tsx:1-55,90-135,235-320,1220-1365`
- Modify: `src/components/workspace/ProjectWorkspace.tsx:10-55,120-175`
- Modify: `src/components/workspace/ConversationPane.tsx:12-47,100-115`

**Interfaces:**
- Consumes: `AgentReasoningSummaryEvent` from Task 2.
- Produces: `appendLiveReasoning`, `removeLiveReasoning`, `clearLiveReasoning`, and `liveReasoningByRun: Record<string, string>`.
- Produces: `ConversationTurnCard.liveReasoning?: string` for Task 4.

- [ ] **Step 1: Write failing pure reducer tests**

Create `tests/reasoning-stream.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendLiveReasoning,
  clearLiveReasoning,
  removeLiveReasoning,
} from "../src/reasoning-stream.ts";

const scope = { projectId: "p", nodeId: "goals", sessionId: "s" } as const;

test("appends only matching scoped public reasoning", () => {
  const matching = { runId: "r", projectId: "p", nodeId: "goals", sessionId: "s", delta: "公开" } as const;
  assert.deepEqual(appendLiveReasoning({}, matching, scope), { r: "公开" });
  assert.deepEqual(appendLiveReasoning({}, { ...matching, sessionId: "other" }, scope), {});
});

test("bounds live reasoning to 2000 Unicode characters", () => {
  const event = { runId: "r", projectId: "p", nodeId: "goals", sessionId: "s", delta: "思".repeat(2001) } as const;
  assert.equal([...appendLiveReasoning({}, event, scope).r].length, 2000);
});

test("clears one terminal run or the whole navigation scope", () => {
  assert.deepEqual(removeLiveReasoning({ a: "A", b: "B" }, "a"), { b: "B" });
  assert.deepEqual(clearLiveReasoning(), {});
});
```

- [ ] **Step 2: Run reducer tests and verify RED**

Run:

```bash
node --test --experimental-strip-types tests/reasoning-stream.test.ts
```

Expected: FAIL because `src/reasoning-stream.ts` does not exist.

- [ ] **Step 3: Implement the minimal reducer**

Create `src/reasoning-stream.ts`:

```ts
import type { AgentReasoningSummaryEvent, NodeId } from "./types";

export type LiveReasoningByRun = Record<string, string>;
export const MAX_LIVE_REASONING_CHARS = 2_000;

export function appendLiveReasoning(
  current: LiveReasoningByRun,
  event: AgentReasoningSummaryEvent,
  scope: { projectId: string; nodeId: NodeId; sessionId: string },
): LiveReasoningByRun {
  if (event.projectId !== scope.projectId || event.nodeId !== scope.nodeId || event.sessionId !== scope.sessionId) return current;
  const bounded = [...((current[event.runId] ?? "") + event.delta)]
    .slice(0, MAX_LIVE_REASONING_CHARS)
    .join("");
  return { ...current, [event.runId]: bounded };
}

export function removeLiveReasoning(current: LiveReasoningByRun, runId: string): LiveReasoningByRun {
  const { [runId]: _removed, ...rest } = current;
  return rest;
}

export function clearLiveReasoning(): LiveReasoningByRun {
  return {};
}
```

- [ ] **Step 4: Run reducer tests and verify GREEN**

Run:

```bash
node --test --experimental-strip-types tests/reasoning-stream.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Wire scoped lifecycle into App**

Import `AgentReasoningSummaryEvent` and the reducer functions. Add:

```ts
const [liveReasoningByRun, setLiveReasoningByRun] = useState<LiveReasoningByRun>({});
```

In the existing event subscription group, add:

```ts
listen<AgentReasoningSummaryEvent>("agent-reasoning-summary", (event) => {
  const payload = event.payload;
  if (!project || !sessionId) return;
  setLiveReasoningByRun((current) => appendLiveReasoning(current, payload, {
    projectId: project.id,
    nodeId,
    sessionId,
  }));
}),
```

In `agent-run-finished`, call `removeLiveReasoning` for that run after the terminal turn reload is requested. Add a navigation effect:

```ts
useEffect(() => {
  setLiveReasoningByRun(clearLiveReasoning());
}, [project?.id, nodeId, sessionId]);
```

Pass the map through `ProjectWorkspace` and `ConversationPane`. At the card call site pass:

```tsx
liveReasoning={liveReasoningByRun[item.turn.runId]}
```

- [ ] **Step 6: Add a source regression for lifecycle boundaries**

Extend `tests/workspace-regressions.test.ts`:

```ts
test("live public reasoning is scoped and cleared at terminal or navigation boundaries", async () => {
  const app = await readFile("src/App.tsx", "utf8");
  assert.match(app, /listen<AgentReasoningSummaryEvent>\("agent-reasoning-summary"/);
  assert.match(app, /appendLiveReasoning/);
  assert.match(app, /removeLiveReasoning/);
  assert.match(app, /\[project\?\.id, nodeId, sessionId\]/);
});
```

- [ ] **Step 7: Run Task 3 tests and build**

Run:

```bash
node --test --experimental-strip-types tests/reasoning-stream.test.ts
node --test --experimental-strip-types --test-name-pattern="live public reasoning is scoped" tests/*.test.ts
npm run lint
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/reasoning-stream.ts tests/reasoning-stream.test.ts src/App.tsx src/components/workspace/ProjectWorkspace.tsx src/components/workspace/ConversationPane.tsx tests/workspace-regressions.test.ts
git commit -m "feat(ui): track live public reasoning safely"
```

---

### Task 4: Accessible Reasoning Disclosure and Failure Presentation

**Files:**
- Create: `src/components/workspace/ConversationReasoningDisclosure.tsx`
- Modify: `src/components/workspace/ConversationTurnCard.tsx:1-85`
- Modify: `src/conversation-turns.ts:35-65`
- Modify: `src-tauri/src/turn_runtime.rs:145-205`
- Modify: `src/components/workspace/RunDetailDialog.tsx:40-175`
- Modify: `src/styles/workspace.css:215-260`
- Modify: `tests/conversation-turns.test.ts`
- Modify: `tests/workspace-regressions.test.ts`

**Interfaces:**
- Consumes: `liveReasoning?: string` from Task 3 and durable `turn.reasoningSummary`.
- Produces: `ConversationReasoningDisclosure({ active, content })` and response-failure headline equal to `publicError`.

- [ ] **Step 1: Add failing headline and disclosure source tests**

Add to `tests/conversation-turns.test.ts`:

```ts
test("response failures headline the mapped provider reason", () => {
  const failed = turn({
    status: "failed",
    deliveryOutcome: {
      kind: "failed",
      stage: "response",
      publicError: "模型服务上游网关超时（HTTP 504），请稍后重新发送",
    },
  });
  assert.equal(turnHeadline(failed), "模型服务上游网关超时（HTTP 504），请稍后重新发送");
});
```

Add to `tests/workspace-regressions.test.ts`:

```ts
test("reasoning disclosure is collapsed, accessible, and adds no retry action", async () => {
  const source = await readFile("src/components/workspace/ConversationReasoningDisclosure.tsx", "utf8");
  assert.match(source, /useState\(false\)/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /Agent 正在思考/);
  assert.match(source, /模型暂未提供公开思考内容/);
  assert.doesNotMatch(source, /reasoning_content|重新请求|自动重试/);
});
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="response failures headline|reasoning disclosure" tests/*.test.ts
```

Expected: headline assertion fails with the generic delivery text and the disclosure test errors because the component does not exist.

- [ ] **Step 3: Create the focused disclosure component**

Create `ConversationReasoningDisclosure.tsx`:

```tsx
import { useState } from "react";

export function ConversationReasoningDisclosure({ active, content }: {
  active: boolean;
  content?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!active && !content) return null;
  const label = active ? "Agent 正在思考" : "思考内容";
  return (
    <section className={`conversation-reasoning ${active ? "is-active" : ""}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="conversation-turn-activity-dot" aria-hidden="true" />
        <strong>{label}</strong>
        <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {open ? (
        <div className="conversation-reasoning-content">
          {content || "模型暂未提供公开思考内容"}
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 4: Compose the disclosure and exact failure headline**

In `ConversationTurnCard`, add `liveReasoning?: string`, import the disclosure, and render it with a run-specific key:

```tsx
<ConversationReasoningDisclosure
  key={turn.runId}
  active={turn.status === "queued" || turn.status === "running"}
  content={liveReasoning || turn.reasoningSummary}
/>
```

Remove the old unconditional `<p className="conversation-turn-reasoning">`. In `turnHeadline`, change only response-stage failures:

```ts
case "failed":
  return turn.deliveryOutcome.stage === "response"
    ? turn.deliveryOutcome.publicError
    : "回复已完成，交付稿更新失败";
```

Confirm `RunDetailDialog.deliveryLabel` returns the same `publicError` for failed outcomes. Do not add any button. Keep the Task 1 change that attaches response failures to the “Agent 回复” activity.

- [ ] **Step 5: Style the disclosure as subordinate conversation content**

Add styles with no card-heavy shell:

```css
.conversation-reasoning { display: grid; justify-items: start; }
.conversation-reasoning > button { display: flex; align-items: center; gap: 7px; border: 0; border-radius: 8px; padding: 5px 7px; color: var(--text-muted); background: transparent; font-size: 11px; cursor: pointer; }
.conversation-reasoning > button:hover { color: var(--text); background: var(--bg-hover); }
.conversation-reasoning > button:focus-visible { outline: 2px solid color-mix(in srgb, var(--focus) 65%, transparent); outline-offset: 1px; }
.conversation-reasoning.is-active .conversation-turn-activity-dot { background: var(--focus); animation: workspace-caret 850ms steps(1) infinite; }
.conversation-reasoning-content { max-width: 100%; margin: 1px 0 0 14px; border-left: 1px solid var(--border); padding: 7px 10px; color: var(--text-muted); font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
```

- [ ] **Step 6: Run Task 4 tests and verify GREEN**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="response failures headline|reasoning disclosure" tests/*.test.ts
npm run test:ui
npm run build
```

Expected: all UI tests pass; the 504 copy is visible through the failed turn with no new retry control.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/components/workspace/ConversationReasoningDisclosure.tsx src/components/workspace/ConversationTurnCard.tsx src/conversation-turns.ts src-tauri/src/turn_runtime.rs src/components/workspace/RunDetailDialog.tsx src/styles/workspace.css tests/conversation-turns.test.ts tests/workspace-regressions.test.ts
git commit -m "feat(ui): reveal live public reasoning"
```

---

### Task 5: Documentation, Leakage Audit, and Full Verification

**Files:**
- Modify: `README.md:45-60,166-185`
- Modify: `README.en.md:45-60,166-185`
- Modify: `tests/workspace-regressions.test.ts`

**Interfaces:**
- Consumes: all earlier task contracts.
- Produces: documented behavior and release-ready verification evidence.

- [ ] **Step 1: Add a final failing migration contract**

Extend `tests/workspace-regressions.test.ts`:

```ts
test("live reasoning and provider errors preserve the public-only boundary", async () => {
  const [transport, desktop, app, disclosure] = await Promise.all([
    readFile("crates/sion-agent/src/model_stream.rs", "utf8"),
    readFile("src-tauri/src/lib.rs", "utf8"),
    readFile("src/App.tsx", "utf8"),
    readFile("src/components/workspace/ConversationReasoningDisclosure.tsx", "utf8"),
  ]);
  assert.match(transport, /StreamFailure/);
  assert.match(desktop, /agent-reasoning-summary/);
  assert.match(app, /AgentReasoningSummaryEvent/);
  assert.match(disclosure, /aria-expanded/);
  const eventStart = desktop.indexOf("struct AgentReasoningSummaryEvent");
  const eventEnd = desktop.indexOf("struct AgentFinishedEvent", eventStart);
  assert.ok(eventStart >= 0 && eventEnd > eventStart);
  assert.doesNotMatch(desktop.slice(eventStart, eventEnd), /reasoning_content/);
  assert.doesNotMatch([app, disclosure].join("\n"), /reasoning_content/);
  assert.doesNotMatch(disclosure, /重新请求/);
});
```

- [ ] **Step 2: Run the migration contract**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="public-only boundary" tests/*.test.ts
```

Expected: PASS after Tasks 1–4; if it fails, repair the missing contract before documentation.

- [ ] **Step 3: Update Chinese and English documentation**

Document these exact behaviors in both READMEs:

- The expandable live area contains provider-supplied public reasoning only.
- Providers that expose only hidden reasoning show execution state without text.
- Public reasoning is capped at 2,000 characters and hidden reasoning never enters project data.
- Provider failures show safe, specific reasons; 504 means the upstream gateway timed out.
- Sion performs no automatic retry and adds no failed-run retry button.

- [ ] **Step 4: Run every verification command independently**

Run each command separately and require exit code `0`:

```bash
npm run lint
npm run test:ui
npm run build
npm run test:no-browser-runtime
npm run test:storage-contract
cargo test --workspace
npm run test:rust
cargo clippy --workspace -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected evidence:

- All Node tests report zero failures.
- Both Rust suites report zero failures.
- Both Clippy commands finish with no warnings.
- The runtime and storage contract scripts exit `0`.

- [ ] **Step 5: Audit public events and durable records for leakage**

Run:

```bash
rg -n "reasoning_content|raw_response|fullPrompt|rawResponse|api[_-]?key|authorization|bearer" crates/sion-agent/src src-tauri/src src src/types.ts
rg -n "agent-reasoning-summary|AgentReasoningSummaryEvent" src-tauri/src/lib.rs src/App.tsx src/types.ts
```

Expected: hidden-reasoning and secret matches remain only in deliberate parser rejection, existing internal transport fields, and tests. `AgentReasoningSummaryEvent` contains only the five approved fields, and no frontend component references `reasoning_content`.

- [ ] **Step 6: Commit documentation and final regression coverage**

```bash
git add README.md README.en.md tests/workspace-regressions.test.ts
git commit -m "docs: explain live public reasoning failures"
```

- [ ] **Step 7: Review the completed series without touching user changes**

Run:

```bash
git log --oneline --decorate -8
git status --short
git diff --check HEAD~5..HEAD
```

Expected: five feature commits appear in dependency order. The isolated implementation worktree is clean. The main worktree’s pre-existing uncommitted changes remain outside these commits and are handled only during the user-approved integration step.
