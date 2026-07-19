# Export Center UX Hardening Design

**Date:** 2026-07-19  
**Status:** Approved for planning  
**Branch context:** `feat/export-center-redesign` follow-up  
**Related:** `docs/superpowers/plans/2026-07-19-export-center-redesign.md`, export center redesign implementation

## Goal

Harden Export Center usability and reliability in one delivery:

1. **Layout A** — Replace the three stacked model `<select>` controls with the conversation-center model menu style; move the full review ledger into the bottom bar where those selects lived; remove the right review column so preview is two-column.
2. **Independent project selection** — The export project dropdown must stick to the user’s choice and must not be overridden by the workbench active project.
3. **Crash on acknowledge** — Clicking “仍按当前已批准内容继续” after incomplete/stale warnings must start generation safely (or return a typed error), never crash the desktop process.

Out of scope: extracting a shared model menu package for the whole app, cloud export, review chat UI, redesign of blueprint strip or artifact navigator beyond layout reflow, and manual acceptance of Word fidelity.

## Constraints

- Rust remains the only owner of export state, model runs, and project files. React holds view state only.
- API keys stay in `~/.sion/providers.json` only; never in export state, events, or IPC.
- Advisory source/incomplete warnings never revoke approvals.
- Markdown and DOCX preview safety rules from the redesign design remain in force.
- Prefer reusing `ConversationModelMenu` over a new model-picker abstraction for this change.
- No unrelated workbench refactor.

## Approach

**Minimal rewiring + local UI move (chosen):**

- Reuse `ConversationModelMenu` inside the export bottom bar.
- Relocate `ReviewLedger` into the bottom bar; drop the right `aside`.
- Fix export project resolution so explicit selection wins.
- Harden the first real generation path after acknowledge so panics become `ExportCommandError`.

Rejected alternatives: app-wide model menu extraction (too much blast radius); bugs-only release (does not meet layout request).

---

## 1. Layout structure

### Page skeleton

```
┌─ Export Center header ─────────────────────────┐
│  Title                 Project select            │
├─ Blueprint preparation bar ────────────────────┤
├─ Warning confirm strip (when needed) ──────────┤
├─ Workbench (two columns, no review aside) ─────┤
│  ┌ Navigator ┐  ┌ Preview / candidate / editor ┐ │
│  └───────────┘  └──────────────────────────────┘ │
├─ Sticky bottom bar ────────────────────────────┤
│  [Model menu]  [Review ledger]  [Primary/Cancel] │
└────────────────────────────────────────────────┘
```

### Bottom bar regions

| Region | Content |
|--------|---------|
| **Left** | `ConversationModelMenu`. Persist via `saveExportModelSelection`. Disable while run in progress or busy. |
| **Center** | Full current `ReviewLedger`: instruction textarea, “生成修改建议”, task cards with selectable diffs, apply, stale hints. Max height with internal scroll. Enabled for blueprint / formal draft selection; short read-only hint for other artifacts. |
| **Right** | Public run summary, primary action button, Cancel when run is queued/running. Same action semantics as today’s `ExportActionBar`. |

### Remove / keep

- **Remove:** right `aside.export-review`; three bottom `SelectField`s (provider, model, reasoning).
- **Keep:** blueprint bar, navigator, preview/edit/candidate diff, warning confirm strip, formal Word “另存为” on preview toolbar.

### Responsive

- Desktop: bottom grid `auto | minmax(0, 1fr) | auto`.
- ≤1100px: bottom stacks model → primary → review.
- ≤760px: existing export workbench stacking (navigator horizontal scroller, panes stack).

### Components

- Prefer extending `ExportActionBar` (or a thin `ExportBottomBar` wrapper) to host model menu + embedded `ReviewLedger` + primary actions.
- Style overrides under export CSS only; do not change conversation pane defaults.

---

## 2. Project selection semantics

### Resolution order (export page only)

1. User-selected `exportProjectId` if still in the project list (highest).
2. Else workbench `activeProjectId` if in the list (entry default only).
3. Else most recently opened project.
4. Else `null` (empty state).

Prefill `exportProjectId` once when entering exports while it is empty (using 2/3). After the user picks a project in the export dropdown, that choice wins until they change it or the project disappears from the list.

### Forbidden side effect

Do not run an effect that writes `onSelectProject(resolvedProjectId)` on every resolve. That pattern re-pushes workbench priority and cancels dropdown changes.

Correct behavior:

- Dropdown `onChange` → `setExportProjectId(id)` only.
- Prefill only when entering exports with empty memory.
- Never continuously mirror resolve → state.

### App vs ExportCenter

| Layer | Responsibility |
|-------|----------------|
| **App** | Owns `exportProjectId`. Keys `exportRefreshByProject` by the **resolved export project id**. Scoped invalidation events unchanged. |
| **ExportCenter** | Resolves with export-page rules; dropdown value is resolved id; change notifies parent. |

Workbench project open does not force-overwrite a remembered export selection.

### Tests

Update pure selector tests so remembered/export selection beats active when both are set; cover fallback when remembered id is missing from the list.

---

## 3. Acknowledge path crash hardening

### Observed path

1. Generate blueprint → advisory incomplete/stale → confirm strip (no run started).
2. “仍按当前已批准内容继续” → `acknowledgeSourceWarnings: true` → first real `export_action_start` / `start_export_model_run`.
3. Process exit → treat as native panic or uncaught fatal, not a normal validation error.

### Goals

- After acknowledge: run starts, or a typed error surfaces; **never process crash**.
- Errors map to `ExportCommandOutcome::Error` / UI notice.
- Advisory semantics unchanged: incomplete/stale may continue; approvals are not revoked.

### Investigation order (implementation)

1. Reproduce with the same post-confirm request; capture panic stack.
2. Audit `export_action_start`, `start_export_model_run`, `spawn_export_model_run` for `expect`/`unwrap`/`state` panics; convert to `Result` / safe handling.
3. Verify AgentState, scheduler enqueue, `save_run`, `set_export_active_run`, and event emit with no prior run and with leftover run state.
4. Verify snapshot serialization with `active_run` and frontend render.
5. Provider/stream failures mark run Failed, invalidate workspace, notice UI; no process abort.

### Frontend confirm flow

- Warnings present → `pendingAction` + confirm strip.
- Confirm → `executeExportAction(pendingAction, true)`.
- On failure: notice, clear busy, clear `pendingAction` so the user is not stuck on the strip.
- On success: apply snapshot, clear `pendingAction`.
- Disable primary and confirm while `busy` to avoid double enqueue.

### Backend contract

- `acknowledge_source_warnings == false` with advisories → `ValidationFailed` (expected).
- `true` → skip that gate and continue generation.
- Later failures (no model, run busy, provider, invalid delivery) → stable error kinds; no panics.

### Tests

- Integration/unit: acknowledge + incomplete nodes does not panic; returns Success (run created) or explicit Error.
- UI regression: confirm path sends `acknowledgeSourceWarnings`.
- Prefer converting scheduler/export mutex `expect` sites on this path to testable errors where practical.

---

## Data flow (summary)

```
User selects export project
  → exportProjectId (App)
  → ExportCenter resolve (export-page rules)
  → getExportWorkspace / mutations scoped to that id

User picks model (ConversationModelMenu)
  → saveExportModelSelection → snapshot.modelSelection

User confirms source warnings
  → export_action_start(..., acknowledgeSourceWarnings: true)
  → start_export_model_run (no panic) → active_run on snapshot
  → events refresh token for that projectId only
```

## Error handling

| Case | Behavior |
|------|----------|
| Incomplete/stale without acknowledge | ValidationFailed + confirm strip |
| Generation panic (today’s bug) | Must become typed error or successful enqueue |
| Provider failure mid-run | Run Failed, workspace invalidated, notice |
| Project list loses selected id | Fall back to active / recent |
| Model missing when required | Primary disabled / ValidationFailed |

## Testing plan

- `export-state` unit tests for independent project priority.
- Tauri/export runtime: acknowledge start path; active_run still present after start.
- Workspace regressions: bottom bar hosts review + model menu patterns; no right review aside requirement; project switch not forced by active-only resolve.
- Manual: switch export project while workbench has another project; generate with incomplete nodes → confirm → run progresses or shows error without crash; review from bottom bar on blueprint/draft.

## Success criteria

1. Export center bottom bar matches conversation model menu interaction; review ledger lives in the bottom center; no right review column.
2. Changing the export project dropdown always changes the loaded workspace while the chosen project remains listed.
3. “仍按当前已批准内容继续” never crashes the app; generation starts or a clear notice appears.
4. Existing export invariants (CAS, safe preview, no secrets in export paths) remain intact.

## Implementation note

After this spec is approved, produce a task-level plan under `docs/superpowers/plans/` and implement on the current feature branch (or a short follow-up branch off it). Fix the crash early in the plan so UI work can be verified end-to-end.
