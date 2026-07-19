# Export Center Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Export Center as a recoverable four-stage local workflow with a separate blueprint preparation surface, seven delivery artifacts, safe previews, structured review tasks, DOCX QA, and native Save As.

**Architecture:** Rust is the only owner of export state, project files, model execution, validation, DOCX generation, QA, and preview conversion. React consumes versioned Tauri snapshots and events, keeps only view state, and renders the blueprint strip plus artifact, preview, and review columns. Export writes stay inside the registered project directory and use revision-and-digest CAS.

**Tech Stack:** Rust 2024, serde, sha2 0.10.9, quick-xml 0.41.0, docx-rs 0.4.20, Tauri 2.11, React 19, TypeScript 5.9, react-markdown, remark-gfm, Node test runner.

## Global Constraints

- New project data is written only to <projects directory>/<project id>/.
- Project writes are atomic; mutable blueprint, draft, candidate, and review application operations also use revision-and-digest CAS.
- Global application configuration remains under ~/.sion/.
- API keys remain plaintext only in ~/.sion/providers.json with restricted permissions; they never enter project data, export files, logs, run summaries, events, or IPC responses.
- The desktop runtime gains no browser search, browser automation, Playwright, web-fetch subsystem, cloud export, schedule, or export history.
- Agent output is one complete fenced delivery JSON block. Partial streamed content never becomes project content.
- Agent changes to existing blueprint or draft content are validated and previewed before the user applies them.
- Source-node changes produce an advisory warning only; they do not revoke approval or block generation, preview, download, or Save As.
- Editing the blueprint or draft itself revokes that artifact's approval and marks downstream files as based on an older digest.
- Markdown preview disables raw HTML, remote resources, and dangerous link protocols.
- DOCX preview is content-only sanitized HTML; Word or WPS remains authoritative for cover, TOC, pagination, headers, and footers.
- The Tauri crate is excluded from the root Cargo workspace, so root-crate and src-tauri verification commands must both run.
- No unrelated workbench refactor is included.

---

## File Structure

### Create

- crates/sion-core/src/export/mod.rs — artifact definitions, state, approvals, source snapshots, candidates, review records, digest and stale-state helpers.
- crates/sion-core/src/export/content.rs — blueprint and draft validation, serialization, structured patches, and delivery-envelope parsing.
- crates/sion-core/src/export/prompts.rs — deterministic prompt composition from project metadata, nodes, approved blueprint, draft, and review instruction.
- assets/export/blueprint.md — blueprint system instructions and delivery JSON contract.
- assets/export/draft.md — formal-draft system instructions and delivery JSON contract.
- assets/export/review-blueprint.md — blueprint review patch instructions.
- assets/export/review-draft.md — draft review patch instructions.
- crates/sion-storage/src/export_store.rs — fixed export paths, state/artifact/candidate/review persistence, CAS mutations, disk discovery, and restart reconciliation.
- src-tauri/src/export_documents.rs — deterministic PROJECT_DESIGN, SPEC, TASKS, and AGENTS Markdown builders.
- src-tauri/src/docx_preview.rs — bounded DOCX-to-sanitized-HTML content conversion.
- src-tauri/src/export_runtime.rs — export service operations, model jobs, safe public events, prompt execution, completion, cancellation, and deterministic finalize flow.
- src/export-state.ts — pure project-selection, pipeline, artifact grouping, event scoping, and action-availability selectors.
- src/export-diff.ts — deterministic line diff used for regeneration candidates and review proposals.
- src/components/export/BlueprintPreparationBar.tsx — blueprint-only preparation surface.
- src/components/export/ArtifactNavigator.tsx — seven-artifact grouped navigation.
- src/components/export/ArtifactPreview.tsx — Markdown, source, DOCX HTML, empty, error, and candidate diff states.
- src/components/export/ArtifactDiff.tsx — selectable before/after line diff.
- src/components/export/ReviewLedger.tsx — non-chat review task list, instruction input, and patch selection.
- src/components/export/ExportActionBar.tsx — project model picker, primary action, progress, and cancellation.
- src/styles/export.css — export-center layout and responsive rules.
- tests/export-state.test.ts — pure export selectors and stale-event tests.
- tests/export-diff.test.ts — line-diff tests.

### Modify

- Cargo.toml — expose sha2 0.10.9 to workspace crates.
- crates/sion-core/Cargo.toml — consume workspace sha2.
- crates/sion-core/src/lib.rs — export the new export domain module.
- crates/sion-storage/src/lib.rs — expose export_store and make atomic helpers available to the child module.
- crates/sion-agent/src/lib.rs — add export AgentRunKind variants while retaining FinalExport node reservation.
- src-tauri/Cargo.toml — add direct quick-xml 0.41.0 dependency.
- src-tauri/src/project_export.rs — build DOCX from approved formal Markdown and return bytes before publication.
- src-tauri/src/docx_check.rs — validate the actual candidate DOCX against approved draft content.
- src-tauri/src/lib.rs — register export commands, state, events, and remove the obsolete one-shot center command after callers migrate.
- src/types.ts — add export IPC and view-model types.
- src/api.ts — add typed wrappers for every export command.
- src/App.tsx — select the default export project, listen for scoped export invalidation events, and pass providers to ExportCenter.
- src/components/app/ExportCenter.tsx — become the thin export-page container.
- src/styles.css — import export.css.
- src/styles/shell.css — remove the old single-card Export Center styles.
- src/styles/responsive.css — coordinate application-shell breakpoints with the new export layout.
- tests/workspace-regressions.test.ts — assert blueprint separation, seven artifacts, no chat UI, scoped events, safe preview, and removal of one-shot DOCX state.
- scripts/verify-storage-contract.mjs — include new export modules in the project-root contract scan.
- README.md — document the four-stage export workflow and project-local artifacts.
- README.en.md — mirror the export and privacy documentation.

---

### Task 1: Export Artifact and Workflow Domain

**Files:**
- Modify: Cargo.toml
- Modify: crates/sion-core/Cargo.toml
- Create: crates/sion-core/src/export/mod.rs
- Modify: crates/sion-core/src/lib.rs

**Interfaces:**
- Produces: ExportArtifactKind, ExportArtifactRecord, ExportNodeSnapshot, ExportSourceSnapshot, ExportApproval, ExportQaState, ExportCandidate, ExportReviewTask, ExportWorkspaceState, ExportMutationError.
- Produces: ExportAttachmentBatchStatus, ExportReviewStatus, ExportProposedChange, ExportPatchApplication.
- Produces: export_digest(bytes: &[u8]) -> String.
- Produces: capture_export_source(nodes: &[WorkflowNode]) -> ExportSourceSnapshot.
- Produces: stale_source_nodes(snapshot: &ExportSourceSnapshot, nodes: &[WorkflowNode]) -> Vec<WorkflowNodeId>.
- Produces: approve_current(state: &mut ExportWorkspaceState, kind: ExportArtifactKind, revision: u64, digest: &str, now: &str) -> Result<(), ExportMutationError>.
- Produces: record_artifact_change(state: &mut ExportWorkspaceState, record: ExportArtifactRecord).

- [ ] **Step 1: Add failing domain tests**

Add tests at the bottom of crates/sion-core/src/export/mod.rs:

~~~rust
#[test]
fn source_changes_are_advisory_but_artifact_changes_revoke_approval() {
    let nodes = fixture_nodes();
    let snapshot = capture_export_source(&nodes);
    assert!(stale_source_nodes(&snapshot, &nodes).is_empty());

    let mut changed_nodes = nodes.clone();
    changed_nodes[0].revision += 1;
    changed_nodes[0].markdown.push_str("\n新增事实");
    assert_eq!(
        stale_source_nodes(&snapshot, &changed_nodes),
        vec![WorkflowNodeId::BasicInfo]
    );

    let mut state = ExportWorkspaceState::default();
    state.artifacts.push(record(ExportArtifactKind::Blueprint, 1, "old"));
    approve_current(
        &mut state,
        ExportArtifactKind::Blueprint,
        1,
        "old",
        "2026-07-19T00:00:00Z",
    )
    .unwrap();
    record_artifact_change(
        &mut state,
        record(ExportArtifactKind::Blueprint, 2, "new"),
    );
    assert!(state.blueprint_approval.is_none());
}

