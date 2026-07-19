//! Project-local export store: fixed artifact paths, atomic state/artifact/
//! candidate/review persistence, revision-and-digest CAS mutations, disk
//! discovery, and restart reconciliation.
//!
//! All export writes stay inside the registered project's `exports/` directory.
//! Paths are derived only from the fixed `ExportArtifactKind` enum and safe ids;
//! IPC never supplies a filename or path. The shared atomic write helpers from
//! the parent module are reused so export writes share the same crash-safety
//! guarantees as the rest of the project store.

use std::path::PathBuf;

use sion_core::{
    BlueprintPatchOp, ChatModelSelection, DraftPatchOp, ExportArtifactKind, ExportArtifactRecord,
    ExportCandidate, ExportContentError, ExportPatchApplication, ExportPatchResult,
    ExportProposedChange, ExportProposedOp, ExportReviewStatus, ExportReviewTask,
    ExportSourceSnapshot, ExportWorkspaceState, apply_blueprint_patch, apply_draft_patch,
    approve_current, export_digest, parse_blueprint, record_artifact_change, serialize_blueprint,
    validate_draft,
};

use super::{
    ProjectStore, Result, StorageError, atomic_write_bytes, atomic_write_json,
    is_safe_file_component, read_json,
};

/// Outcome of a revision-and-digest CAS export mutation. `Saved` carries the new
/// workspace state; `Conflict` carries the latest revision and digest so the
/// caller can refresh without overwriting newer content.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportCasResult {
    Saved(Box<ExportWorkspaceState>),
    Conflict {
        latest_revision: u64,
        latest_digest: String,
    },
}

impl ProjectStore {
    fn exports_dir(&self) -> PathBuf {
        self.project_root.join("exports")
    }

    fn export_artifact_path(&self, kind: ExportArtifactKind) -> PathBuf {
        self.exports_dir().join(kind.filename())
    }

    fn export_state_path(&self) -> PathBuf {
        self.exports_dir().join("export-state.json")
    }

    fn export_candidates_dir(&self) -> PathBuf {
        self.exports_dir().join("candidates")
    }

    fn export_candidate_path(&self, id: &str) -> Result<PathBuf> {
        if !is_safe_file_component(id) {
            return Err(StorageError::UnsafeExportId(id.to_string()));
        }
        Ok(self.export_candidates_dir().join(format!("{id}.json")))
    }

    fn export_reviews_dir(&self) -> PathBuf {
        self.exports_dir().join("reviews")
    }

    fn export_review_path(&self, id: &str) -> Result<PathBuf> {
        if !is_safe_file_component(id) {
            return Err(StorageError::UnsafeExportId(id.to_string()));
        }
        Ok(self.export_reviews_dir().join(format!("{id}.json")))
    }

    fn save_export_state(&self, state: &ExportWorkspaceState) -> Result<()> {
        atomic_write_json(&self.export_state_path(), state)
    }

    /// Reads the export workspace state. When the state file is absent, returns
    /// a fresh default state. When present, every artifact record is verified
    /// against its fixed file's byte size and digest; a mismatch is a recovery
    /// error and never resets or deletes the file.
    pub fn export_workspace(&self) -> Result<ExportWorkspaceState> {
        self.manifest()?;
        let path = self.export_state_path();
        if !path.exists() {
            return Ok(ExportWorkspaceState::default());
        }
        let state: ExportWorkspaceState = read_json(&path)?;
        for record in &state.artifacts {
            let file_path = self.export_artifact_path(record.kind);
            let bytes = std::fs::read(&file_path).map_err(|source| StorageError::Io {
                path: file_path.clone(),
                source,
            })?;
            if record.byte_size != bytes.len() as u64 || record.digest != export_digest(&bytes) {
                return Err(StorageError::InvalidExportState(format!(
                    "artifact {:?} file does not match its record",
                    record.kind
                )));
            }
        }
        Ok(state)
    }

