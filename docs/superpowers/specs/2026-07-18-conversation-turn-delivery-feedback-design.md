# Conversation Turn, Delivery Update, and Feedback Design

Date: 2026-07-18

## Summary

Restore the useful behavior of the former Next.js workbench while preserving the local-first Tauri architecture:

- Agent progress, completion, cancellation, delivery decisions, and delivery errors appear inside the relevant conversation turn.
- Application-level notices move from the bottom-right to the top-right.
- Every completed Agent turn explicitly decides whether the current node delivery needs a validated section patch.
- A valid patch is applied automatically with revision protection; an unchanged turn does not write the node.
- The delivery workspace removes DOCX export and adds a full-delivery regeneration action.
- DOCX export remains available only in Export Center.

The selected UI is one expandable activity card per user turn. It updates while the turn runs, collapses when complete, persists its public processing summary, and remains expandable after an application restart.

## Context and Current Problems

The desktop workbench currently routes many unrelated outcomes through one global `NoticeMessage`. In particular, `agent-run-finished` produces a global notice even though it belongs to the conversation that started the run. This moves conversational feedback out of its context and makes completed, failed, or cancelled runs difficult to understand later.

The current runtime prompt also requires every assistant reply to contain a `delivery` block. It does not provide an explicit no-change decision. The UI then exposes a generic “预览修改” action for every completed assistant reply rather than letting the Agent decide whether the delivery should change.

Finally, `DeliveryWorkspace` places “导出 DOCX” in its footer even though the application has a dedicated Export Center. The former Next.js workbench instead treated this location as the entry point for regenerating the current node delivery.

## Goals

1. Keep all turn-specific status and results in the conversation.
2. Persist a safe, public processing summary without exposing hidden chain-of-thought.
3. Make delivery updates an explicit `unchanged` or validated `patch` decision.
4. Apply valid patches automatically without overwriting manual edits or newer revisions.
5. Support safe, full regeneration of the current node delivery from the delivery workspace.
6. Reserve global notices for application-level operations and place them at the top-right.
7. Preserve compatibility with projects and sessions created before this feature.

## Non-goals

- Exposing raw provider chain-of-thought or internal hidden reasoning.
- Adding browser access, browser automation, or web egress.
- Automatically updating other workflow nodes.
- Automatically merging a patch into an unsaved local editor draft.
- Moving formal multi-node document generation out of Export Center.
- Migrating or rewriting old conversation history eagerly.

## Chosen Approach

Introduce a structured conversation-turn record. A turn groups the user message, the assistant reply, public activity steps, optional provider reasoning summary, the delivery decision, and the final revision outcome.

The Rust runtime is the source of truth for turn and delivery state. It emits structured events during execution and persists the completed turn summary. React merges those events for live rendering but does not infer whether a delivery was updated from text or notice strings.

This is preferred over reusing the existing coarse `AgentRun` record or storing every status as a system message. The turn record provides a stable boundary for live UI, persistence, restart recovery, and future extensions without polluting the conversational transcript.

## Domain Model

The exact Rust and TypeScript names may follow existing repository conventions, but the semantic model is fixed:

```text
ConversationTurn
  id
  project_id
  node_id
  session_id
  run_id
  user_message_id
  assistant_message_id?
  status: queued | running | completed | failed | cancelled
  activities[]
  reasoning_summary?
  delivery_outcome
  started_at
  finished_at?

TurnActivity
  id
  kind: response | delivery_check | delivery_validate | delivery_save
  status: pending | running | completed | failed | skipped
  label
  public_summary?
  started_at?
  finished_at?

DeliveryOutcome
  pending
  unchanged
  patch_applied { previous_revision, revision, section_titles[] }
  awaiting_manual_draft_resolution { expected_revision }
  conflict { expected_revision, actual_revision }
  failed { stage, public_error }
  cancelled
```

`reasoning_summary` contains only a provider-supplied reasoning summary or a concise public execution summary produced for the user. Raw hidden reasoning tokens are neither requested for persistence nor stored.

## Persistence and Compatibility

Turn records are stored inside the existing UUID project directory and scoped to the current node session. Writes remain atomic. A turn summary must never include API keys, raw provider request headers, hidden reasoning, file-system secrets, or unsanitized internal errors.

The runtime persists the turn shell with `queued` or `running` status before model execution begins. Intermediate activity snapshots may be coalesced to avoid excessive disk writes, but the final completed, failed, or cancelled snapshot must be persisted before the terminal event is emitted. If the application closes during an unfinished run, recovery changes the persisted running turn to `interrupted` instead of presenting it as complete.

