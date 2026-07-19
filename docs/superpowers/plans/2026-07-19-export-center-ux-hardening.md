# Export Center UX Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Export Center project switching independent, move review + conversation-style model menu into the bottom bar (layout A), and stop the app from crashing when the user acknowledges incomplete/stale source warnings and starts generation.

**Architecture:** Keep Rust as the only export-state and model-run owner. Harden the acknowledge → `export_action_start` → `start_export_model_run` path so panics become typed `ExportCommandError`. Fix pure project-id resolution so remembered export selection wins over the workbench active project, and remove the ExportCenter effect that rewrites selection. Rebuild the sticky bottom bar to host `ConversationModelMenu`, the full `ReviewLedger`, and primary actions; drop the right review column and three model selects.

**Tech Stack:** Tauri 2, React 19, TypeScript 5.9, existing `ConversationModelMenu`, sion-agent `RunScheduler`, Node test runner, cargo test/clippy.

## Global Constraints

- New project data is written only to `<projects directory>/<project id>/`.
- API keys remain only in `~/.sion/providers.json`; never in export state, events, or IPC.
- Advisory incomplete/stale warnings never revoke approvals.
- Prefer reusing `ConversationModelMenu`; do not extract a new shared model package.
- Markdown/DOCX preview safety rules from the export redesign remain in force.
- The Tauri crate is excluded from the root workspace; run root and `src-tauri` verification separately.
- No unrelated workbench refactor.
- Spec: `docs/superpowers/specs/2026-07-19-export-center-ux-hardening-design.md`.

---

## File Structure

### Modify

- `src-tauri/src/export_runtime.rs` — panic-safe export run start; keep `active_run` resolution.
- `src/export-state.ts` — export project resolve: remembered/export selection first.
- `tests/export-state.test.ts` — priority tests for independent selection.
- `src/App.tsx` — resolve export project with new order; refresh token keyed the same way.
- `src/components/app/ExportCenter.tsx` — drop resolve→onSelect writeback; wire bottom bar; two-column workbench.
- `src/components/export/ExportActionBar.tsx` — model menu + review region + primary actions.
- `src/styles/export.css` — two-column workbench; bottom bar grid; review scroll; model popover in bar.
- `tests/workspace-regressions.test.ts` — layout A, independent selection, acknowledge path markers.

### Do not create

- No new domain crates or IPC commands unless crash investigation proves a missing command is required (it should not).

---

### Task 1: Harden acknowledge → generation (stop crash)

**Files:**
- Modify: `src-tauri/src/export_runtime.rs`
- Test: same file `#[cfg(test)]` module

**Interfaces:**
- Consumes: `export_action_start`, `start_export_model_run`, `AgentState`, `RunScheduler::enqueue`
- Produces: generation start that returns `ExportCommandOutcome` Success or Error without process abort; panics on this path eliminated or converted

- [ ] **Step 1: Reproduce and capture the failure mode**

Run the desktop app if available, or add a focused unit test that exercises the first real start after acknowledge:

```bash
cargo test --manifest-path src-tauri/Cargo.toml export_action_start_with_acknowledge -- --nocapture
```

Expected initially: FAIL (test missing) or, if you can run the app, crash when confirming incomplete nodes.

If you can only unit-test, write the failing test in Step 2 first.

- [ ] **Step 2: Add a failing test that acknowledge + incomplete nodes must not panic**

In `src-tauri/src/export_runtime.rs` tests, add a helper store with default nodes (many `NotStarted`) and call the pure advisory + start pieces that do not need a live provider. Minimum bar:

```rust
#[test]
fn acknowledge_true_skips_advisory_gate_and_enqueue_does_not_panic() {
    let (root, store) = store();
    let nodes = nodes(&store);
    let state = store.export_workspace().unwrap();
    let warnings = advisory_export_warnings(&state, &nodes);
    assert!(
        !warnings.is_empty(),
        "default nodes should produce incomplete advisories"
    );
    // Gate logic: acknowledge true means we do not return ValidationFailed for warnings.
    // Enqueue path uses a local scheduler only — no Tauri AppHandle required for this unit.
    let mut scheduler = sion_agent::RunScheduler::new(2);
    let run = scheduler
        .enqueue(sion_agent::RunRequest {
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::FinalExport,
            provider_id: "provider-1".into(),
            model: "model-1".into(),
            reasoning_effort: sion_core::ReasoningEffort::Medium,
            file_ids: vec![],
            kind: AgentRunKind::ExportBlueprint,
            created_at: "2026-07-19T00:00:00Z".into(),
            session_id: None,
            turn_id: None,
            context_snapshot: None,
        })
        .expect("export enqueue must succeed");
    store.save_run(&run).unwrap();
    store
        .set_export_active_run(Some(&run.id), "2026-07-19T00:00:00Z".into())
        .unwrap();
    let snapshot = export_workspace_snapshot(&store, &nodes).unwrap();
    assert_eq!(
        snapshot.active_run.as_ref().map(|r| r.run_id.as_str()),
        Some(run.id.as_str())
    );
    let _ = std::fs::remove_dir_all(&root);
}
```

