# Conversation Model, Context, and File Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each Provider own multiple manually configured models, persist model and reasoning choices per chat session, attach file-pool files to one message, estimate the selected model's input context, and preserve the actual run metadata in local history.

**Architecture:** Keep React as a typed presentation layer and make Rust/Tauri authoritative for Provider resolution, session persistence, file text, prompt assembly, context estimation, run validation, and model networking. Add backward-compatible domain metadata in `sion-core`, atomic session mutations in `sion-storage`, frozen run parameters in `sion-agent`, and focused conversation controls in React. The send command validates and freezes all inputs before starting a run; API keys and file contents never cross ordinary IPC responses.

**Tech Stack:** React 19, TypeScript 5.9, Vite 8, Tauri 2.11, Rust 2024, serde/serde_json, reqwest SSE, Node's built-in test runner, Cargo test/clippy.

## Global Constraints

- New project data is written only to `<projects directory>/<project id>/`; writes remain atomic and node writes keep existing CAS behavior.
- Global application configuration remains only in `~/.sion/`; plaintext API keys remain in `~/.sion/providers.json` with restricted permissions.
- API keys never enter project data, exports, logs, run summaries, or ordinary IPC list responses.
- React never reads the local filesystem or contacts model providers directly; all native work uses typed Tauri wrappers.
- The desktop runtime gains no browser search, browser automation, Playwright, or web-egress subsystem.
- Reasoning choices are exactly `off`, `low`, `medium`, and `high`; new sessions default to `medium`.
- Models have no `supportsReasoning` flag. Non-`off` effort is sent and provider rejection is reported as a readable failure.
- Each model has a manually entered input context window. Missing context blocks selection and sending; no guessed 128K migration value is allowed.
- Sion does not configure or transmit a maximum output limit and does not auto-truncate prompt content.
- Estimated input below 80% is ready, 80% through 100% is warning, and above 100% is blocked.
- Selected files apply to the next user message only. Validation failure preserves chips; successful message persistence clears them.
- Preserve unrelated user changes already present in `src/App.tsx` and `crates/sion-core/src/lib.rs`; inspect and merge rather than overwrite them.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `crates/sion-core/src/conversation.rs` | Reasoning/model metadata, attachment snapshots, context estimate types, and deterministic token estimation. |
| `src-tauri/src/conversation_runtime.rs` | Shared prompt assembly, full selected-file loading, preflight preparation, and context estimation. |
| `src/conversation-controls.ts` | Pure frontend selection, attachment, and context-indicator state helpers. |
| `tests/conversation-controls.test.ts` | Node tests for the pure conversation helpers. |
| `src/components/workspace/ConversationModelMenu.tsx` | Two-level model/reasoning menu with keyboard and outside-click behavior. |
| `src/components/workspace/ConversationFileMenu.tsx` | One-message file selection and import entry. |
| `src/components/workspace/ContextUsageIndicator.tsx` | Compact circular context indicator and accessible detail popover. |

### Existing files to modify

| File | Responsibility in this change |
|---|---|
| `crates/sion-core/src/lib.rs` | Export the conversation module and add optional metadata to `ChatSession`/`ChatMessage`. |
| `crates/sion-storage/src/lib.rs` | Persist session selections, expose single-session reads, and update legacy fixtures. |
| `src-tauri/src/provider_settings.rs` | Provider schema v2, multiple model validation, context windows, and exact model resolution. |
| `crates/sion-agent/src/lib.rs` | Freeze model, reasoning, and file IDs in every new `AgentRun`. |
| `crates/sion-agent/src/model_stream.rs` | Map normalized reasoning into both request protocols without output limits. |
| `src-tauri/src/lib.rs` | Register new IPC commands, orchestrate validated sends, and save execution metadata. |
| `src/types.ts` | Mirror new Provider, session, message, run, estimate, and reasoning contracts. |
| `src/api.ts` | Typed wrappers for session selection, context estimation, multi-model save, and combined send. |
| `src/components/settings/ProviderEditorDialog.tsx` | Edit an array of model rows and context windows. |
| `src/components/settings/SettingsDialog.tsx` | Summarize model counts and incomplete-context state. |
| `src/components/workspace/ConversationPane.tsx` | Compose new controls, chips, metadata, and disabled reasons. |
| `src/components/workspace/ProjectWorkspace.tsx` | Thread new conversation props and callbacks. |
| `src/App.tsx` | Coordinate session selection, debounced estimates, imports, sends, and event refreshes. |
| `src/styles/dialogs.css` | Multi-model editor layout and validation states. |
| `src/styles/workspace.css` | Two-level menus, chips, circular indicator, and history metadata. |
| `tests/workspace-regressions.test.ts` | Static accessibility and wiring regressions for the new controls. |
| `scripts/verify-storage-contract.mjs` | Include new native/UI files in the existing storage-boundary scan. |
| `README.md`, `README.en.md` | Document multi-model sessions, one-message files, and local context checks. |

---

### Task 1: Add backward-compatible conversation domain types

**Files:**
- Create: `crates/sion-core/src/conversation.rs`
- Modify: `crates/sion-core/src/lib.rs:337-444`
- Modify: `crates/sion-storage/src/lib.rs:351-376, 1211-1223` (mechanical empty compatibility fields)
- Modify: `src-tauri/src/lib.rs:1542-1557` (mechanical empty compatibility fields)

**Interfaces:**
- Consumes: serde and the existing camelCase JSON convention.
- Produces: `ReasoningEffort`, `ChatModelSelection`, `MessageAttachmentRef`, `ModelExecution`, `ContextEstimateStatus`, `ContextEstimate`, `estimate_input_tokens`, and `estimate_context`.

- [ ] **Step 1: Add failing domain serialization and estimation tests**

Create `crates/sion-core/src/conversation.rs` with a `#[cfg(test)]` module that asserts the exact public API:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_effort_defaults_to_medium_and_serializes_snake_case() {
        assert_eq!(ReasoningEffort::default(), ReasoningEffort::Medium);
        assert_eq!(serde_json::to_string(&ReasoningEffort::Off).unwrap(), "\"off\"");
        assert_eq!(ReasoningEffort::High.provider_value(), Some("high"));
        assert_eq!(ReasoningEffort::Off.provider_value(), None);
    }

    #[test]
    fn estimates_ascii_unicode_and_thresholds_deterministically() {
        assert_eq!(estimate_input_tokens("abcdefgh"), 3); // ceil(2 * 1.15)
        assert_eq!(estimate_input_tokens("需求"), 3); // ceil(2 * 1.15)
        assert_eq!(estimate_context("a".repeat(276).as_str(), 100).status, ContextEstimateStatus::Warning);
        assert_eq!(estimate_context("a".repeat(348).as_str(), 100).status, ContextEstimateStatus::Blocked);
    }
}
```

Add `mod conversation; pub use conversation::*;` near the top of `lib.rs`, then add legacy JSON tests showing missing `modelSelection`, `attachments`, and `modelExecution` deserialize as empty values.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
cargo test -p sion-core conversation::tests -- --nocapture
```

Expected: compilation fails because the types and functions referenced by the tests do not exist.

- [ ] **Step 3: Implement the domain contracts and compatibility defaults**

Implement these public definitions in `conversation.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Off,
    Low,
    #[default]
    Medium,
    High,
}

impl ReasoningEffort {
    pub fn provider_value(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High => Some("high"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelSelection {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachmentRef {
    pub file_id: String,
    pub original_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelExecution {
    pub provider_id: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextEstimateStatus { Ready, Warning, Blocked }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEstimate {
    pub estimated_input_tokens: u64,
    pub context_window_tokens: u64,
    pub ratio: f64,
    pub status: ContextEstimateStatus,
}

pub fn estimate_input_tokens(text: &str) -> u64 {
    let mut ascii_bytes = 0_u64;
    let mut non_ascii = 0_u64;
    for character in text.chars() {
        if character.is_ascii() { ascii_bytes += character.len_utf8() as u64; }
        else { non_ascii += 1; }
    }
    let base = ascii_bytes.div_ceil(4) + non_ascii;
    (base * 115).div_ceil(100)
}

pub fn estimate_context(text: &str, window: u64) -> ContextEstimate {
    let estimated = estimate_input_tokens(text);
    let ratio = estimated as f64 / window as f64;
    let status = if ratio > 1.0 { ContextEstimateStatus::Blocked }
        else if ratio >= 0.8 { ContextEstimateStatus::Warning }
        else { ContextEstimateStatus::Ready };
    ContextEstimate { estimated_input_tokens: estimated, context_window_tokens: window, ratio, status }
}
```