Existing sessions without turn records continue to render their current `ChatMessage` list. New structured turns coexist with old messages; no eager migration is required. The renderer must not duplicate a message when it is referenced by a structured turn.

## Runtime Event Contract

The desktop event stream gains structured turn events rather than encoding state in notice strings. Events include enough identity to reject stale events after project, node, or session navigation.

Representative events are:

```text
turn_started
turn_activity_updated
turn_reasoning_summary_updated
turn_assistant_delta
turn_delivery_decided
turn_delivery_applied
turn_failed
turn_cancelled
turn_finished
```

Every event carries `projectId`, `nodeId`, `sessionId`, `turnId`, and `runId`. Delivery events also carry the expected and resulting revisions when applicable.

The existing assistant content stream may remain separate if that follows the current `sion-agent` implementation more cleanly. The important boundary is that React receives structured activity and delivery events and never derives state by parsing assistant text.

## Agent Reply and Automatic Delivery Decision

The prompt contract changes from “every response must contain a delivery patch” to an explicit decision:

- `unchanged`: the conversation produced no effective change for the current node delivery.
- `patch`: one or more existing second-level sections require replacement content.

The assistant still returns a normal conversational reply. The delivery decision is structured and machine-validated. It is not shown as raw fenced JSON in the visible answer.

A patch must satisfy all current `sion-core` delivery constraints:

- Every target title exactly matches a supported existing second-level section for the current node.
- Each target appears once.
- Content is non-empty and contains no first- or second-level headings.
- Applying the patch preserves every required section and valid document structure.

If the decision is `unchanged`, the node is not saved and its revision does not increase.

If the decision is a valid patch and the editor has no unsaved manual changes, the runtime applies it with the node revision captured for the turn. The save remains atomic and revision-protected.

If the user has an unsaved editor draft, the automatic patch is not merged into or written over that draft. The turn persists an `awaiting_manual_draft_resolution` outcome and the activity card asks the user to save or discard the manual draft. After the draft is resolved, the card exposes “重新判断交付稿”. That action reruns only the structured delivery decision against the latest saved Markdown and revision; it does not regenerate or duplicate the conversational reply and it never reuses an unvalidated stale patch.

If the disk revision changed, the patch does not silently overwrite or repeatedly replay against new content. The latest node remains authoritative and the activity card records a conflict.

## Conversation UI

Each new user message starts one activity card directly after that message. The card updates in place through the following visible phases:

1. Agent is responding.
2. Agent is deciding whether the delivery needs an update.
3. The proposed patch is being validated, or the turn is confirmed unchanged.
4. The patch is being saved, skipped, blocked, or rejected.

While running, the card is expanded enough to show the active step and provides the existing stop action. When the turn reaches a terminal state, it collapses to a compact summary. Clicking it reveals:

- Public activity steps and their terminal states.
- The safe reasoning or execution summary.
- Elapsed time when available.
- Delivery result.
- Changed section titles and before/after revision for an applied patch.
- Sanitized failure, cancellation, or conflict information.

The assistant reply and delivery outcome remain visibly part of the same turn. Typical terminal labels are:

- “交付稿已更新 · revision 8”
- “已判断，无需更新交付稿”
- “回复已完成，交付稿更新失败”
- “交付稿版本已变化，本次未覆盖”
- “已取消，未保存未完成内容”

Conversation-specific success, warning, and error outcomes do not create global notices.

## Global Notices

The notice viewport moves from the bottom-right to the top-right. Global notices are reserved for application-level actions that are not naturally owned by one conversation turn, including:

- Project creation and project-directory changes.
- Provider and application settings saves.
- File import or file-management results outside a conversation turn.
- Manual node saves and navigation conflicts.
- DOCX export selection, success, cancellation, and failure.

Successful notices dismiss automatically. Errors and warnings requiring action remain dismissible. Loading data for a view should prefer local loading or error states when the relevant component already has a place to show them.

## Delivery Workspace and Full Regeneration

`DeliveryWorkspace` removes its DOCX export action. Export Center remains the only DOCX export entry point.

The footer adds “重新生成交付稿”. It uses:

- The current node and its embedded plus project-specific Agent rules.
- The current active conversation and its persisted history.
- Files selected for that conversation context.
- The current conversation model and reasoning-effort selection.
- The current saved node Markdown and revision.

Regeneration is an explicit full rewrite, not a section patch. It streams into a separate candidate buffer so the saved delivery remains intact throughout generation. The candidate must contain all required sections in the required structure and must pass the same domain validation used by other delivery writes.