If `ReasoningEffort` path differs in this crate, match the existing agent test style in `crates/sion-agent/src/lib.rs` `export_request`.

- [ ] **Step 3: Run the new test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml acknowledge_true_skips_advisory -- --nocapture
```

Expected: PASS for this unit test once helpers compile. If it fails on missing imports, fix imports only.

- [ ] **Step 4: Remove panics on the live start path**

In `start_export_model_run` and cancel/finish helpers that use:

```rust
state.scheduler.lock().expect("scheduler mutex");
state.export_jobs.lock().expect("export jobs mutex");
```

Replace with poison-safe mapping to `ExportCommandError::IoFailed` (or log + clear) so a poisoned mutex cannot abort the process:

```rust
let mut scheduler = state.scheduler.lock().map_err(|_| ExportCommandError {
    kind: ExportCommandErrorKind::IoFailed,
    message: "export scheduler lock poisoned".into(),
    latest_revision: None,
    latest_digest: None,
})?;
```

Audit `spawn_export_model_run` the same way for `expect` on locks. Keep `app.state::<AgentState>()` only where AgentState is always managed at startup; if any path can run without state, return `IoFailed` instead of panicking (Tauri `state()` panics when missing — document that AgentState registration in `lib.rs` is required and already present).

Also ensure `export_action_start` never panics after `acknowledge_source_warnings: true`: every branch returns `Ok(VersionedResponse { payload: outcome(...) })`.

- [ ] **Step 5: Frontend confirm failure hygiene (paired with crash fix)**

In `src/components/app/ExportCenter.tsx` `executeExportAction` catch path:

```typescript
.catch((failure: unknown) => {
  onNotice(`操作失败：${String(failure)}`);
  setPendingAction(null);
})
```

Disable confirm button while `busy` (already required by design).

- [ ] **Step 6: Run Rust export tests and clippy**

```bash
cargo test --manifest-path src-tauri/Cargo.toml export_
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/export_runtime.rs src/components/app/ExportCenter.tsx
git commit -m "fix(export): harden acknowledge generation path"
```

---

### Task 2: Independent export project selection

**Files:**
- Modify: `src/export-state.ts`
- Modify: `tests/export-state.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/app/ExportCenter.tsx`

**Interfaces:**
- Produces: `resolveExportProjectId(projects, activeProjectId, rememberedProjectId)` with **remembered first**, then active, then most recent
- Produces: ExportCenter no longer calls `onSelectProject(resolved)` on every resolve

- [ ] **Step 1: Write failing priority tests**

Replace the existing default-project test expectations in `tests/export-state.test.ts`:

```typescript
test("defaults export project to remembered then active then most recent", () => {
  const projects = [
    { id: "old", name: "Old", rootPath: "/old", openedAt: "2026-07-18T00:00:00Z" },
    { id: "new", name: "New", rootPath: "/new", openedAt: "2026-07-19T00:00:00Z" },
  ];
  // Explicit export selection wins over workbench active project
  assert.equal(resolveExportProjectId(projects, "old", "new"), "new");
  assert.equal(resolveExportProjectId(projects, "old", "old"), "old");
  // No memory → active
  assert.equal(resolveExportProjectId(projects, "old", null), "old");
  // No memory, no active → most recent openedAt
  assert.equal(resolveExportProjectId(projects, null, null), "new");
  // Stale memory falls back to active
  assert.equal(resolveExportProjectId(projects, "old", "missing"), "old");
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --test --experimental-strip-types tests/export-state.test.ts
```

Expected: FAIL on remembered-over-active assertion.

- [ ] **Step 3: Implement new resolve order**

In `src/export-state.ts`:

```typescript
/**
 * Resolves the export project id with export-selection-first, then workbench
 * active, then most-recent. Returns null only when there are no projects.
 */
export const resolveExportProjectId = (
  projects: RecentProject[],
  activeProjectId: string | null,
  rememberedProjectId: string | null,
): string | null => {
  if (rememberedProjectId && projects.some((project) => project.id === rememberedProjectId)) {
    return rememberedProjectId;
  }
  if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
    return activeProjectId;
  }
  const sorted = [...projects].sort((left, right) =>
    (right.openedAt ?? "").localeCompare(left.openedAt ?? ""),
  );
  return sorted[0]?.id ?? null;
};
```

- [ ] **Step 4: Remove ExportCenter writeback effect**

Delete this block from `ExportCenter.tsx`:

```typescript
useEffect(() => {
  onSelectProject(resolvedProjectId);
}, [resolvedProjectId, onSelectProject]);
```

Keep dropdown:

```tsx
onChange={(event) => onSelectProject(event.target.value || null)}
```

- [ ] **Step 5: Prefill once in App when entering exports**

In `src/App.tsx`, when rendering the exports destination (or in a small effect keyed on `destination === "exports"`), if `exportProjectId` is null and projects exist, set it from resolve:

```typescript
useEffect(() => {
  if (destination !== "exports") return;
  if (exportProjectId && projects.some((item) => item.id === exportProjectId)) return;
  const next = resolveExportProjectId(projects, project?.id ?? null, exportProjectId);
  if (next && next !== exportProjectId) {
    setExportProjectId(next);
  }
}, [destination, projects, project?.id, exportProjectId]);
```

Keep refresh token keyed with the same resolve:

```typescript
const resolvedExportProjectId = resolveExportProjectId(
  projects,
  project?.id ?? null,
  exportProjectId,
);
```

- [ ] **Step 6: Run unit + lint**

```bash
node --test --experimental-strip-types tests/export-state.test.ts
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/export-state.ts tests/export-state.test.ts src/App.tsx src/components/app/ExportCenter.tsx
git commit -m "fix(export): keep export project selection independent"
```

---

### Task 3: Bottom bar — model menu + review ledger (layout A)

**Files:**
- Modify: `src/components/export/ExportActionBar.tsx`
- Modify: `src/components/app/ExportCenter.tsx`
- Modify: `src/styles/export.css`
- Modify: `tests/workspace-regressions.test.ts`

**Interfaces:**
- Consumes: `ConversationModelMenu` from `src/components/workspace/ConversationModelMenu.tsx`
- Consumes: `ReviewLedger` props unchanged
- Produces: bottom bar with left model, center review, right primary; workbench without right aside

- [ ] **Step 1: Add failing structural regressions**

In `tests/workspace-regressions.test.ts`, extend the export layout test:

```typescript
test("export center uses bottom model menu and review without right aside", async () => {
  const [center, action, css] = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/components/export/ExportActionBar.tsx", "utf8"),
    readFile("src/styles/export.css", "utf8"),
  ]);
  assert.match(action, /ConversationModelMenu/);
  assert.match(action, /ReviewLedger/);
  assert.doesNotMatch(action, /SelectField/);
  assert.doesNotMatch(center, /aside className="export-review"/);
  assert.match(center, /ExportActionBar/);
  assert.match(css, /export-action-bar/);
  assert.match(css, /export-action-review/);
});
```

- [ ] **Step 2: Run regression — expect FAIL**

```bash
node --test --experimental-strip-types --test-name-pattern="bottom model menu" tests/workspace-regressions.test.ts
```

Expected: FAIL (ConversationModelMenu not in ExportActionBar yet).

- [ ] **Step 3: Rewrite ExportActionBar**

Replace three `SelectField`s with `ConversationModelMenu` and accept review slot props:

```tsx
import { ConversationModelMenu } from "../workspace/ConversationModelMenu";
import { ReviewLedger } from "./ReviewLedger";
import type { ExportReviewTask } from "../../types";