Extend `ChatSession` with `#[serde(default, skip_serializing_if = "Option::is_none")] pub model_selection: Option<ChatModelSelection>`. Extend `ChatMessage` with an empty-by-default `attachments: Vec<MessageAttachmentRef>` and optional `model_execution: Option<ModelExecution>`. Update every existing constructor in core, storage, and Tauri to provide `model_selection: None`, `attachments: Vec::new()`, and `model_execution: None`; later tasks replace those temporary empty values where required.

- [ ] **Step 4: Run the core tests**

Run:

```bash
cargo test -p sion-core
cargo test -p sion-storage
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all core, storage, and desktop tests pass, including legacy message fixtures.

- [ ] **Step 5: Commit the domain types**

```bash
git add crates/sion-core/src/conversation.rs crates/sion-core/src/lib.rs crates/sion-storage/src/lib.rs src-tauri/src/lib.rs
git commit -m "feat(core): model conversation execution context"
```

---

### Task 2: Persist session model selections atomically

**Files:**
- Modify: `crates/sion-storage/src/lib.rs:339-423, 624-691, 1200-1325`
- Modify: `src-tauri/src/lib.rs:1218-1232` (pass `None` until Task 6 supplies the resolved selection)

**Interfaces:**
- Consumes: `ChatModelSelection`, `ChatSession`, and the existing atomic session index.
- Produces: `ProjectStore::session`, the expanded `create_session`, and `ProjectStore::update_session_model`.

- [ ] **Step 1: Write failing storage tests**

Add tests that create, update, reload, and read a legacy session:

```rust
#[test]
fn persists_and_updates_session_model_selection() {
    let root = temp_project();
    std::fs::create_dir_all(&root).unwrap();
    ProjectStore::create_in(&root, input()).unwrap();
    let store = ProjectStore::at(root.join("project-1"));
    let first = ChatModelSelection {
        provider_id: "openai".into(), model: "gpt-a".into(), reasoning_effort: ReasoningEffort::Medium,
    };
    let session = store.create_session(
        WorkflowNodeId::Goals, "讨论".into(), Some(first), "2026-07-17T00:00:00Z".into(),
    ).unwrap();
    let second = ChatModelSelection {
        provider_id: "openai".into(), model: "gpt-b".into(), reasoning_effort: ReasoningEffort::Off,
    };
    let updated = store.update_session_model(
        WorkflowNodeId::Goals, &session.id, second.clone(), "2026-07-17T00:01:00Z".into(),
    ).unwrap();
    assert_eq!(updated.model_selection, Some(second.clone()));
    assert_eq!(store.session(WorkflowNodeId::Goals, &session.id).unwrap().model_selection, Some(second));
    std::fs::remove_dir_all(root).unwrap();
}
```

Extend `reads_legacy_session_indexes_in_place` to assert `model_selection == None`. Update `chat_message` to fill the new empty metadata fields.

- [ ] **Step 2: Verify the storage test fails**

Run: `cargo test -p sion-storage persists_and_updates_session_model_selection -- --nocapture`

Expected: compilation fails because the new method signatures do not exist.

- [ ] **Step 3: Implement the session methods**

Change `create_session` to accept `model_selection: Option<ChatModelSelection>` and assign it to the new session. Add:

```rust
pub fn session(&self, node_id: WorkflowNodeId, session_id: &str) -> Result<ChatSession> {
    self.read_sessions(node_id)?
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))
}

pub fn update_session_model(
    &self,
    node_id: WorkflowNodeId,
    session_id: &str,
    model_selection: ChatModelSelection,
    updated_at: String,
) -> Result<ChatSession> {
    self.manifest()?;
    self.recover_pending_append(node_id)?;
    let mut sessions = self.read_sessions(node_id)?;
    let session = sessions.iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))?;
    session.model_selection = Some(model_selection);
    session.updated_at = updated_at;
    let updated = session.clone();
    atomic_write_json(&self.sessions_path(node_id), &sessions)?;
    Ok(updated)
}
```

Update all `create_session` and `ChatMessage` call sites inside storage tests without changing their previous behavior.

At the current Tauri `session_create` call, pass `None` as the new `model_selection` argument. Task 6 replaces this mechanical value with validated explicit/default selection.

- [ ] **Step 4: Run storage tests**

Run:

```bash
cargo test -p sion-storage
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all storage and desktop tests pass; legacy sessions still load with no migration rewrite.

- [ ] **Step 5: Commit session persistence**

```bash
git add crates/sion-storage/src/lib.rs src-tauri/src/lib.rs
git commit -m "feat(storage): persist session model choices"
```

---

### Task 3: Upgrade Provider storage to multiple context-aware models

**Files:**
- Modify: `src-tauri/src/provider_settings.rs:1-390`

**Interfaces:**
- Consumes: `ChatModelSelection` and current `~/.sion/providers.json` v1 records.
- Produces: Provider schema v2, `ProviderModel.context_window_tokens`, `default_selection`, and `resolve_model`.

- [ ] **Step 1: Write failing Provider tests**

Add tests for v1 compatibility, validation, and exact resolution:

```rust
#[test]
fn reads_v1_models_as_incomplete_but_requires_context_on_save() {
    let root = root();
    fs::create_dir_all(&root).unwrap();
    fs::write(path(&root), r#"{"schemaVersion":1,"providers":[{"id":"p","name":"P","apiBaseUrl":"https://example.invalid/v1","apiUrlMode":"base","protocol":"chat_completions","models":[{"name":"m","isDefault":true,"toolCalling":false}],"isDefault":true,"createdAt":"now","updatedAt":"now","apiKey":"secret"}]}"#).unwrap();
    assert_eq!(list(&root).unwrap()[0].models[0].context_window_tokens, None);
    assert!(resolve_model(&root, "p", "m").unwrap_err().contains("context window"));
}

#[test]
fn resolves_the_requested_provider_model_and_context() {
    let root = root();
    let mut value = input("p");
    value.models = vec![
        ProviderModel { name: "a".into(), is_default: false, tool_calling: false, context_window_tokens: Some(64_000) },
        ProviderModel { name: "b".into(), is_default: true, tool_calling: false, context_window_tokens: Some(128_000) },
    ];
    save(&root, value).unwrap();
    let resolved = resolve_model(&root, "p", "b").unwrap();
    assert_eq!(resolved.context_window_tokens, 128_000);
    assert_eq!(default_selection(&root).unwrap().model, "b");
}
```

Also assert empty, duplicate trimmed names, zero context, and multiple defaults are rejected.