#[test]
fn artifact_filenames_are_fixed_and_blueprint_is_not_a_delivery_artifact() {
    assert_eq!(ExportArtifactKind::Blueprint.filename(), "export-blueprint.md");
    assert!(!ExportArtifactKind::Blueprint.is_delivery_artifact());
    assert_eq!(ExportArtifactKind::DELIVERY_ARTIFACTS.len(), 7);
    assert_eq!(
        ExportArtifactKind::FormalDocx.filename(),
        "项目开发设计文档.docx"
    );
}

fn fixture_nodes() -> Vec<WorkflowNode> {
    vec![
        WorkflowNode {
            id: WorkflowNodeId::BasicInfo,
            status: NodeStatus::Draft,
            markdown: "# 基本信息\n\n## 基础信息表\n\n正文".into(),
            revision: 1,
            updated_at: "2026-07-19T00:00:00Z".into(),
        },
        WorkflowNode {
            id: WorkflowNodeId::FinalExport,
            status: NodeStatus::NotStarted,
            markdown: "# 最终文档\n\n## 导出检查清单\n\n".into(),
            revision: 0,
            updated_at: "2026-07-19T00:00:00Z".into(),
        },
    ]
}

fn record(
    kind: ExportArtifactKind,
    revision: u64,
    digest: &str,
) -> ExportArtifactRecord {
    ExportArtifactRecord {
        kind,
        filename: kind.filename().into(),
        revision,
        digest: digest.into(),
        byte_size: 0,
        updated_at: "2026-07-19T00:00:00Z".into(),
        source_snapshot: None,
        based_on_blueprint_digest: None,
        based_on_draft_digest: None,
    }
}
~~~

- [ ] **Step 2: Run the tests and confirm the module is missing**

Run:

~~~bash
cargo test -p sion-core export
~~~

Expected: FAIL because crates/sion-core/src/export/mod.rs and its exported types do not exist.

- [ ] **Step 3: Add the exact domain shapes and state transitions**

Add sha2 = "0.10.9" to workspace.dependencies and sha2.workspace = true to sion-core. Export the module from lib.rs:

~~~rust
mod export;
pub use export::*;
~~~

Define the fixed artifact enum and helpers:

~~~rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportArtifactKind {
    Blueprint,
    FormalDraft,
    QaReport,
    FormalDocx,
    ProjectDesign,
    Spec,
    Tasks,
    Agents,
}

impl ExportArtifactKind {
    pub const ALL: [Self; 8] = [
        Self::Blueprint,
        Self::FormalDraft,
        Self::QaReport,
        Self::FormalDocx,
        Self::ProjectDesign,
        Self::Spec,
        Self::Tasks,
        Self::Agents,
    ];
    pub const DELIVERY_ARTIFACTS: [Self; 7] = [
        Self::FormalDraft,
        Self::QaReport,
        Self::FormalDocx,
        Self::ProjectDesign,
        Self::Spec,
        Self::Tasks,
        Self::Agents,
    ];

    pub fn filename(self) -> &'static str {
        match self {
            Self::Blueprint => "export-blueprint.md",
            Self::FormalDraft => "formal-prd-draft.md",
            Self::QaReport => "formal-prd-qa-report.md",
            Self::FormalDocx => "项目开发设计文档.docx",
            Self::ProjectDesign => "PROJECT_DESIGN.md",
            Self::Spec => "SPEC.md",
            Self::Tasks => "TASKS.md",
            Self::Agents => "AGENTS.md",
        }
    }

    pub fn is_delivery_artifact(self) -> bool {
        self != Self::Blueprint
    }
}
~~~

Use camelCase serde for persisted structs. ExportWorkspaceState has schema_version = 1, model_selection: Option<ChatModelSelection>, artifacts: Vec<ExportArtifactRecord>, blueprint_approval, draft_approval, qa_state, pending_candidates, active_run_id, attachment_batch_status, and updated_at. record_artifact_change replaces the same-kind record, clears only the changed artifact approval, and leaves downstream records in place.

- [ ] **Step 4: Run domain tests and formatting**

Run:

~~~bash
cargo fmt --all -- --check
cargo test -p sion-core export
~~~

Expected: both commands PASS.

- [ ] **Step 5: Commit the domain model**

~~~bash
git add Cargo.toml Cargo.lock crates/sion-core/Cargo.toml crates/sion-core/src/lib.rs crates/sion-core/src/export/mod.rs
git commit -m "feat(export): add export workflow domain"
~~~

---

### Task 2: Blueprint, Draft, Patch, and Delivery Contracts

**Files:**
- Create: crates/sion-core/src/export/content.rs
- Modify: crates/sion-core/src/export/mod.rs

**Interfaces:**
- Consumes: ExportArtifactKind and export_digest from Task 1.
- Produces: ExportBlueprint, ExportBlueprintSection, ExportInclusion, ExportPresentation, ExportDraft, ExportSourceMapEntry.
- Produces: BlueprintPatchOp, DraftPatchOp, ExportPatchResult.
- Produces: parse_blueprint, serialize_blueprint, validate_draft, apply_blueprint_patch, apply_draft_patch.
- Produces: parse_export_delivery(raw: &str) -> Result<ExportDelivery, ExportContentError>.

- [ ] **Step 1: Write failing validation and patch tests**

~~~rust
#[test]
fn blueprint_round_trips_and_rejects_unmapped_included_sections() {
    let blueprint = fixture_blueprint();
    let markdown = serialize_blueprint(&blueprint);
    assert_eq!(parse_blueprint(&markdown).unwrap(), blueprint);

    let invalid = markdown.replace("- source: basic-info", "- source: -");
    assert!(matches!(
        parse_blueprint(&invalid),
        Err(ExportContentError::InvalidBlueprint(_))
    ));
}

#[test]
fn draft_rejects_placeholders_and_requires_a_body_below_every_h2() {
    assert!(validate_draft("# PRD\n\n## 目标\n\n可度量目标").is_ok());
    assert!(validate_draft("# PRD\n\n## 目标\n\nTBD").is_err());
    assert!(validate_draft("# PRD\n\n## 空章节\n\n## 下一章\n\n正文").is_err());
}

#[test]
fn delivery_parser_accepts_one_delivery_fence_and_rejects_prose() {
    let raw = "\u{60}\u{60}\u{60}delivery\n{\"kind\":\"export_draft\",\"markdown\":\"# PRD\\n\\n## 目标\\n\\n正文\",\"sourceMap\":[]}\n\u{60}\u{60}\u{60}";
    assert!(matches!(
        parse_export_delivery(raw).unwrap(),
        ExportDelivery::ExportDraft { .. }
    ));
    assert!(parse_export_delivery("解释").is_err());
}
~~~

- [ ] **Step 2: Verify the new content module fails to compile**

Run:

~~~bash
cargo test -p sion-core export::content
~~~

Expected: FAIL because the content module and contracts are missing.

- [ ] **Step 3: Implement the content contracts**

Define the proven blueprint vocabulary exactly:

~~~rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportInclusion {
    Confirmed,
    ConfirmedSummary,
    Omit,
    RequiredDisclosure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportPresentation {
    Paragraphs,
    Bullets,
    Table,
    Flow,
    Appendix,
}
~~~

Blueprint Markdown uses one H1 and one or more H2 sections. Each H2 has exactly these six metadata lines: id, inclusion, presentation, source, headings, rationale. Non-omit sections require at least one source node. Section IDs are unique.

Draft validation enforces one H1, at least one H2, a non-empty body under every H2, no heading-level skip above H3, and no case-insensitive matches for TBD, TODO, 待确认, 待补充, 后续补充, agent 建议, agent 分析, or 历史结论.

Define the delivery envelope:

~~~rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportDelivery {
    ExportBlueprint { blueprint: ExportBlueprint },
    ExportDraft {
        markdown: String,
        source_map: Vec<ExportSourceMapEntry>,
    },
    BlueprintPatch {
        artifact_digest: String,
        ops: Vec<BlueprintPatchOp>,
    },
    DraftPatch {
        artifact_digest: String,
        ops: Vec<DraftPatchOp>,
    },
}
~~~

parse_export_delivery requires exactly one delivery fence and no non-whitespace outside it. Patch application returns one applied-or-skipped result per requested operation, then revalidates the complete artifact.

The test module defines fixture_blueprint with one confirmed section whose ID is goal, source node is Goals, source heading is 建设目标, presentation is Paragraphs, and rationale is 对外交付. The constructor returns ExportBlueprint directly; it must not parse fixture Markdown to create its own expected value.

- [ ] **Step 4: Run focused and full core tests**

~~~bash
cargo test -p sion-core export::content
cargo test -p sion-core
~~~

Expected: both commands PASS.

- [ ] **Step 5: Commit content validation**

~~~bash
git add crates/sion-core/src/export/mod.rs crates/sion-core/src/export/content.rs
git commit -m "feat(export): validate export content and patches"
~~~

---

### Task 3: Embedded Export Prompts

**Files:**
- Create: assets/export/blueprint.md
- Create: assets/export/draft.md
- Create: assets/export/review-blueprint.md
- Create: assets/export/review-draft.md
- Create: crates/sion-core/src/export/prompts.rs
- Modify: crates/sion-core/src/export/mod.rs

**Interfaces:**
- Consumes: ProjectManifest, WorkflowNode, ExportBlueprint, ExportArtifactKind.
- Produces: ExportPromptKind and export_system_prompt(kind).
- Produces: build_blueprint_prompt, build_draft_prompt, build_review_prompt.

- [ ] **Step 1: Add failing prompt tests**

~~~rust
#[test]
fn blueprint_prompt_excludes_final_export_and_labels_incomplete_nodes() {
    let prompt = build_blueprint_prompt(&fixture_manifest(), &fixture_nodes());
    assert!(prompt.contains("nodeId: basic-info"));
    assert!(prompt.contains("status: draft"));
    assert!(!prompt.contains("nodeId: final-export"));
    assert!(prompt.contains("delivery"));
}

#[test]
fn review_prompt_binds_instruction_and_digest() {
    let prompt = build_review_prompt(
        ExportArtifactKind::FormalDraft,
        "# PRD\n\n## 目标\n\n正文",
        "digest-1",
        "把目标改成可量化指标",
        &fixture_nodes(),
    )
    .unwrap();
    assert!(prompt.contains("digest-1"));
    assert!(prompt.contains("把目标改成可量化指标"));
    assert!(prompt.contains("draft_patch"));
}
~~~

- [ ] **Step 2: Run the tests and confirm prompt builders are missing**

~~~bash
cargo test -p sion-core export::prompts
~~~

Expected: FAIL because prompt assets and builders do not exist.

- [ ] **Step 3: Write prompt assets and deterministic builders**

Each system asset requires one delivery fence, forbids invented facts and process prose, and prints its exact JSON shape. Blueprint uses the inclusion and presentation enums from Task 2. Draft returns export_draft with Markdown and sourceMap. Review assets return only blueprint_patch or draft_patch.

Embed assets at compile time:

~~~rust
pub fn export_system_prompt(kind: ExportPromptKind) -> &'static str {
    match kind {
        ExportPromptKind::Blueprint => {
            include_str!("../../../../assets/export/blueprint.md")
        }
        ExportPromptKind::Draft => {
            include_str!("../../../../assets/export/draft.md")
        }
        ExportPromptKind::ReviewBlueprint => {
            include_str!("../../../../assets/export/review-blueprint.md")
        }
        ExportPromptKind::ReviewDraft => {
            include_str!("../../../../assets/export/review-draft.md")
        }
    }
}
~~~

build_blueprint_prompt includes all first 11 nodes in workflow order with node ID, status, revision, and Markdown. Incomplete status is advisory context, not a hard filter. build_draft_prompt includes the approved blueprint and current referenced nodes. build_review_prompt includes current artifact, current digest, one instruction, and allowed source nodes.

The prompt test module defines fixture_manifest as ProjectManifest schema version 1 with ID project-1 and name 示例项目. Its fixture_nodes function constructs BasicInfo in Draft status and FinalExport in NotStarted status using the same WorkflowNode fields shown in Task 1.

- [ ] **Step 4: Verify prompt assets and tests**

~~~bash
cargo test -p sion-core export::prompts
cargo test -p sion-core
~~~

Expected: PASS, and deleting any asset causes compilation to fail.

- [ ] **Step 5: Commit embedded prompt contracts**

~~~bash
git add assets/export crates/sion-core/src/export
git commit -m "feat(export): embed staged export prompts"
~~~

---

### Task 4: Project-Local Export Store

**Files:**
- Create: crates/sion-storage/src/export_store.rs
- Modify: crates/sion-storage/src/lib.rs
- Modify: scripts/verify-storage-contract.mjs

**Interfaces:**
- Consumes: all export domain types from Tasks 1 and 2.
- Produces ProjectStore methods:
  - export_workspace() -> Result<ExportWorkspaceState>
  - export_artifact(kind) -> Result<Option<Vec<u8>>>
  - save_export_model_selection(selection, now) -> Result<ExportWorkspaceState>
  - save_export_markdown_if_revision(kind, expected_revision, expected_digest, markdown, now) -> Result<ExportCasResult>
  - approve_export_artifact(kind, expected_revision, expected_digest, now) -> Result<ExportCasResult>
  - save_export_candidate(candidate, now) -> Result<ExportWorkspaceState>
  - apply_export_candidate(candidate_id, expected_revision, expected_digest, now) -> Result<ExportCasResult>
  - discard_export_candidate(candidate_id, now) -> Result<ExportWorkspaceState>
  - list_export_reviews() -> Result<Vec<ExportReviewTask>>
  - save_export_review(task) -> Result<()>
  - apply_export_review(task_id, selected_change_ids, expected_revision, expected_digest, now) -> Result<ExportCasResult>
  - publish_export_bytes(kind, expected_revision, expected_digest, bytes, source_snapshot, now) -> Result<ExportCasResult>.

- [ ] **Step 1: Add failing storage tests**