export type ExportActionBarProps = {
  providers: Provider[];
  modelSelection: ChatModelSelection | null;
  onModelChange: (selection: ChatModelSelection) => Promise<void> | void;
  savingModel?: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled: boolean;
  activeRun: ExportRunSummary | null;
  onCancel: () => void;
  requiresModel: boolean;
  reviewTasks: ExportReviewTask[];
  reviewEnabled: boolean;
  reviewBusy: boolean;
  onCreateReview: (instruction: string) => void;
  onApplyReview: (taskId: string, selectedChangeIds: string[]) => void;
};
```

Layout structure:

```tsx
<footer className="export-action-bar">
  <div className="export-action-model">
    <ConversationModelMenu
      providers={providers}
      selection={modelSelection}
      disabled={runInProgress}
      saving={Boolean(savingModel)}
      onSelection={async (selection) => {
        await onModelChange(selection);
      }}
    />
  </div>
  <div className="export-action-review">
    {reviewEnabled ? (
      <ReviewLedger
        tasks={reviewTasks}
        busy={reviewBusy}
        onCreateTask={onCreateReview}
        onApplyTask={onApplyReview}
      />
    ) : (
      <p className="export-review-placeholder">
        评审任务账本仅用于蓝图与正式正文。
      </p>
    )}
  </div>
  <div className="export-action-run">
    {/* status, primary, cancel — same as today */}
  </div>