- [ ] **Step 2: Run Provider tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml provider_settings::tests -- --nocapture`

Expected: compilation fails on the missing context field and resolver functions.

- [ ] **Step 3: Implement schema v2 and exact validation**

Set `PROVIDERS_SCHEMA_VERSION` to `2`. Make `ProviderModel` backward compatible:

```rust
pub struct ProviderModel {
    pub name: String,
    pub is_default: bool,
    pub tool_calling: bool,
    #[serde(default)]
    pub context_window_tokens: Option<u64>,
}
```

Allow `read_file` to read versions 1 and 2, normalize the in-memory schema to 2, and reject future versions. In `validate_input`, require unique trimmed names, exactly one default, and `Some(window)` where `window > 0`. Trim Provider and model display fields before writing.

Add `context_window_tokens: u64` to `ResolvedModel`, plus:

```rust
pub fn default_selection(root: &Path) -> Result<ChatModelSelection, String>;
pub fn resolve_model(root: &Path, provider_id: &str, model_name: &str) -> Result<ResolvedModel, String>;
```

`default_selection` returns `ReasoningEffort::Medium`. `resolve_model` selects only the exact Provider and model, rejects missing context, builds the existing endpoint, and keeps the API key process-only. Keep `resolve_default_model` only if another existing caller still needs it; otherwise replace its callers and remove it.

- [ ] **Step 4: Run Provider and desktop Rust tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml provider_settings::tests
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: both commands pass; the API key tests still prove summaries omit secrets and Unix mode is `0600`.

- [ ] **Step 5: Commit Provider schema changes**

```bash
git add src-tauri/src/provider_settings.rs
git commit -m "feat(provider): configure multiple model contexts"
```

---

### Task 4: Freeze run parameters and map reasoning in model requests

**Files:**
- Modify: `crates/sion-agent/src/lib.rs:13-210`
- Modify: `crates/sion-agent/src/model_stream.rs:1-230`
- Modify: `src-tauri/src/lib.rs:659-713, 1440-1510, 1750-1785` (mechanical call-site compatibility until Task 7)

**Interfaces:**
- Consumes: `ReasoningEffort` from `sion-core`.
- Produces: frozen optional legacy-compatible fields on `AgentRun`, expanded `RunRequest`, and reasoning-aware `StreamRequest`.

- [ ] **Step 1: Write failing scheduler and request-body tests**

Add a scheduler test that enqueues:

```rust
let run = scheduler.enqueue(RunRequest {
    project_id: "project-a".into(), node_id: WorkflowNodeId::Goals,
    provider_id: "provider-a".into(), model: "model-a".into(),
    reasoning_effort: ReasoningEffort::High, file_ids: vec!["file-a".into()], created_at: "now".into(),
}).unwrap();
assert_eq!(run.provider_id.as_deref(), Some("provider-a"));
assert_eq!(run.model.as_deref(), Some("model-a"));
assert_eq!(run.reasoning_effort, Some(ReasoningEffort::High));
assert_eq!(run.file_ids, vec!["file-a"]);
```

Extract a pure `request_body(&StreamRequest) -> serde_json::Value` and test these exact shapes using the existing `request(endpoint, protocol)` fixture helper:

```rust
let mut chat_request = request("https://example.invalid/chat".into(), ProviderProtocol::ChatCompletions);
chat_request.reasoning_effort = ReasoningEffort::High;
let chat_high = request_body(&chat_request);
chat_request.reasoning_effort = ReasoningEffort::Off;
let chat_off = request_body(&chat_request);
let mut responses_request = request("https://example.invalid/responses".into(), ProviderProtocol::OpenaiResponses);
responses_request.reasoning_effort = ReasoningEffort::Low;
let responses_low = request_body(&responses_request);
responses_request.reasoning_effort = ReasoningEffort::Off;
let responses_off = request_body(&responses_request);
assert_eq!(chat_high["reasoning_effort"], "high");
assert!(chat_off.get("reasoning_effort").is_none());
assert_eq!(responses_low["reasoning"]["effort"], "low");
assert!(responses_off.get("reasoning").is_none());
for body in [chat_high, chat_off, responses_low, responses_off] {
    assert!(body.get("max_tokens").is_none());
    assert!(body.get("max_output_tokens").is_none());
}
```

- [ ] **Step 2: Run the focused agent tests and verify failure**

Run: `cargo test -p sion-agent -- --nocapture`

Expected: compilation fails because `RunRequest`, frozen fields, and `StreamRequest.reasoning_effort` do not exist.

- [ ] **Step 3: Implement frozen run metadata**

Add:

```rust
#[derive(Debug, Clone)]
pub struct RunRequest {
    pub project_id: String,
    pub node_id: WorkflowNodeId,
    pub provider_id: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    pub file_ids: Vec<String>,
    pub created_at: String,
}
```

Extend `AgentRun` with `#[serde(default, skip_serializing_if = "Option::is_none")]` optional `provider_id`, `model`, and `reasoning_effort`, plus an empty-by-default `file_ids`. Change `enqueue` to accept `RunRequest` and fill every field for new runs. Update all scheduler tests and Tauri call sites to compile.

At the existing Tauri enqueue call, construct a temporary compatible `RunRequest` from the currently resolved default model, `ReasoningEffort::Medium`, and the request's `file_ids`. Task 7 replaces this default-only path with persisted session selection. Add `None`/empty values to the legacy `AgentRun` literal in `agent_run_project_validation_rejects_cross_project_cancellation`.

- [ ] **Step 4: Implement protocol reasoning mapping**

Add `reasoning_effort: ReasoningEffort` to `StreamRequest`. Build the existing body first, then insert only the non-`off` field:

```rust
if let Some(effort) = request.reasoning_effort.provider_value() {
    match request.protocol {
        ProviderProtocol::ChatCompletions => {
            body["reasoning_effort"] = serde_json::json!(effort);
        }
        ProviderProtocol::OpenaiResponses => {
            body["reasoning"] = serde_json::json!({ "effort": effort });
        }
    }
}
```

Do not add output-limit fields. Keep SSE parsing and cancellation unchanged.

- [ ] **Step 5: Run agent tests**

Run: `cargo test -p sion-agent`

Expected: all scheduler, request-body, SSE, and cancellation tests pass.

- [ ] **Step 6: Commit run freezing and reasoning transport**

```bash
git add crates/sion-agent/src/lib.rs crates/sion-agent/src/model_stream.rs src-tauri/src/lib.rs
git commit -m "feat(agent): freeze run model and reasoning"
```

---

### Task 5: Extract one authoritative prompt and context estimator

**Files:**
- Create: `src-tauri/src/conversation_runtime.rs`
- Modify: `src-tauri/src/lib.rs:1360-1440`

**Interfaces:**
- Consumes: `ProjectStore`, `WorkflowNode`, `ChatMessage`, `ChatModelSelection`, and `ResolvedModel`.
- Produces: `SelectedFileContext`, `ConversationParts`, `PreparedConversation`, `load_selected_files`, `build_agent_prompt`, `prepare_from_parts`, and `prepare_conversation`.

- [ ] **Step 1: Write failing runtime tests**

Create tests in `conversation_runtime.rs` that prove the prompt includes the draft exactly once, reads full extracted text without the old 12K/48K caps, and returns blocked status above the model window:

```rust
#[test]
fn prompt_and_estimate_share_the_exact_final_text() {
    let node = WorkflowNode {
        id: WorkflowNodeId::Goals,
        status: NodeStatus::Draft,
        markdown: "# 项目目标".into(),
        revision: 0,
        updated_at: "now".into(),
    };
    let attachments = vec![SelectedFileContext {
        file_id: "file-a".into(),
        original_name: "长文件.md".into(),
        text: "中".repeat(60_000),
    }];
    let prepared = prepare_from_parts(ConversationParts {
        node: &node,
        messages: &[],
        project_override: None,
        attachments: &attachments,
        draft: "当前草稿消息",
    }, 100_000);
    assert!(prepared.prompt.contains("当前草稿消息"));
    assert_eq!(prepared.prompt.matches("当前草稿消息").count(), 1);
    assert!(prepared.prompt.contains(&"中".repeat(60_000)));
    assert_eq!(prepared.estimate, estimate_context(&prepared.prompt, 100_000));
}
```

- [ ] **Step 2: Run desktop tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml conversation_runtime -- --nocapture`

Expected: compilation fails because the runtime module and helpers are absent.

- [ ] **Step 3: Move prompt assembly into the focused module**

Declare `mod conversation_runtime;` in `src-tauri/src/lib.rs`. Move `compose_effective_agent_rules`, `agent_prompt`, and `selected_file_context` into the new module. Replace tuple attachments with:

```rust
pub struct SelectedFileContext {
    pub file_id: String,
    pub original_name: String,
    pub text: String,
}