~~~rust
#[test]
fn export_store_round_trips_state_artifacts_candidates_and_reviews() {
    let root = export_fixture();
    let store = ProjectStore::at(root.join("project-1"));
    let first = store
        .save_export_markdown_if_revision(
            ExportArtifactKind::Blueprint,
            0,
            "",
            valid_blueprint(),
            "2026-07-19T00:00:00Z".into(),
        )
        .unwrap();
    assert!(matches!(first, ExportCasResult::Saved(_)));
    assert_eq!(
        String::from_utf8(
            store.export_artifact(ExportArtifactKind::Blueprint)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        valid_blueprint()
    );
}

#[test]
fn stale_export_write_never_overwrites_latest_content() {
    let store = export_store();
    save_blueprint(&store, 0, "", valid_blueprint());
    let stale = store
        .save_export_markdown_if_revision(
            ExportArtifactKind::Blueprint,
            0,
            "",
            changed_blueprint(),
            "2026-07-19T00:01:00Z".into(),
        )
        .unwrap();
    assert!(matches!(stale, ExportCasResult::Conflict { .. }));
    assert_eq!(read_blueprint(&store), valid_blueprint());
}
~~~

- [ ] **Step 2: Verify the storage API is absent**

~~~bash
cargo test -p sion-storage export_store
~~~

Expected: FAIL because export_store and ExportCasResult are missing.

- [ ] **Step 3: Implement fixed paths, atomic writes, and CAS**

Expose the child module:

~~~rust
mod export_store;
pub use export_store::*;
~~~

Keep path construction internal:

~~~rust
impl ProjectStore {
    fn export_artifact_path(&self, kind: ExportArtifactKind) -> PathBuf {
        self.project_root.join("exports").join(kind.filename())
    }

    fn export_state_path(&self) -> PathBuf {
        self.project_root.join("exports").join("export-state.json")
    }
}
~~~

Validate Markdown with Task 2 before writing. Write bytes first, compute the resulting record, then write state. On load, compare state record byte size and digest with the real fixed file. Return StorageError::InvalidExportState for mismatches; never reset or delete the file.

Candidates live under exports/candidates/<uuid>.json and reviews under exports/reviews/<uuid>.json. Exactly one pending candidate per target kind remains referenced in state. A newer candidate removes the older referenced candidate only after the new candidate and state both persist.

The export_store test module creates a unique temp directory with std::env::temp_dir plus Uuid, calls ProjectStore::create_in with project-1 metadata, and removes the directory at the end of each test. valid_blueprint returns the six-metadata-line blueprint from Task 2. changed_blueprint changes only its rationale. save_blueprint and read_blueprint are thin wrappers around save_export_markdown_if_revision and export_artifact; they contain no separate storage behavior.

- [ ] **Step 4: Run storage tests and contract checks**

~~~bash
cargo test -p sion-storage export_store
cargo test -p sion-storage
npm run test:storage-contract
~~~

Expected: all commands PASS.

- [ ] **Step 5: Commit project-local storage**

~~~bash
git add crates/sion-storage/src/lib.rs crates/sion-storage/src/export_store.rs scripts/verify-storage-contract.mjs
git commit -m "feat(export): persist export workspace state"
~~~

---

### Task 5: Deterministic Engineering Attachments

**Files:**
- Create: src-tauri/src/export_documents.rs
- Modify: src-tauri/src/lib.rs

**Interfaces:**
- Consumes: ProjectManifest and the first 11 WorkflowNode values.
- Produces: build_engineering_artifacts(manifest, nodes) -> Result<Vec<(ExportArtifactKind, String)>, String>.

- [ ] **Step 1: Write failing deterministic-output tests**

~~~rust
#[test]
fn engineering_artifacts_have_fixed_names_order_and_sources() {
    let artifacts = build_engineering_artifacts(&manifest(), &nodes()).unwrap();
    assert_eq!(
        artifacts.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
        vec![
            ExportArtifactKind::ProjectDesign,
            ExportArtifactKind::Spec,
            ExportArtifactKind::Tasks,
            ExportArtifactKind::Agents,
        ]
    );
    assert!(artifacts[0].1.contains("# 示例项目 项目开发设计文档"));
    assert!(artifacts[0].1.contains("## 1. 项目基本信息"));
    assert!(!artifacts[0].1.contains("12. 最终文档生成"));
    assert!(artifacts[2].1.contains("开发任务"));
}
~~~

- [ ] **Step 2: Run the focused Tauri test and observe the missing builder**

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml export_documents
~~~

Expected: FAIL because export_documents.rs and build_engineering_artifacts do not exist.

- [ ] **Step 3: Implement all four builders**

Use WORKFLOW order and exclude FinalExport. PROJECT_DESIGN contains project metadata and every node chapter. SPEC includes goals, roles, business flow, feature, page interaction, data, API, architecture, and risks. TASKS contains the development-tasks body plus project metadata. AGENTS contains local project context, the fixed node order, delivery-block rule, validation requirement, and the no-browser-runtime constraint.

Return a stable vector:

~~~rust
pub fn build_engineering_artifacts(
    manifest: &ProjectManifest,
    nodes: &[WorkflowNode],
) -> Result<Vec<(ExportArtifactKind, String)>, String> {
    let ordered = ordered_content_nodes(nodes)?;
    Ok(vec![
        (
            ExportArtifactKind::ProjectDesign,
            build_project_design(manifest, &ordered),
        ),
        (ExportArtifactKind::Spec, build_spec(manifest, &ordered)),
        (ExportArtifactKind::Tasks, build_tasks(manifest, &ordered)),
        (ExportArtifactKind::Agents, build_agents(manifest)),
    ])
}
~~~

The local manifest fixture uses schema_version 1, ID project-1, name 示例项目, customer 客户, author Sion, and version V1.0. The node fixture maps WorkflowNodeId::ALL to valid default Markdown, then replaces BasicInfo and DevelopmentTasks with the assertions' Chinese bodies. This fixture construction belongs in the same test module and does not become production API.

- [ ] **Step 4: Verify deterministic builders**

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml export_documents
~~~

Expected: PASS.

- [ ] **Step 5: Commit engineering artifacts**

~~~bash
git add src-tauri/src/export_documents.rs src-tauri/src/lib.rs
git commit -m "feat(export): build engineering attachments"
~~~

---

### Task 6: Formal DOCX Builder, QA, and Content Preview

**Files:**
- Modify: src-tauri/Cargo.toml
- Modify: src-tauri/src/project_export.rs
- Modify: src-tauri/src/docx_check.rs
- Create: src-tauri/src/docx_preview.rs
- Modify: src-tauri/src/lib.rs

**Interfaces:**
- Produces: build_docx(manifest: &ProjectManifest, approved_markdown: &str) -> Result<Vec<u8>, String>.
- Produces: check_export_docx(bytes: &[u8], approved_markdown: &str, checked_at: &str) -> DocxQaReport.
- Produces: preview_docx(bytes: &[u8], max_bytes: usize, max_chars: usize) -> Result<DocxHtmlPreview, String>.

- [ ] **Step 1: Add failing DOCX behavior tests**

~~~rust
#[test]
fn approved_markdown_builds_a_qa_passing_docx() {
    let markdown = "# 示例项目 PRD\n\n## 目标\n\n- 保留中文正文\n\n## 范围\n\n| 项目 | 值 |\n| --- | --- |\n| 模式 | 本地 |";
    let bytes = build_docx(&manifest(), markdown).unwrap();
    let report = check_export_docx(&bytes, markdown, "2026-07-19T00:00:00Z");
    assert!(report.passed, "{:?}", report.issues);
    assert!(report.structural_unit_count >= 2);
}

#[test]
fn docx_preview_is_bounded_and_emits_only_owned_html() {
    let bytes = build_docx(&manifest(), "# PRD\n\n## 目标\n\n<script>x</script>中文").unwrap();
    let preview = preview_docx(&bytes, 2_000_000, 100_000).unwrap();
    assert!(preview.html.contains("<h2>目标</h2>"));
    assert!(!preview.html.contains("<script"));
    assert!(!preview.html.contains("http://"));
}
~~~

- [ ] **Step 2: Confirm the new APIs fail**

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml export_docx
cargo test --manifest-path src-tauri/Cargo.toml docx_preview
~~~

Expected: FAIL because build_docx, real QA, and preview conversion are absent.

- [ ] **Step 3: Refactor DOCX generation around approved Markdown**

Keep the existing heading, list, table, font, cover, TOC, header/footer, and page-break code. Replace the node-based public entry with:

~~~rust
pub fn build_docx(
    manifest: &ProjectManifest,
    approved_markdown: &str,
) -> Result<Vec<u8>, String> {
    let document = build_document(manifest, approved_markdown);
    let mut cursor = Cursor::new(Vec::new());
    document
        .build()
        .pack(&mut cursor)
        .map_err(|error| format!("DOCX pack failed: {error}"))?;
    Ok(cursor.into_inner())
}
~~~

The runtime, not project_export.rs, owns atomic publication.

- [ ] **Step 4: Implement actual QA and sanitized preview**

Add quick-xml = "0.41.0" to src-tauri/Cargo.toml. QA opens the ZIP, requires [Content_Types].xml and word/document.xml, extracts visible text and paragraph styles, verifies Chinese text, verifies every approved H2 heading, verifies at least one structural unit, and records stable issue codes.

DocxHtmlPreview has html, truncated, and character_count. Parse only document-owned paragraphs, headings, lists, and tables. Escape &, <, >, double quote, and single quote before emitting text. Emit only p, h1, h2, h3, ul, ol, li, table, thead, tbody, tr, th, td, strong, em, and code.

The DOCX test manifest is the same explicit project-1 / 示例项目 / 客户 / Sion / V1.0 ProjectManifest described in Task 5. Keep it local to project_export.rs tests.

- [ ] **Step 5: Run DOCX, startup, and clippy checks**

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml export_docx
cargo test --manifest-path src-tauri/Cargo.toml docx_preview
cargo test --manifest-path src-tauri/Cargo.toml generates_a_readable_docx_with_chinese_text
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
~~~

Expected: all commands PASS.

- [ ] **Step 6: Commit DOCX services**

~~~bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/project_export.rs src-tauri/src/docx_check.rs src-tauri/src/docx_preview.rs src-tauri/src/lib.rs
git commit -m "feat(export): validate and preview formal docx"
~~~

---

### Task 7: Synchronous Export Service and IPC

**Files:**
- Create: src-tauri/src/export_runtime.rs
- Modify: src-tauri/src/lib.rs

**Interfaces:**
- Consumes: ProjectStore export methods, engineering builders, DOCX services.
- Produces the versioned commands named in the design: export_workspace_get, export_model_selection_save, export_artifact_get, export_artifact_save, export_artifact_approve, export_candidate_apply, export_candidate_discard, export_review_apply, export_docx_save_as.
- Produces stable ExportCommandErrorKind values.
- Produces ExportCommandOutcome<T>, so stable export errors travel inside a successful versioned IPC envelope without changing the existing string serialization used by non-export ApiError.

- [ ] **Step 1: Write failing service and request-contract tests**

~~~rust
#[test]
fn workspace_snapshot_separates_blueprint_from_seven_delivery_artifacts() {
    let snapshot = export_workspace_snapshot(&store(), &nodes()).unwrap();
    assert_eq!(snapshot.blueprint.kind, ExportArtifactKind::Blueprint);
    assert_eq!(snapshot.delivery_artifacts.len(), 7);
    assert!(snapshot
        .delivery_artifacts
        .iter()
        .all(|item| item.kind.is_delivery_artifact()));
}

#[test]
fn artifact_save_request_requires_revision_digest_and_supported_kind() {
    let request: ExportArtifactSaveRequest =
        serde_json::from_value(serde_json::json!({
            "apiVersion": 1,
            "projectId": "p",
            "artifactKind": "blueprint",
            "expectedRevision": 2,
            "expectedDigest": "abc",
            "markdown": "# 蓝图\n\n## 目标\n- id: goal\n- inclusion: confirmed\n- presentation: paragraphs\n- source: goals\n- headings: 建设目标\n- rationale: 对外交付",
            "now": "2026-07-19T00:00:00Z"
        }))
        .unwrap();
    assert_eq!(request.expected_revision, 2);
}
~~~

- [ ] **Step 2: Verify the IPC contracts are missing**

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml export_workspace_
~~~

Expected: FAIL because export_runtime and request types are missing.

- [ ] **Step 3: Implement sync service functions and stable error mapping**

Define:

~~~rust
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportCommandErrorKind {
    NotFound,
    ValidationFailed,
    RevisionConflict,
    StaleReview,
    RunBusy,
    ProviderFailed,
    QaFailed,
    Cancelled,
    IoFailed,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ExportCommandOutcome<T> {
    Success { value: T },
    Error { error: ExportCommandError },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCommandError {
    pub kind: ExportCommandErrorKind,
    pub message: String,
    pub latest_revision: Option<u64>,
    pub latest_digest: Option<String>,
}
~~~

ExportArtifactGetRequest accepts an ExportArtifactKind enum and view = preview or source; it never accepts a filename or path. Markdown responses contain markdown and truncated. DOCX preview responses contain sanitized html and the fixed fidelity warning. Approval accepts only Blueprint or FormalDraft.

export_review_apply reads the persisted task, checks selected IDs belong to it, applies only selected validated operations, CAS saves, and writes per-operation applied/skipped results before returning the new snapshot.

export_docx_save_as reads only the current fixed FormalDocx path, opens the native save dialog, appends .docx when needed, and copies atomically to the selected target.

The export_runtime test module defines test_store by creating project-1 in a unique temp directory and test_nodes by reading store.list_nodes. These two helpers are reused by Task 8 tests in the same module.

- [ ] **Step 4: Register commands and preserve one migration boundary**

Add the new commands to tauri::generate_handler. Keep project_export_docx temporarily as a private compatibility helper only until Task 12 removes its frontend caller; do not expose two center paths at final verification.

- [ ] **Step 5: Run synchronous command tests**

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml export_workspace_
cargo test --manifest-path src-tauri/Cargo.toml export_artifact_
cargo test --manifest-path src-tauri/Cargo.toml export_review_apply
~~~

Expected: all commands PASS.

- [ ] **Step 6: Commit synchronous IPC**

~~~bash
git add src-tauri/src/export_runtime.rs src-tauri/src/lib.rs
git commit -m "feat(export): expose export workspace commands"
~~~

---

### Task 8: Export Agent Runs, Candidates, and Review Proposals

**Files:**
- Modify: crates/sion-agent/src/lib.rs
- Modify: src-tauri/src/export_runtime.rs
- Modify: src-tauri/src/lib.rs

**Interfaces:**
- Adds AgentRunKind::ExportBlueprint, ExportDraft, and ExportReview.
- Adds AgentRunStatus::Interrupted for persisted export runs recovered after an application restart.
- Uses WorkflowNodeId::FinalExport for scheduler reservation so one export model run exists per project while global concurrency remains enforced.
- Produces export_action_start, export_action_cancel, and export_review_start.
- Produces export-run-updated, export-review-updated, and export-workspace-invalidated events.

- [ ] **Step 1: Add failing scheduler and completion tests**

~~~rust
#[test]
fn export_runs_reserve_the_final_export_node_per_project() {
    let mut scheduler = RunScheduler::new(2);
    scheduler
        .enqueue(export_request(
            "project-a",
            AgentRunKind::ExportBlueprint,
        ))
        .unwrap();
    let conflict = scheduler.enqueue(export_request(
        "project-a",
        AgentRunKind::ExportDraft,
    ));
    assert!(matches!(
        conflict,
        Err(SchedulerError::NodeBusy { .. })
    ));
    assert!(
        scheduler
            .enqueue(export_request(
                "project-b",
                AgentRunKind::ExportDraft,
            ))
            .is_ok()
    );
}
~~~

Add a Tauri completion test:

~~~rust
#[test]
fn regeneration_completion_persists_candidate_without_replacing_current_artifact() {
    let store = export_store_with_blueprint();
    complete_export_model_run(
        &store,
        ExportModelTarget::RegenerateBlueprint,
        valid_blueprint_delivery(),
        "run-1",
        "2026-07-19T00:00:00Z",
    )
    .unwrap();
    assert_eq!(read_blueprint(&store), original_blueprint());
    assert_eq!(
        store
            .export_workspace()
            .unwrap()
            .pending_candidates
            .len(),
        1
    );
}

#[test]
fn unfinished_export_run_recovers_as_interrupted() {
    let store = export_store_with_running_export("run-1");
    recover_interrupted_export_run(
        &store,
        "2026-07-19T00:10:00Z",
    )
    .unwrap();
    let run = read_export_run(&store, "run-1");
    assert_eq!(run.status, AgentRunStatus::Interrupted);
    assert!(store.export_workspace().unwrap().active_run_id.is_none());
}
~~~

In the sion-agent test module, export_request constructs a RunRequest with
WorkflowNodeId::FinalExport, the requested AgentRunKind, no session or turn,
empty imported files, provider ID "provider-1", model "model-1", medium
reasoning effort, no context snapshot, and a deterministic timestamp.
In export_runtime tests, export_store_with_blueprint builds on Task 7's
test_store, publishes original_blueprint at revision 1, and returns the store.
valid_blueprint_delivery is a complete fenced delivery JSON document whose
artifact kind is blueprint and whose Markdown passes Task 2 validation.
read_blueprint reads the fixed blueprint artifact path; original_blueprint is
the exact Markdown initially published. complete_export_model_run is the
production completion function under test, not a test-only surrogate.
export_store_with_running_export persists one Running export AgentRun and sets
active_run_id to run-1. read_export_run reads that persisted run record.

- [ ] **Step 2: Confirm tests fail before run kinds and jobs exist**

~~~bash
cargo test -p sion-agent export_runs
cargo test --manifest-path src-tauri/Cargo.toml export_model_run
~~~

Expected: FAIL because export run kinds and completion logic are missing.

- [ ] **Step 3: Implement job creation and prompt execution**

ExportActionStartRequest includes action, optional model selection, optional
expected revision and digest, and acknowledge_source_warnings: bool. Reject a
generation action with ValidationFailed when advisory source or incomplete-node
warnings exist and the flag is false; when true, continue without revoking any
approval. Preview, download, Save As, and approval commands do not require this
flag.

ExportModelJob contains project_root, run_id, target, prompt, resolved model, reasoning effort, cancellation token, expected revision, expected digest, optional review_task_id, and started instant. It never contains an API key in a serializable type.

Use sion_agent::model_stream::stream_text. Collect output text in memory, ignore provider-only hidden reasoning, and retain only the bounded public reasoning summary in the run record. On completed stream, parse one delivery block with Task 2.

First generation saves a validated artifact. Regeneration saves a validated ExportCandidate. Review saves validated patch operations to the persisted review task with ready status. On startup, recover_interrupted_export_run changes every persisted Queued or Running export run to Interrupted, clears active_run_id, persists both changes, and only then emits workspace invalidation.

- [ ] **Step 4: Implement terminal ordering, cancellation, and promotion**

Persist the final run and export or review state before emitting a terminal event. Cancellation removes the in-memory job and writes Cancelled without an artifact or candidate. Queued run cancellation uses RunScheduler::cancel and never starts the Provider.

Events carry:

~~~rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportRunEvent {
    pub project_id: String,
    pub run_id: String,
    pub status: AgentRunStatus,
    pub public_summary: Option<String>,
    pub updated_at: String,
}
~~~

- [ ] **Step 5: Implement deterministic finalize action**

finalize_docx checks current draft approval, builds a temporary DOCX, runs QA, atomically publishes on pass, writes the QA report, then calls build_engineering_artifacts. A failed candidate is deleted. An older passing Word remains and is marked based on an older draft digest.

- [ ] **Step 6: Run model-runtime and cancellation tests**

~~~bash
cargo test -p sion-agent
cargo test --manifest-path src-tauri/Cargo.toml export_model_run
cargo test --manifest-path src-tauri/Cargo.toml export_action_cancel
cargo test --manifest-path src-tauri/Cargo.toml finalize_docx
~~~

Expected: all commands PASS.

- [ ] **Step 7: Commit export runtime**

~~~bash
git add crates/sion-agent/src/lib.rs src-tauri/src/export_runtime.rs src-tauri/src/lib.rs
git commit -m "feat(export): run staged export agents"
~~~

---

### Task 9: Frontend Export Contracts, Selection, and Diff

**Files:**
- Modify: src/types.ts
- Modify: src/api.ts
- Create: src/export-state.ts
- Create: src/export-diff.ts
- Create: tests/export-state.test.ts
- Create: tests/export-diff.test.ts

**Interfaces:**
- Mirrors every Rust camelCase export type.
- Mirrors ExportCommandOutcome<T> as a success-or-error discriminated union and never relies on parsing an ApiError string for export-domain failures.
- Produces resolveExportProjectId, resolveDefaultExportModelSelection, exportArtifactGroups, nextExportAction, acceptExportEvent.
- Produces invokeExportPayload<T>, which unwraps ExportCommandOutcome<T> and throws a typed ExportClientError for the Error branch.
- Produces lineDiff(before: string, after: string) -> DiffLine[].

- [ ] **Step 1: Write failing pure TypeScript tests**

~~~typescript
test("defaults export project to active then remembered then most recent", () => {
  const projects = [
    {
      id: "old",
      name: "Old",
      rootPath: "/old",
      openedAt: "2026-07-18T00:00:00Z",
    },
    {
      id: "new",
      name: "New",
      rootPath: "/new",
      openedAt: "2026-07-19T00:00:00Z",
    },
  ];
  assert.equal(resolveExportProjectId(projects, "old", "new"), "old");
  assert.equal(resolveExportProjectId(projects, null, "old"), "old");
  assert.equal(resolveExportProjectId(projects, null, null), "new");
});

test("default model selection uses the default provider and model", () => {
  assert.deepEqual(
    resolveDefaultExportModelSelection(providers()),
    {
      providerId: "provider-1",
      model: "model-1",
      reasoningEffort: "medium",
    },
  );
});

test("artifact groups exclude blueprint and include seven artifacts", () => {
  const groups = exportArtifactGroups([
    artifact("formal_draft"),
    artifact("formal_docx"),
    artifact("project_design"),
    artifact("spec"),
    artifact("tasks"),
    artifact("agents"),
    artifact("docx_qa_report"),
    artifact("blueprint"),
  ]);
  assert.equal(groups.flatMap((group) => group.items).length, 7);
  assert.equal(
    groups
      .flatMap((group) => group.items)
      .some((item) => item.kind === "blueprint"),
    false,
  );
});

test("line diff preserves stable and changed lines", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nc"), [
    { kind: "same", text: "a" },
    { kind: "remove", text: "b" },
    { kind: "add", text: "c" },
  ]);
});
~~~