    /// Returns the raw bytes of a fixed export artifact, or `None` when the file
    /// does not exist yet.
    pub fn export_artifact(&self, kind: ExportArtifactKind) -> Result<Option<Vec<u8>>> {
        self.manifest()?;
        let path = self.export_artifact_path(kind);
        if !path.exists() {
            return Ok(None);
        }
        std::fs::read(&path)
            .map(Some)
            .map_err(|source| StorageError::Io { path, source })
    }

    /// Saves the project-level model selection (provider id, model, reasoning
    /// effort). API keys never enter this state.
    pub fn save_export_model_selection(
        &self,
        selection: ChatModelSelection,
        now: String,
    ) -> Result<ExportWorkspaceState> {
        self.manifest()?;
        let mut state = self.export_workspace()?;
        state.model_selection = Some(selection);
        state.updated_at = now;
        self.save_export_state(&state)?;
        Ok(state)
    }

    /// Sets or clears the active export run id. Pass `None` to clear (used on
    /// terminal completion, cancellation, and interrupted-run recovery).
    pub fn set_export_active_run(
        &self,
        run_id: Option<&str>,
        now: String,
    ) -> Result<ExportWorkspaceState> {
        self.manifest()?;
        let mut state = self.export_workspace()?;
        state.active_run_id = run_id.map(str::to_string);
        state.updated_at = now;
        self.save_export_state(&state)?;
        Ok(state)
    }

    /// Records the formal Word QA outcome.
    pub fn set_export_qa_state(
        &self,
        qa_state: sion_core::ExportQaState,
        now: String,
    ) -> Result<ExportWorkspaceState> {
        self.manifest()?;
        let mut state = self.export_workspace()?;
        state.qa_state = qa_state;
        state.updated_at = now;
        self.save_export_state(&state)?;
        Ok(state)
    }

    /// Records the engineering attachment batch status.
    pub fn set_export_attachment_batch(
        &self,
        status: sion_core::ExportAttachmentBatchStatus,
        now: String,
    ) -> Result<ExportWorkspaceState> {
        self.manifest()?;
        let mut state = self.export_workspace()?;
        state.attachment_batch_status = status;
        state.updated_at = now;
        self.save_export_state(&state)?;
        Ok(state)
    }

    fn current_artifact_fields(
        &self,
        state: &ExportWorkspaceState,
        kind: ExportArtifactKind,
    ) -> (u64, String, Option<String>, Option<String>) {
        match state.artifacts.iter().find(|record| record.kind == kind) {
            Some(record) => (
                record.revision,
                record.digest.clone(),
                record.based_on_blueprint_digest.clone(),
                record.based_on_draft_digest.clone(),
            ),
            None => (0, String::new(), None, None),
        }
    }

    /// Validates blueprint or formal draft Markdown with the Task 2 contracts,
    /// then CAS-saves it. Only blueprint and formal draft are markdown-editable.
    pub fn save_export_markdown_if_revision(
        &self,
        kind: ExportArtifactKind,
        expected_revision: u64,
        expected_digest: &str,
        markdown: String,
        now: String,
    ) -> Result<ExportCasResult> {
        self.manifest()?;
        validate_export_markdown(kind, &markdown)?;
        let mut state = self.export_workspace()?;
        let (current_revision, current_digest, based_on_blueprint, based_on_draft) =
            self.current_artifact_fields(&state, kind);
        if expected_revision != current_revision || expected_digest != current_digest {
            return Ok(ExportCasResult::Conflict {
                latest_revision: current_revision,
                latest_digest: current_digest,
            });
        }
        let bytes = markdown.into_bytes();
        atomic_write_bytes(&self.export_artifact_path(kind), &bytes)?;
        let new_record = ExportArtifactRecord {
            kind,
            filename: kind.filename().into(),
            revision: current_revision + 1,
            digest: export_digest(&bytes),
            byte_size: bytes.len() as u64,
            updated_at: now.clone(),
            source_snapshot: None,
            based_on_blueprint_digest: based_on_blueprint,
            based_on_draft_digest: based_on_draft,
        };
        record_artifact_change(&mut state, new_record);
        state.updated_at = now;
        self.save_export_state(&state)?;
        Ok(ExportCasResult::Saved(Box::new(state)))
    }