pub struct PreparedConversation {
    pub prompt: String,
    pub attachments: Vec<MessageAttachmentRef>,
    pub estimate: ContextEstimate,
}
```

`load_selected_files` deduplicates IDs in request order, loads the full extracted text through `ProjectStore::read_file_text`, rejects missing/unreadable files, and never applies a character excerpt. `build_agent_prompt` keeps the existing delivery contract and last-16-message behavior. `prepare_conversation` appends the draft user message in memory, builds one final prompt, then calls `estimate_context` on that exact string.

Define `ConversationParts<'a>` with the five fields shown in the test. `prepare_from_parts` is the pure boundary used by tests; `prepare_conversation` performs ProjectStore reads and delegates to it.

Use these exact signatures:

```rust
pub fn load_selected_files(store: &ProjectStore, file_ids: &[String]) -> Result<Vec<SelectedFileContext>, String>;
pub fn build_agent_prompt(parts: ConversationParts<'_>) -> String;
pub fn prepare_from_parts(parts: ConversationParts<'_>, context_window_tokens: u64) -> PreparedConversation;
pub fn prepare_conversation(
    store: &ProjectStore,
    node_id: WorkflowNodeId,
    session_id: Option<&str>,
    draft: &str,
    file_ids: &[String],
    context_window_tokens: u64,
) -> Result<PreparedConversation, String>;
```

- [ ] **Step 4: Run runtime and full desktop tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml conversation_runtime
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all tests pass and existing Agent prompt assertions remain unchanged except for the explicit current draft fixture.

- [ ] **Step 5: Commit the runtime extraction**

```bash
git add src-tauri/src/conversation_runtime.rs src-tauri/src/lib.rs
git commit -m "refactor(chat): share prompt context preparation"
```

---

### Task 6: Add session-selection and context-estimate IPC commands

**Files:**
- Modify: `src-tauri/src/lib.rs:452-490, 1210-1285, 1620-1650`

**Interfaces:**
- Consumes: `provider_settings::default_selection`, `provider_settings::resolve_model`, and Task 5 preparation helpers.
- Produces: `session_model_update` and `agent_context_estimate` Tauri commands; `session_create` accepts an optional explicit selection.

- [ ] **Step 1: Add failing request/helper tests**

Add unit tests around a pure resolver used by both commands:

```rust
#[test]
fn session_selection_prefers_explicit_then_default() {
    let explicit = ChatModelSelection {
        provider_id: "p".into(), model: "m".into(), reasoning_effort: ReasoningEffort::Off,
    };
    assert_eq!(selection_for_new_session(Some(explicit.clone()), || panic!()).unwrap(), explicit);
    assert_eq!(selection_for_new_session(None, || Ok(ChatModelSelection {
        provider_id: "default".into(), model: "m".into(), reasoning_effort: ReasoningEffort::Medium,
    })).unwrap().provider_id, "default");
}
```

Add this serde request fixture proving `sessionId` may be absent for an unsaved first draft while `modelSelection` is present:

```rust
#[test]
fn context_estimate_request_accepts_an_unsaved_session() {
    let request: AgentContextEstimateRequest = serde_json::from_value(serde_json::json!({
        "apiVersion": API_VERSION,
        "projectId": "project-1",
        "nodeId": "goals",
        "sessionId": null,
        "modelSelection": { "providerId": "p", "model": "m", "reasoningEffort": "medium" },
        "message": "draft",
        "fileIds": []
    })).unwrap();
    assert_eq!(request.session_id, None);
    assert_eq!(request.model_selection.model, "m");
}
```

- [ ] **Step 2: Run desktop tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session_selection -- --nocapture`

Expected: compilation fails because the resolver and requests do not exist.

- [ ] **Step 3: Implement the requests and commands**

Add request structures:

```rust
struct SessionModelUpdateRequest {
    version: VersionedRequest, project_id: String, node_id: WorkflowNodeId,
    session_id: String, model_selection: ChatModelSelection, now: String,
}

struct AgentContextEstimateRequest {
    version: VersionedRequest, project_id: String, node_id: WorkflowNodeId,
    session_id: Option<String>, model_selection: ChatModelSelection,
    message: String, file_ids: Vec<String>,
}
```

Extend `SessionCreateRequest` with `model_selection: Option<ChatModelSelection>`. On create, use the explicit selection or `default_selection`; validate it with `resolve_model`; then call the expanded storage method. `session_model_update` validates before atomically updating the session. `agent_context_estimate` validates the requested selection, loads session messages when `session_id` exists, calls `prepare_conversation`, and returns only `ContextEstimate`.

Implement the tested resolver exactly as:

```rust
fn selection_for_new_session<F>(
    explicit: Option<ChatModelSelection>,
    load_default: F,
) -> Result<ChatModelSelection, String>
where
    F: FnOnce() -> Result<ChatModelSelection, String>,
{
    explicit.map(Ok).unwrap_or_else(load_default)
}
```

Register both commands in `generate_handler!`. Never include endpoint, key, file text, or prompt in the response.

- [ ] **Step 4: Run desktop Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all tests pass and command request types serialize in camelCase.

- [ ] **Step 5: Commit the new IPC boundary**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(chat): persist selection and estimate context"
```

---

### Task 7: Combine validated message send and Agent Run creation

**Files:**
- Modify: `src-tauri/src/lib.rs:51-60, 272-282, 659-713, 1440-1570`
- Modify: `src-tauri/src/conversation_runtime.rs`
- Modify: `crates/sion-agent/src/lib.rs`

**Interfaces:**
- Consumes: persisted `ChatSession.model_selection`, `PreparedConversation`, `RunRequest`, and exact Provider resolution.
- Produces: `PreparedSend`, pure `prepare_agent_send`, and one authoritative `agent_run_start` command that accepts message text and one-message file IDs.

- [ ] **Step 1: Write failing preflight tests**

Add this concrete fixture helper inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/lib.rs`, where it can reuse `temp_command_root` and `create_input` directly:

```rust
struct SendFixture {
    root: PathBuf,
    provider_root: PathBuf,
    store: ProjectStore,
    session: ChatSession,
    file: ProjectFile,
}

fn send_fixture(window: u64) -> SendFixture {
    let root = temp_command_root();
    let projects = root.join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    ProjectStore::create_in(&projects, create_input("project-1")).unwrap();
    let store = ProjectStore::at(projects.join("project-1"));
    let provider_root = root.join("global");
    provider_settings::save(&provider_root, provider_settings::ProviderInput {
        id: "provider-a".into(), name: "Provider A".into(),
        api_base_url: "https://example.invalid/v1".into(), api_url_mode: "base".into(),
        protocol: "chat_completions".into(), is_default: true, api_key: Some("secret".into()), now: "now".into(),
        models: vec![provider_settings::ProviderModel {
            name: "model-a".into(), is_default: true, tool_calling: false,
            context_window_tokens: Some(window),
        }],
    }).unwrap();
    let selection = ChatModelSelection {
        provider_id: "provider-a".into(), model: "model-a".into(), reasoning_effort: ReasoningEffort::High,
    };
    let session = store.create_session(
        WorkflowNodeId::Goals, "会话".into(), Some(selection), "now".into(),
    ).unwrap();
    let source = root.join("brief.md");
    std::fs::write(&source, "brief content").unwrap();
    let file = store.import_file(&source, "now".into()).unwrap();
    SendFixture { root, provider_root, store, session, file }
}
```

Then add preparation tests:

```rust
#[test]
fn blocked_context_does_not_append_a_message_or_run() {
    let fixture = send_fixture(8);
    let result = prepare_agent_send(
        &fixture.provider_root, &fixture.store, WorkflowNodeId::Goals,
        &fixture.session.id, "this input is intentionally too large", &[], "now",
    );
    assert!(result.unwrap_err().contains("context window"));
    assert!(fixture.store.messages(WorkflowNodeId::Goals, &fixture.session.id).unwrap().is_empty());
    assert!(fixture.store.list_runs().unwrap().is_empty());
    std::fs::remove_dir_all(fixture.root).unwrap();
}