The local artifact helper returns a complete ExportArtifactSummary with the
given kind, fixed filename, revision 1, digest "digest", available = true,
and no stale marker. This deliberately passes blueprint into the selector to
prove the selector excludes it instead of trusting its caller.
The local providers helper returns provider-1 as the default Provider with
model-1 marked default and provider-2 as a non-default fallback. The selector
returns null when no configured provider has an available model.

- [ ] **Step 2: Run tests and observe missing modules**

~~~bash
node --test --experimental-strip-types --test-name-pattern="export project|artifact groups|line diff" tests/export-state.test.ts tests/export-diff.test.ts
~~~

Expected: FAIL because export-state.ts and export-diff.ts are missing.

- [ ] **Step 3: Add exact TypeScript wire types and API wrappers**

ExportArtifactKind is the eight-value snake_case union. ExportWorkspaceSnapshot includes projectId, modelSelection, blueprint, deliveryArtifacts, approvals, qaState, pendingCandidates, reviewTasks, activeRun, sourceWarnings, and attachmentBatchStatus.

Add wrappers:

~~~typescript
export class ExportClientError extends Error {
  constructor(readonly detail: ExportCommandError) {
    super(detail.message);
    this.name = "ExportClientError";
  }
}

const invokeExportPayload = async <T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> => {
  const outcome = await invokePayload<ExportCommandOutcome<T>>(
    command,
    args,
  );
  if (outcome.outcome === "error") {
    throw new ExportClientError(outcome.error);
  }
  return outcome.value;
};