</footer>
```

`requiresModel && !modelSelection` still disables primary.

- [ ] **Step 4: Wire ExportCenter workbench + bottom bar**

1. Remove the right `<aside className="export-review">…</aside>` block.
2. Keep workbench as navigator + preview only.
3. Pass review handlers into `ExportActionBar`:

```tsx
<ExportActionBar
  providers={providers}
  modelSelection={snapshot.modelSelection}
  onModelChange={async (selection) => {
    handleModelChange(selection);
  }}
  primaryLabel={PRIMARY_LABELS[next.action]}
  onPrimary={handlePrimary}
  primaryDisabled={busy || loading || next.action === "complete" || runInProgress}
  activeRun={activeRun}
  onCancel={handleCancelRun}
  requiresModel={requiresModel}
  reviewTasks={reviewTasks}
  reviewEnabled={selectedKind === "blueprint" || selectedKind === "formal_draft"}
  reviewBusy={actionsLocked}
  onCreateReview={handleCreateReview}
  onApplyReview={handleApplyReview}
/>
```

Make `handleModelChange` return the promise from `saveExportModelSelection` so the menu can await save.

- [ ] **Step 5: CSS for layout A**

In `src/styles/export.css`:

```css
.export-workbench {
  /* two columns: navigator | preview */
  grid-template-columns: 220px minmax(0, 1fr);
}

.export-action-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: end;
  gap: 12px;
}

.export-action-review {
  min-width: 0;
  max-height: 220px;
  overflow: auto;
}

.export-action-model {
  position: relative;
  align-self: end;
}

/* Popover opens upward (workspace.css already uses bottom: calc(100% + 7px)).
   Ensure bar does not clip: */
.export-action-bar {
  overflow: visible;
  z-index: 5;
}

@media (max-width: 1100px) {
  .export-action-bar {
    grid-template-columns: 1fr;
  }
}
```

Remove obsolete `.export-action-models` rules that only served three selects, or leave unused rules deleted.

- [ ] **Step 6: Run UI regressions, lint, build**

```bash
node --test --experimental-strip-types --test-name-pattern="export" tests/workspace-regressions.test.ts
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/export/ExportActionBar.tsx src/components/app/ExportCenter.tsx src/styles/export.css tests/workspace-regressions.test.ts
git commit -m "feat(export): move review and model menu to bottom bar"
```

---

### Task 4: Full verification and docs touch

**Files:**
- Modify: `tests/workspace-regressions.test.ts` (if any remaining gaps)
- Optional: `README.md` only if user-facing layout description is wrong (skip if already accurate enough)

- [ ] **Step 1: Run frontend contract suite**

```bash
node --test --experimental-strip-types tests/export-state.test.ts tests/export-diff.test.ts
node --test --experimental-strip-types --test-name-pattern="export" tests/workspace-regressions.test.ts
npm run lint
npm run build
npm run test:storage-contract
npm run test:no-browser-runtime
```

Expected: all PASS.

- [ ] **Step 2: Run Rust suites**

```bash
cargo test -p sion-core export
cargo test -p sion-storage export_store
cargo test --manifest-path src-tauri/Cargo.toml export_
cargo clippy --workspace -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: all PASS.

- [ ] **Step 3: Manual smoke (required for crash + selection)**

On a disposable project:

1. Open workbench project A; open Export Center; switch dropdown to project B — workspace must load B and stay on B.
2. Generate blueprint with incomplete nodes → confirm strip → “仍按当前已批准内容继续” — app must not quit; run progresses or shows a notice.
3. Confirm bottom bar shows conversation-style model control; review input lives in the bar; no right review column.
4. Select formal Word → 另存为 still works if Word exists.

- [ ] **Step 4: Commit any verification-only test fixes**

```bash
git add tests/
git commit -m "test(export): cover ux hardening regressions"
```

(Skip commit if nothing changed.)

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Layout A: ConversationModelMenu in bottom bar | Task 3 |
| Layout A: full ReviewLedger in bottom center | Task 3 |
| Layout A: remove right review column | Task 3 |
| Responsive bottom stack ≤1100px | Task 3 CSS |
| Independent project selection (remembered first) | Task 2 |
| Remove resolve→onSelect writeback | Task 2 |
| Prefill when entering exports | Task 2 |
| Acknowledge path no crash | Task 1 |
| Confirm failure clears pendingAction | Task 1 |
| Keep CAS / secrets / safe preview invariants | unchanged; verified Task 4 |

## Placeholder scan

No TBD/TODO steps. Commands and code blocks are concrete.

## Type consistency

- `resolveExportProjectId(projects, active, remembered)` parameter order unchanged; priority order changes.
- `ExportActionBar` gains review props; `onModelChange` may return `Promise`.
- `ConversationModelMenu.onSelection` remains `(selection) => Promise<void>`.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-export-center-ux-hardening.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