#[test]
fn successful_send_snapshots_files_and_freezes_run_values() {
    let fixture = send_fixture(128_000);
    let prepared = prepare_agent_send(
        &fixture.provider_root, &fixture.store, WorkflowNodeId::Goals,
        &fixture.session.id, "use the brief", &[fixture.file.id.clone()], "now",
    ).unwrap();
    assert_eq!(prepared.user_message.attachments[0].original_name, fixture.file.original_name);
    let mut scheduler = sion_agent::RunScheduler::default();
    let run = scheduler.enqueue(prepared.run_request("project-1".into(), WorkflowNodeId::Goals, "now".into())).unwrap();
    assert_eq!(run.reasoning_effort, Some(ReasoningEffort::High));
    assert_eq!(run.file_ids, vec![fixture.file.id.clone()]);
    std::fs::remove_dir_all(fixture.root).unwrap();
}
```

Add a scheduler `ensure_available(project_id, node_id)` test so node-busy validation can happen before message persistence while holding the scheduler lock:

```rust
#[test]
fn availability_check_rejects_a_reserved_node_without_mutating_state() {
    let mut scheduler = RunScheduler::default();
    scheduler.enqueue(RunRequest {
        project_id: "project-a".into(), node_id: WorkflowNodeId::Goals,
        provider_id: "p".into(), model: "m".into(), reasoning_effort: ReasoningEffort::Medium,
        file_ids: vec![], created_at: "now".into(),
    }).unwrap();
    assert!(matches!(
        scheduler.ensure_available("project-a", WorkflowNodeId::Goals),
        Err(SchedulerError::NodeBusy { .. })
    ));
    assert_eq!(scheduler.active_count(), 1);
}
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml blocked_context_does_not_append -- --nocapture
cargo test -p sion-agent ensure_available -- --nocapture
```

Expected: compilation fails because combined send and `ensure_available` are absent.

- [ ] **Step 3: Implement authoritative send ordering**

Change `AgentRunStartRequest` to contain `message: String` as well as project/node/session/file IDs and `now`. In the command:

Define the preparation result so the command and tests use identical frozen values:

```rust
pub struct PreparedSend {
    pub resolved: provider_settings::ResolvedModel,
    pub selection: ChatModelSelection,
    pub prompt: String,
    pub estimate: ContextEstimate,
    pub user_message: ChatMessage,
    pub file_ids: Vec<String>,
}

impl PreparedSend {
    pub fn run_request(&self, project_id: String, node_id: WorkflowNodeId, created_at: String) -> RunRequest {
        RunRequest {
            project_id, node_id,
            provider_id: self.selection.provider_id.clone(),
            model: self.selection.model.clone(),
            reasoning_effort: self.selection.reasoning_effort,
            file_ids: self.file_ids.clone(),
            created_at,
        }
    }
}
```

`prepare_agent_send` loads the persisted session selection or `provider_settings::default_selection` for a legacy session, resolves it, delegates to `prepare_conversation`, returns a context error when blocked, and constructs `user_message` plus the frozen IDs without writing storage. The command persists that default selection before the first legacy-session message.

Use this exact signature:

```rust
pub fn prepare_agent_send(
    provider_root: &Path,
    store: &ProjectStore,
    node_id: WorkflowNodeId,
    session_id: &str,
    message: &str,
    file_ids: &[String],
    now: &str,
) -> Result<PreparedSend, String>;
```

Then keep the command body in this exact order:

```rust
let prepared = prepare_agent_send(
    &app_data_root,
    &store,
    request.node_id,
    &request.session_id,
    &request.message,
    &request.file_ids,
    &request.now,
).map_err(ApiError::CheckFailed)?;
if store.session(request.node_id, &request.session_id)
    .map_err(|error| ApiError::CheckFailed(error.to_string()))?
    .model_selection.is_none()
{
    store.update_session_model(
        request.node_id,
        &request.session_id,
        prepared.selection.clone(),
        request.now.clone(),
    ).map_err(|error| ApiError::CheckFailed(error.to_string()))?;
}
let run_request = prepared.run_request(
    request.project_id.clone(), request.node_id, request.now.clone(),
);
let mut scheduler = state.scheduler.lock()
    .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".into()))?;
scheduler.ensure_available(&request.project_id, request.node_id)
    .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
store.append_message(
    request.node_id,
    &request.session_id,
    prepared.user_message.clone(),
    request.now.clone(),
).map_err(|error| ApiError::CheckFailed(error.to_string()))?;
let run = scheduler.enqueue(run_request)
    .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
if let Err(error) = store.save_run(&run) {
    let promoted = scheduler.cancel(
        &run.id, request.now.clone(), Some("运行记录保存失败".into()),
    ).unwrap_or_default();
    drop(scheduler);
    spawn_promoted_runs(app.clone(), state.inner().clone(), promoted);
    return Err(ApiError::CheckFailed(error.to_string()));
}
```

Keep the scheduler lock across the availability check and enqueue so another send cannot interleave. If run persistence fails, cancel the just-created scheduler entry, drop the scheduler lock, start any runs promoted by that cancellation through `spawn_promoted_runs`, then return the storage error. Build `AgentJob` from the already prepared prompt and resolved process-only credentials. Insert the job and spawn immediately only when the scheduler returns `Running`.

- [ ] **Step 4: Save actual Assistant execution metadata**

Add `reasoning_effort` to `AgentJob` and `StreamRequest`. In `complete_agent_run`, set:

```rust
model_execution: Some(ModelExecution {
    provider_id: run.provider_id.clone().expect("new runs freeze provider"),
    model: run.model.clone().expect("new runs freeze model"),
    reasoning_effort: run.reasoning_effort.expect("new runs freeze effort"),
}),
attachments: Vec::new(),
```

Keep failure/cancellation rules unchanged. Improve Provider rejection messages containing reasoning fields with the suffix `请将推理强度改为“关闭”后重试。` without logging the request body.

- [ ] **Step 5: Run agent, storage, and desktop tests**

Run:

```bash
cargo test -p sion-agent
cargo test -p sion-storage
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all commands pass; blocked preflight leaves no message/run, successful sends snapshot files, and transport failures retain the saved user message plus a failed run.

- [ ] **Step 6: Commit combined send orchestration**

```bash
git add src-tauri/src/lib.rs src-tauri/src/conversation_runtime.rs crates/sion-agent/src/lib.rs
git commit -m "feat(chat): validate and freeze message runs"
```

---

### Task 8: Mirror contracts and pure conversation state in TypeScript

**Files:**
- Create: `src/conversation-controls.ts`
- Create: `tests/conversation-controls.test.ts`
- Modify: `src/types.ts:40-145`
- Modify: `src/api.ts:100-205`
- Modify: `src/components/settings/ProviderEditorDialog.tsx:20-65` (one-row compile adapter replaced in Task 9)
- Modify: `src/App.tsx:1-35, 638-680` (combined-send protocol migration completed visually in Task 11)

**Interfaces:**
- Consumes: native camelCase responses from Tasks 3, 6, and 7.
- Produces: typed UI contracts and pure helper functions consumed by later React tasks.

- [ ] **Step 1: Write failing frontend state tests**