export const getExportWorkspace = (projectId: string) =>
  invokeExportPayload<ExportWorkspaceSnapshot>(
    "export_workspace_get",
    { projectId },
  );

export const saveExportModelSelection = (
  projectId: string,
  modelSelection: ChatModelSelection,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>(
    "export_model_selection_save",
    { projectId, modelSelection, now },
  );

export const applyExportReview = (
  projectId: string,
  taskId: string,
  selectedChangeIds: string[],
  expectedRevision: number,
  expectedDigest: string,
  now: string,
) =>
  invokeExportPayload<ExportWorkspaceSnapshot>(
    "export_review_apply",
    {
      projectId,
      taskId,
      selectedChangeIds,
      expectedRevision,
      expectedDigest,
      now,
    },
  );
~~~

Add one wrapper per Task 7 and Task 8 command; do not expose a filename or local path parameter.

- [ ] **Step 4: Implement selectors and deterministic LCS line diff**

resolveDefaultExportModelSelection picks the default provider, then its default
model, then its first model, and initializes reasoningEffort to medium. It never
uses or returns API-key material. exportArtifactGroups accepts
ExportArtifactSummary[] and filters blueprint before grouping. nextExportAction
returns generate_blueprint, approve_blueprint, generate_draft, approve_draft,
finalize_docx, retry_engineering_attachments, or complete from snapshot state.
Approval actions call the synchronous approval command; generation,
finalization, and attachment-retry actions call export_action_start.
acceptExportEvent requires both projectId and current run ID to match.

- [ ] **Step 5: Run frontend unit and type checks**

~~~bash
node --test --experimental-strip-types --test-name-pattern="export project|artifact groups|line diff" tests/export-state.test.ts tests/export-diff.test.ts
npm run lint
~~~

Expected: both commands PASS.

- [ ] **Step 6: Commit frontend contracts**

~~~bash
git add src/types.ts src/api.ts src/export-state.ts src/export-diff.ts tests/export-state.test.ts tests/export-diff.test.ts
git commit -m "feat(export): add frontend export contracts"
~~~

---

### Task 10: Export Center Shell, Artifact Navigation, and Preview

**Files:**
- Modify: src/App.tsx
- Modify: src/components/app/ExportCenter.tsx
- Create: src/components/export/BlueprintPreparationBar.tsx
- Create: src/components/export/ArtifactNavigator.tsx
- Create: src/components/export/ArtifactPreview.tsx
- Create: src/styles/export.css
- Modify: src/styles.css
- Modify: src/styles/shell.css
- Modify: src/styles/responsive.css
- Modify: tests/workspace-regressions.test.ts

**Interfaces:**
- Consumes ExportWorkspaceSnapshot, ExportArtifactContent, project list, providers, selected project, and refresh token.
- Produces visible blueprint preparation strip, seven-artifact list, grouped engineering attachments, and safe preview states.

- [ ] **Step 1: Add failing structural UI regression assertions**

~~~typescript
test("export center separates blueprint and previews seven delivery artifacts", async () => {
  const [center, blueprint, navigator, preview, css] =
    await Promise.all([
      readFile("src/components/app/ExportCenter.tsx", "utf8"),
      readFile(
        "src/components/export/BlueprintPreparationBar.tsx",
        "utf8",
      ),
      readFile(
        "src/components/export/ArtifactNavigator.tsx",
        "utf8",
      ),
      readFile(
        "src/components/export/ArtifactPreview.tsx",
        "utf8",
      ),
      readFile("src/styles/export.css", "utf8"),
    ]);
  assert.match(center, /BlueprintPreparationBar/);
  assert.match(center, /ArtifactNavigator/);
  assert.match(center, /ArtifactPreview/);
  assert.match(blueprint, /准备材料/);
  assert.doesNotMatch(navigator, /export-blueprint\.md/);
  assert.match(navigator, /工程附件/);
  assert.match(preview, /当前为内容预览/);
  assert.match(css, /grid-template-columns/);
});
~~~

- [ ] **Step 2: Run the regression and confirm components are absent**

~~~bash
node --test --experimental-strip-types --test-name-pattern="separates blueprint" tests/workspace-regressions.test.ts
~~~

Expected: FAIL because the export components and export.css do not exist.

- [ ] **Step 3: Implement the thin page container and read-only components**

ExportCenter resolves the selected project with resolveExportProjectId, reports
that resolved ID through onSelectProject, and loads getExportWorkspace when the
resolved ID or refreshToken changes. It ignores late responses using requestScope
and isLatestRequest. Selecting blueprint comes only from BlueprintPreparationBar.
ArtifactNavigator maps snapshot.deliveryArtifacts, not ExportArtifactKind.ALL.

Update App to pass projects, activeProjectId, rememberedProjectId, providers,
refreshToken = 0, onSelectProject, and onNotice. Remove the old exportDocx import,
ExportResult import, exporting state, lastExportResult state, exportDocx handler,
and obsolete props here so this task compiles independently. Keep the old API
wrapper and registered Rust command only as a temporary migration boundary until
Task 12.

After the first workspace load, if modelSelection is absent, derive the global
default with resolveDefaultExportModelSelection, persist it through
saveExportModelSelection, and replace the snapshot with that response. If no
Provider has a model, leave selection empty and keep deterministic actions
available. The request-scope guard also applies to this initialization response.

ArtifactPreview uses SafeMarkdown for Markdown:

~~~tsx
if (content.kind === "markdown") {
  return (
    <SafeMarkdown
      markdown={content.markdown}
      variant="document"
    />
  );
}
if (content.kind === "docx_html") {
  return (
    <>
      <div className="export-preview-warning">
        当前为内容预览。封面、目录、页眉页脚和分页请另存后在 Word 或 WPS 中查看。
      </div>
      <div
        className="export-docx-preview"
        dangerouslySetInnerHTML={{ __html: content.html }}
      />
    </>
  );
}
~~~

The only HTML accepted here is the sanitized backend response type. No URL, iframe, object, embed, or webview is introduced.

- [ ] **Step 4: Implement the approved desktop layout**

At desktop width, export-workbench uses 220px minmax(0, 1fr) 320px. At 1100px, the review column moves below preview. At 760px, artifact navigation becomes a horizontal scroller and all panes stack. BlueprintPreparationBar remains above artifact navigation at every width.

- [ ] **Step 5: Run UI, lint, and build checks**

~~~bash
node --test --experimental-strip-types --test-name-pattern="separates blueprint" tests/workspace-regressions.test.ts
npm run lint
npm run build
~~~

Expected: all commands PASS.

- [ ] **Step 6: Commit layout and preview**

~~~bash
git add src/App.tsx src/components/app/ExportCenter.tsx src/components/export/BlueprintPreparationBar.tsx src/components/export/ArtifactNavigator.tsx src/components/export/ArtifactPreview.tsx src/styles/export.css src/styles.css src/styles/shell.css src/styles/responsive.css tests/workspace-regressions.test.ts
git commit -m "feat(export): build export workspace layout"
~~~

---

### Task 11: Editing, Regeneration Candidates, and Review Ledger

**Files:**
- Create: src/components/export/ArtifactDiff.tsx
- Create: src/components/export/ReviewLedger.tsx
- Create: src/components/export/ExportActionBar.tsx
- Modify: src/components/export/ArtifactPreview.tsx
- Modify: src/components/app/ExportCenter.tsx
- Modify: src/styles/export.css
- Modify: tests/workspace-regressions.test.ts

**Interfaces:**
- Consumes candidate, review task, artifact revision/digest, model selection, and all mutation APIs from Task 9.
- Produces manual edit/save/cancel, candidate apply/discard, review task create, selectable review changes, review apply, primary action, and cancellation.

- [ ] **Step 1: Add failing review-ledger and edit-lock regressions**

~~~typescript
test("export review is a task ledger with explicit diff application, not chat", async () => {
  const [center, ledger, diff, action] = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("src/components/export/ReviewLedger.tsx", "utf8"),
    readFile("src/components/export/ArtifactDiff.tsx", "utf8"),
    readFile("src/components/export/ExportActionBar.tsx", "utf8"),
  ]);
  assert.match(ledger, /评审任务/);
  assert.match(ledger, /生成修改建议/);
  assert.match(ledger, /应用修改/);
  assert.doesNotMatch(ledger, /ChatSession|消息|conversation/);
  assert.match(diff, /selectedChangeIds/);
  assert.match(center, /expectedRevision/);
  assert.match(center, /expectedDigest/);
  assert.match(action, /取消/);
});
~~~