    /// CAS-approves the current blueprint or formal draft, binding the approval
    /// to the current revision and digest.
    pub fn approve_export_artifact(
        &self,
        kind: ExportArtifactKind,
        expected_revision: u64,
        expected_digest: &str,
        now: String,
    ) -> Result<ExportCasResult> {
        self.manifest()?;
        if !matches!(
            kind,
            ExportArtifactKind::Blueprint | ExportArtifactKind::FormalDraft
        ) {
            return Err(StorageError::InvalidExportContent(format!(
                "{kind:?} cannot be approved"
            )));
        }
        let mut state = self.export_workspace()?;
        let (current_revision, current_digest, _, _) = self.current_artifact_fields(&state, kind);
        if current_digest.is_empty() {
            return Err(StorageError::InvalidExportContent(format!(
                "{kind:?} has no artifact to approve"
            )));
        }
        if expected_revision != current_revision || expected_digest != current_digest {
            return Ok(ExportCasResult::Conflict {
                latest_revision: current_revision,
                latest_digest: current_digest,
            });
        }
        approve_current(&mut state, kind, current_revision, &current_digest, &now)
            .map_err(|error| StorageError::InvalidExportContent(error.to_string()))?;
        state.updated_at = now;
        self.save_export_state(&state)?;
        Ok(ExportCasResult::Saved(Box::new(state)))
    }

    /// CAS-publishes raw bytes (DOCX, QA report, engineering attachments).
    /// Artifacts generated from the draft record the approved draft digest;
    /// artifacts generated from source nodes carry the supplied source snapshot.
    pub fn publish_export_bytes(
        &self,
        kind: ExportArtifactKind,
        expected_revision: u64,
        expected_digest: &str,
        bytes: &[u8],
        source_snapshot: Option<ExportSourceSnapshot>,
        now: String,
    ) -> Result<ExportCasResult> {
        self.manifest()?;
        let mut state = self.export_workspace()?;
        let (current_revision, current_digest, based_on_blueprint, based_on_draft) =
            self.current_artifact_fields(&state, kind);
        if expected_revision != current_revision || expected_digest != current_digest {
            return Ok(ExportCasResult::Conflict {
                latest_revision: current_revision,
                latest_digest: current_digest,
            });
        }
        atomic_write_bytes(&self.export_artifact_path(kind), bytes)?;
        // Artifacts generated directly from the draft (DOCX, QA report) record
        // the approved draft digest; source-derived engineering attachments keep
        // their source snapshot and no draft binding.
        let based_on_draft_digest = if source_snapshot.is_none() {
            based_on_draft.or_else(|| {
                state
                    .draft_approval
                    .as_ref()
                    .map(|approval| approval.approved_digest.clone())
            })
        } else {
            None
        };
        let new_record = ExportArtifactRecord {
            kind,
            filename: kind.filename().into(),
            revision: current_revision + 1,
            digest: export_digest(bytes),
            byte_size: bytes.len() as u64,
            updated_at: now.clone(),
            source_snapshot,
            based_on_blueprint_digest: based_on_blueprint,
            based_on_draft_digest,
        };
        record_artifact_change(&mut state, new_record);
        state.updated_at = now;
        self.save_export_state(&state)?;
        Ok(ExportCasResult::Saved(Box::new(state)))
    }

    /// Persists a validated regeneration candidate. Exactly one pending
    /// candidate per target kind is referenced in state; a newer candidate
    /// removes the older referenced candidate's file only after both the new
    /// candidate and the state persist.
    pub fn save_export_candidate(
        &self,
        candidate: ExportCandidate,
        now: String,
    ) -> Result<ExportWorkspaceState> {
        self.manifest()?;
        atomic_write_json(&self.export_candidate_path(&candidate.id)?, &candidate)?;
        let mut state = self.export_workspace()?;
        let previous_id = state
            .pending_candidates
            .iter()
            .find(|existing| existing.target_kind == candidate.target_kind)
            .map(|existing| existing.id.clone());
        state
            .pending_candidates
            .retain(|existing| existing.target_kind != candidate.target_kind);
        state.pending_candidates.push(candidate);
        state.updated_at = now;
        self.save_export_state(&state)?;
        if let Some(previous_id) = previous_id {
            let previous_path = self.export_candidate_path(&previous_id)?;
            if previous_path.exists() {
                std::fs::remove_file(&previous_path).map_err(|source| StorageError::Io {
                    path: previous_path,
                    source,
                })?;
            }
        }
        Ok(state)
    }