Create `tests/conversation-controls.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { contextIndicatorKind, defaultModelSelection, toggleAttachment } from "../src/conversation-controls.ts";

const providers = [{
  id: "p", name: "Provider", apiBaseUrl: "https://example.invalid/v1", apiUrlMode: "base" as const,
  protocol: "chat_completions" as const, isDefault: true, hasApiKey: true,
  models: [
    { name: "incomplete", isDefault: false, toolCalling: false, contextWindowTokens: null },
    { name: "ready", isDefault: true, toolCalling: false, contextWindowTokens: 128000 },
  ],
}];

test("defaults to the configured default model and medium reasoning", () => {
  assert.deepEqual(defaultModelSelection(providers), { providerId: "p", model: "ready", reasoningEffort: "medium" });
});

test("toggles one-message attachments without duplicates", () => {
  assert.deepEqual(toggleAttachment(["a"], "a"), []);
  assert.deepEqual(toggleAttachment(["a"], "b"), ["a", "b"]);
});

test("maps context thresholds to compact indicator states", () => {
  assert.equal(contextIndicatorKind({ ratio: .79, status: "ready" }), "ready");
  assert.equal(contextIndicatorKind({ ratio: .8, status: "warning" }), "warning");
  assert.equal(contextIndicatorKind({ ratio: 1.01, status: "blocked" }), "blocked");
});
```

- [ ] **Step 2: Verify the Node test fails**

Run: `node --test --experimental-strip-types tests/conversation-controls.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/conversation-controls.ts`.

- [ ] **Step 3: Add exact TypeScript contracts and helpers**

Define:

```ts
export type ReasoningEffort = "off" | "low" | "medium" | "high";
export type ChatModelSelection = { providerId: string; model: string; reasoningEffort: ReasoningEffort };
export type MessageAttachmentRef = { fileId: string; originalName: string };
export type ModelExecution = ChatModelSelection;
export type ContextEstimate = {
  estimatedInputTokens: number; contextWindowTokens: number; ratio: number;
  status: "ready" | "warning" | "blocked";
};
```

Add `contextWindowTokens: number | null` to `ProviderModel`; change `ProviderDraft` to carry `models: ProviderModel[]`; extend session/message/run types with the optional legacy-compatible fields. Implement the three tested pure helpers plus `selectableModels(providers)` and `selectionIsValid(selection, providers)`.

```ts
export const selectableModels = (providers: Provider[]) => providers.flatMap((provider) =>
  provider.models
    .filter((model) => Number.isSafeInteger(model.contextWindowTokens) && (model.contextWindowTokens ?? 0) > 0)
    .map((model) => ({ provider, model })),
);

export const defaultModelSelection = (providers: Provider[]): ChatModelSelection | null => {
  const provider = providers.find((item) => item.isDefault) ?? providers[0];
  if (!provider) return null;
  const model = provider.models.find((item) => item.isDefault) ?? provider.models[0];
  return model?.contextWindowTokens
    ? { providerId: provider.id, model: model.name, reasoningEffort: "medium" }
    : null;
};

export const selectionIsValid = (selection: ChatModelSelection | null, providers: Provider[]) =>
  Boolean(selection && selectableModels(providers).some(({ provider, model }) =>
    provider.id === selection.providerId && model.name === selection.model));

export const toggleAttachment = (ids: string[], fileId: string) =>
  ids.includes(fileId) ? ids.filter((id) => id !== fileId) : [...ids, fileId];

export const contextIndicatorKind = (estimate: Pick<ContextEstimate, "status">) => estimate.status;
```

Update API wrappers:

```ts
createSession(projectId, nodeId, name, now, modelSelection?)
updateSessionModel(projectId, nodeId, sessionId, modelSelection, now)
estimateAgentContext(projectId, nodeId, sessionId, modelSelection, message, fileIds)
startAgentRun(projectId, nodeId, sessionId, message, fileIds, now)
```

Change `saveProvider` to transmit `draft.models` unchanged. As a temporary compile-safe adapter, add one numeric “上下文窗口” field beside the existing single model field and submit `models: [{ name: model.trim(), isDefault: true, toolCalling: false, contextWindowTokens: Number(contextWindow) }]`. Require a positive safe integer. Task 9 immediately replaces this functional one-row adapter with the required multi-row editor.

Migrate `App.sendMessage` to the combined `startAgentRun(..., content, selectedFileIds, now())` command now: remove the React-created user `ChatMessage` and the `appendMessage` call, reload durable messages after the command returns, and clear draft/files only on success. Keep `appendMessage` exported only if another current feature uses it. This keeps `npm run lint` and the desktop protocol functional at the end of Task 8; Task 11 adds selection and estimate UI state without changing the native send shape again.

- [ ] **Step 4: Run frontend state tests and type checking**

Run:

```bash
node --test --experimental-strip-types tests/conversation-controls.test.ts
npm run lint
```

Expected: all conversation helper tests pass; the one-row Provider adapter and combined-send App migration compile without TypeScript errors.

- [ ] **Step 5: Commit frontend contracts**

```bash
git add src/types.ts src/api.ts src/conversation-controls.ts tests/conversation-controls.test.ts src/components/settings/ProviderEditorDialog.tsx src/App.tsx
git commit -m "feat(ui): type conversation model controls"
```

---

### Task 9: Build the multi-model Provider editor

**Files:**
- Modify: `src/components/settings/ProviderEditorDialog.tsx:1-115`
- Modify: `src/components/settings/SettingsDialog.tsx:55-105`
- Modify: `src/styles/dialogs.css:90-150`
- Modify: `tests/workspace-regressions.test.ts`

**Interfaces:**
- Consumes: `Provider`, `ProviderDraft`, and `ProviderModel.contextWindowTokens`.
- Produces: a validated model-row editor that submits an array without collapsing existing models.

- [ ] **Step 1: Add a failing static regression test**

Append:

```ts
test("provider editor preserves a multi-model draft with context windows", async () => {
  const source = await readFile("src/components/settings/ProviderEditorDialog.tsx", "utf8");
  assert.match(source, /models\.map/);
  assert.match(source, /contextWindowTokens/);
  assert.match(source, /添加模型/);
  assert.doesNotMatch(source, /const \[model, setModel\]/);
});
```

- [ ] **Step 2: Run the regression test and verify failure**

Run: `node --test --experimental-strip-types tests/workspace-regressions.test.ts`

Expected: FAIL because the editor still owns one `model` string.

- [ ] **Step 3: Replace the single field with model-row state**

Use a form-only row type so incomplete input remains representable:

```ts
type ModelRow = { id: string; name: string; contextWindow: string; isDefault: boolean; toolCalling: boolean };
```

Initialize all Provider models on edit and one blank default row on add. Render name, numeric context window, default radio, and delete action. “添加模型” appends a non-default row. Prevent deleting the final row; when deleting the default, promote the first remaining row. On submit, trim names, parse positive safe integers, reject duplicates, require exactly one default, and map to `ProviderModel[]`.

Use inline errors adjacent to the model list. Keep blank-key-on-edit behavior unchanged. Do not add a reasoning capability checkbox or maximum-output field.

- [ ] **Step 4: Update Settings summaries and CSS**

Show `N 个模型` and `M 个待补充上下文` in Provider rows. Add focused CSS classes `.provider-model-list`, `.provider-model-row`, `.provider-model-fields`, and `.provider-model-error`; keep the medium dialog responsive at 680px.

- [ ] **Step 5: Run UI tests and build**

Run:

```bash
node --test --experimental-strip-types tests/workspace-regressions.test.ts
npm run lint
npm run build
```

Expected: all tests pass; the build contains no single-model draft conversion.

- [ ] **Step 6: Commit the Provider editor**

```bash
git add src/components/settings/ProviderEditorDialog.tsx src/components/settings/SettingsDialog.tsx src/styles/dialogs.css tests/workspace-regressions.test.ts
git commit -m "feat(settings): edit multiple model contexts"
```

---

### Task 10: Build focused conversation control components

**Files:**
- Create: `src/components/workspace/ConversationModelMenu.tsx`
- Create: `src/components/workspace/ConversationFileMenu.tsx`
- Create: `src/components/workspace/ContextUsageIndicator.tsx`
- Modify: `src/styles/workspace.css:80-190`
- Modify: `tests/workspace-regressions.test.ts`

**Interfaces:**
- Consumes: Provider lists, `ChatModelSelection`, Project files, selected IDs, and `ContextEstimate`.
- Produces: accessible controlled components; none invoke Tauri directly.