- [ ] **Step 2: Run the regression and confirm interaction components are missing**

~~~bash
node --test --experimental-strip-types --test-name-pattern="task ledger" tests/workspace-regressions.test.ts
~~~

Expected: FAIL because ArtifactDiff, ReviewLedger, and ExportActionBar do not exist.

- [ ] **Step 3: Implement manual editing and candidate review**

Only blueprint and formal_draft expose Edit. Entering edit copies loaded Markdown into an editor buffer and disables project, artifact, and review-task switching. Save calls saveExportArtifact with expected revision and digest. Conflict keeps the editor open and shows the latest revision.

Candidate UI always shows before/after diff. Apply sends candidate ID plus current expected revision and digest. Discard asks for confirmation and deletes only the candidate.

- [ ] **Step 4: Implement non-chat review tasks**

ReviewLedger has one instruction textarea, a Generate change proposal button, task cards, selected change checkboxes, and Apply changes. It has no role labels, bubbles, session picker, message retry, attachment picker, or continuous reply composer.

Selection is explicit:

~~~tsx
<ArtifactDiff
  lines={task.previewLines}
  selectedChangeIds={selectedChangeIds}
  onToggle={(changeId) => {
    setSelectedChangeIds((current) =>
      current.includes(changeId)
        ? current.filter((id) => id !== changeId)
        : [...current, changeId],
    );
  }}
/>
~~~

Stale tasks remain visible but disable Apply changes and offer Create new task.

When snapshot sourceWarnings or incomplete-node warnings are present, model and
deterministic generation actions first show their exact warning list with a
single "仍按当前已批准内容继续" confirmation. Only the confirmed request sends
acknowledgeSourceWarnings = true. Dismissing the confirmation does not start a
run and does not change approvals.