    /// CAS-applies a persisted regeneration candidate, replacing the current
    /// artifact after revalidation. The candidate is kept on conflict.
    pub fn apply_export_candidate(
        &self,
        candidate_id: &str,
        expected_revision: u64,
        expected_digest: &str,
        now: String,
    ) -> Result<ExportCasResult> {
        self.manifest()?;
        let mut state = self.export_workspace()?;
        let candidate = state
            .pending_candidates
            .iter()
            .find(|existing| existing.id == candidate_id)
            .cloned()
            .ok_or_else(|| StorageError::ExportCandidateNotFound(candidate_id.to_string()))?;
        let kind = candidate.target_kind;
        let (current_revision, current_digest, _, _) = self.current_artifact_fields(&state, kind);
        if expected_revision != current_revision || expected_digest != current_digest {
            return Ok(ExportCasResult::Conflict {
                latest_revision: current_revision,
                latest_digest: current_digest,
            });
        }
        if candidate.base_revision != current_revision || candidate.base_digest != current_digest {
            return Ok(ExportCasResult::Conflict {
                latest_revision: current_revision,
                latest_digest: current_digest,
            });
        }
        validate_export_markdown(kind, &candidate.markdown)?;
        let bytes = candidate.markdown.into_bytes();
        atomic_write_bytes(&self.export_artifact_path(kind), &bytes)?;
        let new_record = ExportArtifactRecord {
            kind,
            filename: kind.filename().into(),
            revision: current_revision + 1,
            digest: export_digest(&bytes),
            byte_size: bytes.len() as u64,
            updated_at: now.clone(),
            source_snapshot: None,
            based_on_blueprint_digest: None,
            based_on_draft_digest: None,
        };
        record_artifact_change(&mut state, new_record);
        state
            .pending_candidates
            .retain(|existing| existing.id != candidate_id);
        state.updated_at = now;
        self.save_export_state(&state)?;
        let candidate_path = self.export_candidate_path(candidate_id)?;
        if candidate_path.exists() {
            std::fs::remove_file(&candidate_path).map_err(|source| StorageError::Io {
                path: candidate_path,
                source,
            })?;
        }
        Ok(ExportCasResult::Saved(Box::new(state)))
    }

    /// Discards a pending regeneration candidate, deleting only the candidate
    /// file and leaving the current artifact untouched.
    pub fn discard_export_candidate(
        &self,
        candidate_id: &str,
        now: String,
    ) -> Result<ExportWorkspaceState> {
        self.manifest()?;
        let mut state = self.export_workspace()?;
        let before = state.pending_candidates.len();
        state
            .pending_candidates
            .retain(|existing| existing.id != candidate_id);
        if state.pending_candidates.len() == before {
            return Err(StorageError::ExportCandidateNotFound(
                candidate_id.to_string(),
            ));
        }
        state.updated_at = now;
        self.save_export_state(&state)?;
        let candidate_path = self.export_candidate_path(candidate_id)?;
        if candidate_path.exists() {
            std::fs::remove_file(&candidate_path).map_err(|source| StorageError::Io {
                path: candidate_path,
                source,
            })?;
        }
        Ok(state)
    }

    /// Discovers review tasks from disk, newest first. Reviews are not indexed
    /// in workspace state to avoid index/file mismatch.
    pub fn list_export_reviews(&self) -> Result<Vec<ExportReviewTask>> {
        self.manifest()?;
        let directory = self.export_reviews_dir();
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut reviews: Vec<ExportReviewTask> = Vec::new();
        for entry in std::fs::read_dir(&directory).map_err(|source| StorageError::Io {
            path: directory.clone(),
            source,
        })? {
            let entry = entry.map_err(|source| StorageError::Io {
                path: directory.clone(),
                source,
            })?;
            if entry
                .file_type()
                .map_err(|source| StorageError::Io {
                    path: entry.path(),
                    source,
                })?
                .is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("json")
            {
                reviews.push(read_json(&entry.path())?);
            }
        }
        reviews.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(reviews)
    }