Only a complete, valid candidate may be saved. The final save uses the revision captured when regeneration started. On success, the new node becomes both the saved baseline and editor value. On cancellation, model failure, validation failure, an unsaved manual draft, or revision conflict, the previous saved delivery remains unchanged.

Regeneration status appears immediately above the delivery footer as an expandable local status panel. It is not inserted as a fabricated user conversation turn and does not create a global notice.

## Cancellation and Failure Handling

- Cancelling before assistant completion does not persist a truncated assistant message or partial patch as a successful result.
- A conversational reply may succeed even if the subsequent delivery decision or save fails. The reply remains in history and the card clearly distinguishes the delivery failure.
- Validation errors contain user-safe summaries and do not expose raw provider responses or internal paths.
- A cancelled or failed full regeneration never replaces the saved node.
- Stale events from another project, node, session, turn, or run are ignored by the UI.
- Terminal turn state is persisted before the final UI event so restart recovery cannot show a false running state after a known completion.

## Component Boundaries

Focused changes should remain within existing architectural ownership:

- `crates/sion-core`: turn and delivery outcome types plus delivery-decision validation.
- `crates/sion-storage`: atomic turn persistence and backward-compatible session reads.
- `crates/sion-agent`: public progress/reasoning-summary events and cancellation semantics.
- `src-tauri`: prompt assembly, orchestration, CAS application, event emission, and full-regeneration commands.
- `src/App.tsx`: request scoping, live turn reducer integration, and notice classification.
- `src/components/workspace/ConversationPane.tsx`: turn grouping and expandable activity cards.
- `src/components/workspace/DeliveryWorkspace.tsx`: regeneration action and local generation status.
- `src/components/app/AppShell.tsx` and shell styles: top-right notice viewport.
- `src/components/app/ExportCenter.tsx`: sole DOCX export entry point, retaining current export behavior.

No unrelated workbench refactor is part of this feature.

## Testing Strategy

### Domain tests

- `unchanged` performs no write.
- Valid single- and multi-section patches apply correctly.
- Unknown, duplicate, empty, or structurally invalid patch sections fail.
- Full rewrites preserve required headings and reject incomplete output.

### Storage tests

- Completed, failed, cancelled, conflict, and unchanged turn records round-trip.
- Old sessions without turn records remain readable.
- Turn writes and node writes remain inside the direct UUID project directory.
- CAS conflicts preserve the newer node.
- Interrupted runs recover as interrupted rather than completed.

### Runtime tests

- Turn event order is stable for unchanged, applied, failed, cancelled, and conflict paths.
- Conversation success followed by delivery failure keeps the assistant reply.
- No hidden reasoning or secrets enter persisted summaries or IPC events.
- Cancellation leaves no successful partial assistant message or node patch.
- Full regeneration saves only after complete generation and validation.

### React tests

- The activity card appears beside the correct user turn and updates in place.
- Completed cards collapse and can be expanded.
- Persisted cards render after reload without duplicating referenced messages.
- Applied, unchanged, failed, cancelled, waiting, and conflict outcomes use the correct copy.
- Conversation outcomes do not call the global notice path.
- The notice viewport is top-right.
- Delivery workspace has regeneration but no DOCX export.
- Export Center still exports DOCX and displays its local progress/result.

### Verification commands

Run the repository-standard checks before completion:

```bash
npm run lint
npm run build
npm run test:rust
cargo test --workspace
```

Run focused frontend and Rust tests during implementation before the full suite.

## Acceptance Criteria

1. Agent running, completion, cancellation, delivery decision, delivery save, and delivery errors appear in the relevant conversation turn, not as global notices.
2. Each turn has one activity card that updates live, collapses on completion, and remains expandable after restart.
3. Expanded cards show public execution steps and safe reasoning summaries but never hidden chain-of-thought.
4. A turn can explicitly decide `unchanged`; this leaves Markdown and node revision unchanged.
5. A valid section patch is applied automatically when there is no unsaved manual draft and the expected revision still matches.
6. Unsaved drafts and revision conflicts are never silently overwritten.
7. A successful assistant reply remains available when delivery processing fails.
8. Global application notices render at the top-right and retain appropriate dismissal behavior.
9. Delivery workspace contains “重新生成交付稿” and does not contain DOCX export.
10. Full regeneration uses the current node rules, conversation, selected files, and model; only a complete validated candidate may replace the saved delivery.
11. Export Center remains the only DOCX export entry point and continues to report export progress and results.
12. Existing projects and sessions remain readable without an eager migration.
13. Repository lint, build, frontend tests, and Rust tests pass.