- [ ] **Step 5: Implement the bottom action bar**

The model picker uses Provider[] and the project snapshot selection. Save selection before starting model work. The primary action comes from nextExportAction. finalize_docx and attachment retry ignore provider availability. Active runs show public stage, disable mutations, leave preview enabled, and provide Cancel.

- [ ] **Step 6: Run UI, lint, and build checks**

~~~bash
node --test --experimental-strip-types --test-name-pattern="task ledger" tests/workspace-regressions.test.ts
npm run test:ui
npm run lint
npm run build
~~~

Expected: all commands PASS.

- [ ] **Step 7: Commit export interactions**

~~~bash
git add src/components/export/ArtifactDiff.tsx src/components/export/ReviewLedger.tsx src/components/export/ExportActionBar.tsx src/components/export/ArtifactPreview.tsx src/components/app/ExportCenter.tsx src/styles/export.css tests/workspace-regressions.test.ts
git commit -m "feat(export): add structured export review"
~~~

---

### Task 12: App-Level Project Selection and Scoped Events

**Files:**
- Modify: src/App.tsx
- Modify: src/components/app/ExportCenter.tsx
- Modify: src/api.ts
- Modify: tests/workspace-regressions.test.ts
- Modify: src-tauri/src/lib.rs

**Interfaces:**
- Consumes export event contracts and providers.
- Produces current-project-first, remembered-project-second, recent-project-third selection.
- Produces project-scoped refresh tokens and application-level Save As notices.
- Removes the obsolete exportDocx API wrapper and project_export_docx command after Task 10 has already removed their App caller and state.

- [ ] **Step 1: Add failing app orchestration regressions**

~~~typescript
test("app scopes export events and removes the obsolete one-shot command", async () => {
  const [app, api, tauri] = await Promise.all([
    readFile("src/App.tsx", "utf8"),
    readFile("src/api.ts", "utf8"),
    readFile("src-tauri/src/lib.rs", "utf8"),
  ]);
  assert.match(app, /export-workspace-invalidated/);
  assert.match(app, /projectId/);
  assert.match(app, /exportRefreshByProject/);
  assert.doesNotMatch(
    app,
    /lastExportResult|setExporting|exportDocxApi/,
  );
  assert.doesNotMatch(api, /project_export_docx/);
  assert.doesNotMatch(tauri, /project_export_docx,/);
});
~~~

- [ ] **Step 2: Run regression and observe old state**

~~~bash
node --test --experimental-strip-types --test-name-pattern="scopes export events" tests/workspace-regressions.test.ts
~~~

Expected: FAIL because App does not listen for scoped export events and the obsolete API and Rust command are still registered.

- [ ] **Step 3: Add scoped event listeners and default selection**

Listen in App because event subscriptions stay centralized. Increment exportRefreshByProject[payload.projectId] for export-workspace-invalidated and terminal export-run-updated events. Do not emit a global notice for model progress or review status.

Derive resolvedExportProjectId in App with resolveExportProjectId so the refresh
token is keyed to the same current-project-first selection that ExportCenter
will render. Pass to ExportCenter:

~~~tsx
<ExportCenter
  projects={projects}
  activeProjectId={project?.id ?? null}
  rememberedProjectId={exportProjectId}
  providers={providers}
  refreshToken={
    exportRefreshByProject[resolvedExportProjectId ?? ""] ?? 0
  }
  onSelectProject={setExportProjectId}
  onNotice={setNotice}
/>
~~~

Resolve the actual selected ID inside ExportCenter using Task 9 and report it
through onSelectProject. Save As success, cancel, and failure remain
application-level notices.

- [ ] **Step 4: Remove the obsolete one-shot command**

Delete exportDocx from src/api.ts and delete project_export_docx request/result/command registration from src-tauri/src/lib.rs. Assert that the App state and obsolete single-card props removed in Task 10 do not return.

- [ ] **Step 5: Verify event scoping and no stale response writes**

~~~bash
node --test --experimental-strip-types --test-name-pattern="scopes export events" tests/workspace-regressions.test.ts
npm run test:ui
npm run lint
cargo test --manifest-path src-tauri/Cargo.toml export_
~~~

Expected: all commands PASS.

- [ ] **Step 6: Commit application orchestration**

~~~bash
git add src/App.tsx src/components/app/ExportCenter.tsx src/api.ts tests/workspace-regressions.test.ts src-tauri/src/lib.rs
git commit -m "feat(export): integrate scoped export events"
~~~

---

### Task 13: Documentation, Contract Guards, and Full Verification

**Files:**
- Modify: README.md
- Modify: README.en.md
- Modify: scripts/verify-storage-contract.mjs
- Modify: tests/workspace-regressions.test.ts

**Interfaces:**
- Consumes the completed feature.
- Produces accurate user documentation and repository-wide regression guards.

- [ ] **Step 1: Add final contract assertions**

Extend storage verification to scan crates/sion-storage/src/export_store.rs and src-tauri/src/export_runtime.rs. Extend workspace regressions:

~~~typescript
test("export center advertises only implemented local capabilities", async () => {
  const sources = await Promise.all([
    readFile("src/components/app/ExportCenter.tsx", "utf8"),
    readFile("README.md", "utf8"),
    readFile("README.en.md", "utf8"),
  ]);
  const joined = sources.join("\n");
  assert.match(joined, /导出蓝图|Export blueprint/);
  assert.match(joined, /DOCX/);
  assert.doesNotMatch(
    joined,
    /云端导出|计划任务|scheduled export|cloud export/i,
  );
});
~~~

- [ ] **Step 2: Update Chinese and English documentation**

Document:

- four stages and the blueprint's non-artifact role;
- seven delivery artifacts and project-local exports directory;
- structured review tasks and explicit diff application;
- Markdown and DOCX content preview limits;
- advisory source staleness versus approval revocation after artifact edits;
- native Save As external copy;
- Provider-only network boundary and API-key exclusion.

Remove the old claim that Export Center only supports one-shot DOCX and never writes to the project directory.

- [ ] **Step 3: Run complete frontend and contract verification**

~~~bash
npm run test:ui
npm run lint
npm run build
npm run test:no-browser-runtime
npm run test:no-legacy-migration-runtime
npm run test:storage-contract
~~~

Expected: all commands PASS and the no-browser script reports that no browser-search implementation exists.

- [ ] **Step 4: Run complete Rust verification**

~~~bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace -- -D warnings
npm run test:rust
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
~~~

Expected: all commands PASS with no warnings.

- [ ] **Step 5: Build the desktop runtime**

~~~bash
npm run build:desktop
~~~

Expected: PASS and produce the current-platform desktop binary without bundling.

- [ ] **Step 6: Perform manual acceptance**

Use a disposable project under an explicitly chosen test projects directory:

1. Generate from incomplete nodes after acknowledging the warning.
2. Preview, edit, review, and approve blueprint.
3. Confirm blueprint never appears in the seven-artifact list.
4. Generate, review, and approve formal draft.
5. Apply only selected review changes.
6. Change a source node and confirm warning-only behavior.
7. Change draft content and confirm approval revocation plus retained stale Word.
8. Finalize DOCX, inspect content preview, and open the Save As copy in Word or WPS.
9. Trigger QA failure and confirm the candidate is deleted while an older passing Word remains.
10. Restart Sion and confirm model selection, candidates, tasks, approvals, and artifacts recover from disk.
11. Repeat native Save As and Chinese-path checks on available macOS and Windows targets.

- [ ] **Step 7: Commit documentation and guards**

~~~bash
git add README.md README.en.md scripts/verify-storage-contract.mjs tests/workspace-regressions.test.ts
git commit -m "docs: explain staged export workflow"
~~~

---

## Final Review Gate

Before integrating the branch:

- Confirm git status contains no project data, exports, local projects, settings, ~/.sion content, or Visual Companion files.
- Review the complete diff against docs/superpowers/specs/2026-07-19-export-center-redesign-design.md.
- Confirm all 13 task commits are focused and no unrelated workbench refactor entered the branch.
- Use superpowers:requesting-code-review before merge or PR creation.