    /// Persists a review task file.
    pub fn save_export_review(&self, task: &ExportReviewTask) -> Result<()> {
        self.manifest()?;
        atomic_write_json(&self.export_review_path(&task.id)?, task)
    }

    /// Reads a single review task by id.
    pub fn read_export_review(&self, task_id: &str) -> Result<ExportReviewTask> {
        self.manifest()?;
        let path = self.export_review_path(task_id)?;
        if !path.exists() {
            return Err(StorageError::ExportReviewNotFound(task_id.to_string()));
        }
        read_json(&path)
    }

    /// CAS-applies selected review changes, revalidating the result and writing
    /// per-change applied/skipped results. Stale tasks are marked and refused.
    pub fn apply_export_review(
        &self,
        task_id: &str,
        selected_change_ids: &[String],
        expected_revision: u64,
        expected_digest: &str,
        now: String,
    ) -> Result<ExportCasResult> {
        self.manifest()?;
        let review_path = self.export_review_path(task_id)?;
        if !review_path.exists() {
            return Err(StorageError::ExportReviewNotFound(task_id.to_string()));
        }
        let mut task: ExportReviewTask = read_json(&review_path)?;
        let kind = task.target_kind;
        let mut state = self.export_workspace()?;
        let current_bytes = self.export_artifact(kind)?.ok_or_else(|| {
            StorageError::InvalidExportContent(format!("{kind:?} has no content to review"))
        })?;
        let current_markdown = String::from_utf8(current_bytes).map_err(|_| {
            StorageError::InvalidExportContent("current artifact is not valid UTF-8".into())
        })?;
        let (current_revision, current_digest, _, _) = self.current_artifact_fields(&state, kind);
        if expected_revision != current_revision || expected_digest != current_digest {
            return Ok(ExportCasResult::Conflict {
                latest_revision: current_revision,
                latest_digest: current_digest,
            });
        }
        if task.base_revision != current_revision || task.base_digest != current_digest {
            task.status = ExportReviewStatus::Stale;
            self.save_export_review(&task)?;
            return Ok(ExportCasResult::Conflict {
                latest_revision: current_revision,
                latest_digest: current_digest,
            });
        }
        let selected: Vec<&ExportProposedChange> = task
            .proposed_changes
            .iter()
            .filter(|change| selected_change_ids.contains(&change.id))
            .collect();
        for change_id in selected_change_ids {
            if !task
                .proposed_changes
                .iter()
                .any(|change| &change.id == change_id)
            {
                return Err(StorageError::InvalidExportContent(format!(
                    "change {change_id} does not belong to task {task_id}"
                )));
            }
        }
        let (new_markdown, op_results): (String, Vec<ExportPatchResult>) = match kind {
            ExportArtifactKind::Blueprint => {
                let blueprint = parse_blueprint(&current_markdown)
                    .map_err(|error| StorageError::InvalidExportContent(error.to_string()))?;
                let mut ops: Vec<BlueprintPatchOp> = Vec::new();
                for change in &selected {
                    if let ExportProposedOp::Blueprint(op) = &change.op {
                        ops.push(op.clone());
                    }
                }
                let (updated, results) = apply_blueprint_patch(&blueprint, &ops)
                    .map_err(|error| StorageError::InvalidExportContent(error.to_string()))?;
                (serialize_blueprint(&updated), results)
            }
            ExportArtifactKind::FormalDraft => {
                let mut ops: Vec<DraftPatchOp> = Vec::new();
                for change in &selected {
                    if let ExportProposedOp::Draft(op) = &change.op {
                        ops.push(op.clone());
                    }
                }
                let (updated, results) = apply_draft_patch(&current_markdown, &ops)
                    .map_err(|error| StorageError::InvalidExportContent(error.to_string()))?;
                (updated, results)
            }
            _ => {
                return Err(StorageError::InvalidExportContent(format!(
                    "{kind:?} cannot be reviewed"
                )));
            }
        };
        let mut applications = Vec::with_capacity(selected.len());
        let mut result_index = 0usize;
        for change in &task.proposed_changes {
            if !selected_change_ids.contains(&change.id) {
                continue;
            }
            let result = op_results
                .get(result_index)
                .cloned()
                .unwrap_or(ExportPatchResult {
                    applied: false,
                    reason: Some("no result recorded".into()),
                });
            result_index += 1;
            applications.push(ExportPatchApplication {
                change_id: change.id.clone(),
                applied: result.applied,
                reason: result.reason,
            });
        }
        let bytes = new_markdown.into_bytes();
        atomic_write_bytes(&self.export_artifact_path(kind), &bytes)?;
        let new_record = ExportArtifactRecord {
            kind,
            filename: kind.filename().into(),
            revision: current_revision + 1,
            digest: export_digest(&bytes),
            byte_size: bytes.len() as u64,
            updated_at: now.clone(),
            source_snapshot: None,
            based_on_blueprint_digest: None,
            based_on_draft_digest: None,
        };
        record_artifact_change(&mut state, new_record);
        task.status = if applications.iter().all(|application| application.applied) {
            ExportReviewStatus::Applied
        } else {
            ExportReviewStatus::PartiallyApplied
        };
        task.applied_results = applications;
        task.applied_at = Some(now.clone());
        task.finished_at = Some(now.clone());
        self.save_export_review(&task)?;
        state.updated_at = now;
        self.save_export_state(&state)?;
        Ok(ExportCasResult::Saved(Box::new(state)))
    }
}