- [ ] **Step 1: Add failing component-boundary regressions**

Append tests that read each file and assert:

```ts
const [modelMenu, fileMenu, indicator] = await Promise.all([
  readFile("src/components/workspace/ConversationModelMenu.tsx", "utf8"),
  readFile("src/components/workspace/ConversationFileMenu.tsx", "utf8"),
  readFile("src/components/workspace/ContextUsageIndicator.tsx", "utf8"),
]);
assert.match(modelMenu, /aria-haspopup="menu"/);
assert.match(modelMenu, /推理强度/);
assert.match(modelMenu, /关闭/);
assert.match(fileMenu, /导入新文件/);
assert.match(fileMenu, /disabled=\{!selectable/);
assert.match(indicator, /role="status"/);
assert.match(indicator, /aria-label/);
assert.doesNotMatch([modelMenu, fileMenu, indicator].join("\n"), /invoke\(/);
```

- [ ] **Step 2: Run the static tests and verify failure**

Run: `node --test --experimental-strip-types tests/workspace-regressions.test.ts`

Expected: FAIL because the three component files do not exist.

- [ ] **Step 3: Implement the two-level model menu**

`ConversationModelMenu` is controlled by `selection` and `onSelection`. It owns only `open` and `submenu: "model" | "reasoning" | null`. First click opens the main panel; choosing a main row opens the right-hand submenu. Selecting an item closes both panels. Outside pointer and Escape close; focus returns to the trigger. Model entries are grouped by Provider and incomplete-context models render disabled with explanatory text. Reasoning options are the exact four values.

Expose this signature:

```ts
export function ConversationModelMenu(props: {
  providers: Provider[];
  selection: ChatModelSelection | null;
  disabled: boolean;
  saving: boolean;
  onSelection: (selection: ChatModelSelection) => Promise<void>;
}): JSX.Element;
```

- [ ] **Step 4: Implement the file menu**

Expose:

```ts
export function ConversationFileMenu(props: {
  files: ProjectFile[];
  selectedFileIds: string[];
  disabled: boolean;
  importing: boolean;
  onToggle: (fileId: string) => void;
  onImport: () => Promise<ProjectFile | null>;
}): JSX.Element;
```

The menu stays open while checkboxes change. The import action closes only the native picker portion; when it returns an available file, call `onToggle` if not already selected. Unsupported/failed files are disabled with status text.

- [ ] **Step 5: Implement the compact circular indicator**

`ContextUsageIndicator` receives `estimate`, `loading`, and `error`. Render a 26–28px circular button using `conic-gradient` and CSS custom property `--context-ratio`. Its status text and detail panel show estimated tokens/window. Ready is neutral/green, warning orange, blocked red. Tooltip behavior works on hover, focus, and click. Do not add a horizontal progress bar.

- [ ] **Step 6: Add component CSS and verify**

Add `.conversation-model-menu`, `.conversation-model-submenu`, `.conversation-file-menu`, `.conversation-attachment-chip`, `.context-usage-indicator`, and status modifier rules. Ensure right submenus flip inward at narrow widths and all controls retain visible focus.

Run:

```bash
node --test --experimental-strip-types tests/workspace-regressions.test.ts
npm run lint
npm run build
```

Expected: tests and build pass; no component imports Tauri APIs.

- [ ] **Step 7: Commit the control components**

```bash
git add src/components/workspace/ConversationModelMenu.tsx src/components/workspace/ConversationFileMenu.tsx src/components/workspace/ContextUsageIndicator.tsx src/styles/workspace.css tests/workspace-regressions.test.ts
git commit -m "feat(chat): add model file and context controls"
```

---

### Task 11: Integrate controls, estimates, sending, and history into the workspace

**Files:**
- Modify: `src/components/workspace/ConversationPane.tsx:1-90`
- Modify: `src/components/workspace/ProjectWorkspace.tsx:1-170`
- Modify: `src/App.tsx:1-1100`
- Modify: `src/styles/workspace.css`
- Modify: `tests/workspace-regressions.test.ts`

**Interfaces:**
- Consumes: all Task 8 APIs/helpers and Task 10 components.
- Produces: complete user-facing behavior and event refresh after each run.

- [ ] **Step 1: Add failing integration regressions**

Extend static tests to assert `ConversationPane` composes all three controls, renders attachment and execution metadata, and `App.sendMessage` uses the combined command:

```ts
const [conversationPane, appSource] = await Promise.all([
  readFile("src/components/workspace/ConversationPane.tsx", "utf8"),
  readFile("src/App.tsx", "utf8"),
]);
const sendStart = appSource.indexOf("async function sendMessage");
const sendEnd = appSource.indexOf("async function cancelAgent", sendStart);
const sendMessageSource = appSource.slice(sendStart, sendEnd);
assert.match(conversationPane, /ConversationModelMenu/);
assert.match(conversationPane, /ConversationFileMenu/);
assert.match(conversationPane, /ContextUsageIndicator/);
assert.match(conversationPane, /message\.attachments/);
assert.match(conversationPane, /message\.modelExecution/);
assert.match(appSource, /estimateAgentContext/);
assert.doesNotMatch(sendMessageSource, /appendMessage\(/);
assert.match(sendMessageSource, /startAgentRun\([^)]*content[^)]*selectedFileIds/s);
```

- [ ] **Step 2: Run regressions and verify failure**

Run: `node --test --experimental-strip-types tests/workspace-regressions.test.ts`

Expected: FAIL because the workspace has not wired the new state or components.

- [ ] **Step 3: Add controlled conversation state in App**

Add:

```ts
const [modelSelection, setModelSelection] = useState<ChatModelSelection | null>(null);
const [savingModelSelection, setSavingModelSelection] = useState(false);
const [contextEstimate, setContextEstimate] = useState<ContextEstimate | null>(null);
const [estimatingContext, setEstimatingContext] = useState(false);
const [contextEstimateError, setContextEstimateError] = useState<string | null>(null);
const contextEstimateScopeRef = useRef<string | null>(null);
```

When sessions load or selection changes, derive from the active session or `defaultModelSelection(providers)`. If there is no active session, retain the local default until first send. When an active session exists, `changeModelSelection` awaits `updateSessionModel` and updates the session row returned by Rust.

- [ ] **Step 4: Add scoped debounced context estimation**

Create an effect keyed by project, node, session, selection, draft, and selected IDs. Use a 250ms timer plus the existing request-scope pattern:

```ts
useEffect(() => {
  if (!project || !modelSelection || !messageDraft.trim()) {
    contextEstimateScopeRef.current = null;
    setContextEstimate(null);
    setContextEstimateError(null);
    return;
  }
  const scope = requestScope(
    project.id, nodeId, sessionId, modelSelection.providerId, modelSelection.model,
    modelSelection.reasoningEffort, messageDraft, ...selectedFileIds,
  );
  contextEstimateScopeRef.current = scope;
  const timer = window.setTimeout(() => {
    setEstimatingContext(true);
    void estimateAgentContext(
      project.id, nodeId, sessionId, modelSelection, messageDraft, selectedFileIds,
    ).then((estimate) => {
      if (contextEstimateScopeRef.current !== scope) return;
      setContextEstimate(estimate);
      setContextEstimateError(null);
    }).catch((error) => {
      if (contextEstimateScopeRef.current !== scope) return;
      setContextEstimate(null);
      setContextEstimateError(String(error));
    }).finally(() => {
      if (contextEstimateScopeRef.current === scope) setEstimatingContext(false);
    });
  }, 250);
  return () => window.clearTimeout(timer);
}, [project, nodeId, sessionId, modelSelection, messageDraft, selectedFileIds]);
```

An estimate error clears the estimate and disables send.

- [ ] **Step 5: Make imports return and select the new file**

Change the function signature and return points explicitly:

```ts
async function importFile(): Promise<ProjectFile | null> {
  if (!project) return null;
  const contextScope = project.id;
  const scope = requestScope(project.id, "import-file", crypto.randomUUID());
  fileImportScopeRef.current = scope;
  setImportingFile(true);
  try {
    const result = await importFileApi(project.id, now());
    if (!isLatestRequest(scope, fileImportScopeRef.current) || projectScopeRef.current !== contextScope) return null;
    if (!result.imported || !result.file) {
      setNotice("已取消文件选择，项目未改变");
      return null;
    }
    setFiles((current) => [...current, result.file!]);
    setNotice(result.file.extractionStatus === "available"
      ? `已导入并提取 ${result.file.originalName}`
      : `已导入 ${result.file.originalName}；该格式尚未提取文本`);
    return result.file;
  } catch (error) {
    if (isLatestRequest(scope, fileImportScopeRef.current) && projectScopeRef.current === contextScope) {
      setNotice(`导入文件失败：${String(error)}`);
    }
    return null;
  } finally {
    if (isLatestRequest(scope, fileImportScopeRef.current)) setImportingFile(false);
  }
}
```

Keep the existing notice, preview, `finally`, and stale-response branches; every cancelled, stale, or failed branch returns `null`. The file menu auto-selects the returned file only when `extractionStatus === "available"`. The right-side file-pool import path ignores the return value and does not force selection.

- [ ] **Step 6: Finalize combined send with session selection**

Keep the Task 8 combined send path and add selection handling:

```ts
if (!project || !modelSelection || !content || contextEstimate?.status === "blocked") return;
const active = sessionId
  ? sessions.find((item) => item.id === sessionId) ?? null
  : await createSessionApi(
      project.id,
      nodeId,
      `会话 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      now(),
      modelSelection,
    );
if (!active) return;
const run = await startAgentRun(
  project.id, nodeId, active.id, content, selectedFileIds, now(),
);
await loadMessages(project.id, nodeId, active.id);
setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
setMessageDraft("");
setSelectedFileIds([]);
```

React never constructs or appends the durable user ChatMessage. Only the success path clears the draft/files; `catch` preserves them. Existing token events may still render the transient Assistant stream; the finished event reloads durable messages so attachment and execution metadata appear.

- [ ] **Step 7: Compose the workspace controls and metadata**

Thread the new props through `ProjectWorkspace` into `ConversationPane`. Compose the toolbar in this structure:

```tsx
<div className="conversation-attachment-chips">
  {selectedFiles.map((file) => (
    <button key={file.id} type="button" onClick={() => onToggleFile(file.id)}>
      {file.originalName}<span aria-hidden="true">×</span>
    </button>
  ))}
</div>
<div className="conversation-composer-toolbar">
  <ConversationFileMenu
    files={files}
    selectedFileIds={selectedFileIds}
    disabled={!nodeAvailable || Boolean(activeRunId)}
    importing={importingFile}
    onToggle={onToggleFile}
    onImport={onImportFile}
  />
  <div className="conversation-composer-actions">
    <ContextUsageIndicator estimate={contextEstimate} loading={estimatingContext} error={contextEstimateError} />
    <ConversationModelMenu
      providers={providers}
      selection={modelSelection}
      disabled={!nodeAvailable || Boolean(activeRunId)}
      saving={savingModelSelection}
      onSelection={onModelSelection}
    />
    <Button variant={composerMode === "stop" ? "danger" : "primary"} disabled={sendDisabled} loading={composerMode === "sending"} type="submit">
      {composerMode === "stop" ? "停止" : "发送"}
    </Button>
  </div>
</div>
```

Disable send when selection is missing, selection save is in progress, estimate is missing/error/blocked, node is unavailable, or an active run exists.

For history, render user attachment names under the user bubble and `providerId · model · 推理：label` under completed Assistant content. Legacy messages with absent metadata render exactly as before.

- [ ] **Step 8: Verify frontend integration**

Run:

```bash
npm run test:ui
npm run lint
npm run build
```

Expected: all Node tests pass, TypeScript is clean, and Vite produces a production build.

- [ ] **Step 9: Commit workspace integration**

```bash
git add src/App.tsx src/components/workspace/ConversationPane.tsx src/components/workspace/ProjectWorkspace.tsx src/styles/workspace.css tests/workspace-regressions.test.ts
git commit -m "feat(workspace): wire conversation run controls"
```

---

### Task 12: Enforce boundaries, document behavior, and run full verification

**Files:**
- Modify: `scripts/verify-storage-contract.mjs:1-20`
- Modify: `README.md`
- Modify: `README.en.md`

**Interfaces:**
- Consumes: the completed feature.
- Produces: updated boundary enforcement, user documentation, and final verification evidence.

- [ ] **Step 1: Extend the storage-boundary scan**

Add these files to the explicit scan list:

```js
"src/components/workspace/ConversationPane.tsx",
"src/components/workspace/ConversationModelMenu.tsx",
"src/components/workspace/ConversationFileMenu.tsx",
"src-tauri/src/conversation_runtime.rs",
```

Run: `npm run test:storage-contract`

Expected: PASS with no project-level `.sion`, credential-store claims, or obsolete settings.

- [ ] **Step 2: Update README feature descriptions**

Document in both languages:

- one Provider can hold multiple manual models and a default;
- every usable model requires an input context window;
- model/reasoning are saved per session;
- files selected in the composer apply only to the next message;
- the compact circle is an estimate, warns at 80%, and blocks above 100%;
- no maximum output is configured;
- keys remain only in `~/.sion/providers.json` and file text stays behind Tauri.

Do not claim model discovery, exact provider tokenization, automatic truncation, or browser access.

- [ ] **Step 3: Run all automated verification**

Run:

```bash
npm run test:ui
npm run lint
npm run build
npm run test:no-browser-runtime
npm run test:no-legacy-migration-runtime
npm run test:storage-contract
npm run test:rust
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

Expected: every command exits 0. `test:no-browser-runtime` reports that no browser-search implementation exists; the storage verifier reports no contract violations.

- [ ] **Step 4: Perform Tauri desktop QA**

Run: `npm run tauri dev`

Verify this exact sequence:

1. Open Settings and edit one Provider to contain three models with unique context windows and one default.
2. Confirm duplicate names, zero/blank context, and deleting the final model are rejected inline.
3. Open a project/node, create two sessions, and give each a different model/reasoning choice; switch sessions and restart to confirm restoration.
4. Confirm the first menu click shows only `模型 / 推理强度`, then the selected submenu opens to the right.
5. Select two files, remove one chip, import a new readable file, and confirm it becomes selected.
6. Trigger a validation failure and confirm draft/chips remain; send successfully and confirm chips clear.
7. Confirm the user history shows file names and Assistant history shows the actual Provider/model/reasoning.
8. Exercise ready, warning, and blocked circular context states; confirm there is no horizontal bar.
9. Choose non-`off` reasoning on an unsupported endpoint and confirm the failure recommends `关闭`.
10. Delete the model referenced by a session and confirm Sion requires a new choice instead of silently falling back.
11. Queue a run, change the session selection, and confirm the saved run retains its original model/reasoning/file IDs.

- [ ] **Step 5: Commit boundaries and documentation**

```bash
git add scripts/verify-storage-contract.mjs README.md README.en.md
git commit -m "docs: describe conversation model controls"
```

---

## Final Review Checklist

- [ ] Every design requirement maps to a task above.
- [ ] Old Provider, session, message, and run JSON fixtures remain readable without bulk migration.
- [ ] No request includes a maximum-output field.
- [ ] No model has a `supportsReasoning` field.
- [ ] Context estimation and the real run use the same assembled prompt.
- [ ] Validation errors do not persist a user message or run.
- [ ] Successful persistence clears only one-message files, not the session model selection.
- [ ] API keys, full file text, prompt bodies, and endpoints do not cross list/estimate IPC responses.
- [ ] Existing user changes in `src/App.tsx` and `crates/sion-core/src/lib.rs` were merged rather than overwritten.