fn validate_export_markdown(
    kind: ExportArtifactKind,
    markdown: &str,
) -> std::result::Result<(), StorageError> {
    match kind {
        ExportArtifactKind::Blueprint => parse_blueprint(markdown)
            .map(|_| ())
            .map_err(map_content_error),
        ExportArtifactKind::FormalDraft => validate_draft(markdown)
            .map(|_| ())
            .map_err(map_content_error),
        _ => Err(StorageError::InvalidExportContent(format!(
            "{kind:?} is not markdown-editable"
        ))),
    }
}

fn map_content_error(error: ExportContentError) -> StorageError {
    StorageError::InvalidExportContent(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CreateProjectInput;

    fn export_fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("sion-export-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(
            &root,
            CreateProjectInput {
                id: "project-1".into(),
                name: "示例项目".into(),
                customer_name: "客户".into(),
                author_name: "Sion".into(),
                now: "2026-07-19T00:00:00Z".into(),
            },
        )
        .unwrap();
        root
    }

    fn export_store() -> (PathBuf, ProjectStore) {
        let root = export_fixture();
        let store = ProjectStore::at(root.join("project-1"));
        (root, store)
    }

    fn valid_blueprint() -> String {
        "# 示例导出蓝图\n\n## 目标\n\n- id: goal\n- inclusion: confirmed\n- presentation: paragraphs\n- source: basic-info\n- headings: 建设目标\n- rationale: 对外交付\n".into()
    }

    fn changed_blueprint() -> String {
        valid_blueprint().replace("- rationale: 对外交付", "- rationale: 对外交付与评审")
    }

    fn save_blueprint(store: &ProjectStore, revision: u64, digest: &str, markdown: String) {
        store
            .save_export_markdown_if_revision(
                ExportArtifactKind::Blueprint,
                revision,
                digest,
                markdown,
                "2026-07-19T00:00:00Z".into(),
            )
            .unwrap();
    }

    fn read_blueprint(store: &ProjectStore) -> String {
        String::from_utf8(
            store
                .export_artifact(ExportArtifactKind::Blueprint)
                .unwrap()
                .unwrap(),
        )
        .unwrap()
    }

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
                store
                    .export_artifact(ExportArtifactKind::Blueprint)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            valid_blueprint()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_export_write_never_overwrites_latest_content() {
        let (root, store) = export_store();
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
        let _ = std::fs::remove_dir_all(&root);
    }
}
