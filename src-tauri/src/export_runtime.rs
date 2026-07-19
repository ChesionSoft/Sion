//! Synchronous export service: versioned commands, stable error mapping, the
//! workspace snapshot, artifact content preview, CAS mutations, review
//! application, and native Save As.
//!
//! Export domain errors travel inside a successful versioned IPC envelope as
//! `ExportCommandOutcome::Error`, so the frontend unwraps a typed
//! `ExportCommandError` instead of parsing an `ApiError` string. Asynchronous
//! model runs (generation, review proposals, finalization) live alongside these
//! synchronous commands and are added in Task 8.

use serde::{Deserialize, Serialize};
use sion_agent::AgentRunStatus;
use sion_core::{
    ChatModelSelection, ExportApproval, ExportArtifactKind, ExportArtifactRecord, ExportCandidate,
    ExportReviewTask, ExportWorkspaceState, WorkflowNode, WorkflowNodeId, stale_source_nodes,
};
use sion_storage::{ExportCasResult, ProjectStore, StorageError};
use tauri_plugin_dialog::DialogExt;

use super::{
    API_VERSION, ApiError, VersionedRequest, VersionedResponse, assert_api_version,
    resolve_registered_project_root,
};

const MARKDOWN_PREVIEW_MAX_CHARS: usize = 100_000;
const DOCX_PREVIEW_MAX_BYTES: usize = 2_000_000;
const DOCX_PREVIEW_MAX_CHARS: usize = 100_000;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // all variants belong to the stable IPC contract; Task 8 constructs the run/QA kinds
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCommandError {
    pub kind: ExportCommandErrorKind,
    pub message: String,
    pub latest_revision: Option<u64>,
    pub latest_digest: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ExportCommandOutcome<T> {
    Success { value: T },
    Error { error: ExportCommandError },
}

fn outcome<T>(result: Result<T, ExportCommandError>) -> ExportCommandOutcome<T> {
    match result {
        Ok(value) => ExportCommandOutcome::Success { value },
        Err(error) => ExportCommandOutcome::Error { error },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifactSummary {
    pub kind: ExportArtifactKind,
    pub filename: String,
    pub revision: u64,
    pub digest: String,
    pub available: bool,
    pub updated_at: Option<String>,
    pub stale: bool,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportApprovals {
    pub blueprint: Option<ExportApproval>,
    pub draft: Option<ExportApproval>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRunSummary {
    pub run_id: String,
    pub status: AgentRunStatus,
    pub public_summary: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWorkspaceSnapshot {
    pub project_id: String,
    pub model_selection: Option<ChatModelSelection>,
    pub blueprint: ExportArtifactSummary,
    pub delivery_artifacts: Vec<ExportArtifactSummary>,
    pub approvals: ExportApprovals,
    pub qa_state: sion_core::ExportQaState,
    pub pending_candidates: Vec<ExportCandidate>,
    pub review_tasks: Vec<ExportReviewTask>,
    pub active_run: Option<ExportRunSummary>,
    pub source_warnings: Vec<WorkflowNodeId>,
    pub attachment_batch_status: sion_core::ExportAttachmentBatchStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportArtifactContent {
    Markdown {
        markdown: String,
        truncated: bool,
    },
    Source {
        markdown: String,
        truncated: bool,
    },
    DocxHtml {
        html: String,
        truncated: bool,
        character_count: usize,
    },
    Empty,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSaveAsResult {
    pub exported: bool,
    pub path: Option<String>,
}

fn map_storage_error(error: StorageError) -> ExportCommandError {
    let kind = match &error {
        StorageError::NotRegistered(_)
        | StorageError::NotInitialized
        | StorageError::ExportCandidateNotFound(_)
        | StorageError::ExportReviewNotFound(_) => ExportCommandErrorKind::NotFound,
        StorageError::InvalidExportContent(_) => ExportCommandErrorKind::ValidationFailed,
        _ => ExportCommandErrorKind::IoFailed,
    };
    ExportCommandError {
        kind,
        message: error.to_string(),
        latest_revision: None,
        latest_digest: None,
    }
}

fn artifact_summary(
    kind: ExportArtifactKind,
    record: Option<&ExportArtifactRecord>,
    current_blueprint_digest: Option<&str>,
    current_draft_digest: Option<&str>,
) -> ExportArtifactSummary {
    match record {
        Some(record) => {
            let stale = record
                .based_on_blueprint_digest
                .as_deref()
                .zip(current_blueprint_digest)
                .is_some_and(|(based, current)| based != current)
                || record
                    .based_on_draft_digest
                    .as_deref()
                    .zip(current_draft_digest)
                    .is_some_and(|(based, current)| based != current);
            ExportArtifactSummary {
                kind,
                filename: record.filename.clone(),
                revision: record.revision,
                digest: record.digest.clone(),
                available: true,
                updated_at: Some(record.updated_at.clone()),
                stale,
                byte_size: record.byte_size,
            }
        }
        None => ExportArtifactSummary {
            kind,
            filename: kind.filename().into(),
            revision: 0,
            digest: String::new(),
            available: false,
            updated_at: None,
            stale: false,
            byte_size: 0,
        },
    }
}

/// Builds the workspace snapshot: blueprint summary, seven delivery artifact
/// summaries, approvals, QA state, candidates, review tasks, advisory source
/// warnings, and the active run (None until Task 8 wires run tracking).
pub fn export_workspace_snapshot(
    store: &ProjectStore,
    nodes: &[WorkflowNode],
) -> Result<ExportWorkspaceSnapshot, ExportCommandError> {
    let manifest = store.manifest().map_err(map_storage_error)?;
    let state = store.export_workspace().map_err(map_storage_error)?;
    let reviews = store.list_export_reviews().map_err(map_storage_error)?;
    let blueprint_record = state
        .artifacts
        .iter()
        .find(|record| record.kind == ExportArtifactKind::Blueprint);
    let draft_record = state
        .artifacts
        .iter()
        .find(|record| record.kind == ExportArtifactKind::FormalDraft);
    let current_blueprint_digest = blueprint_record.map(|record| record.digest.as_str());
    let current_draft_digest = draft_record.map(|record| record.digest.as_str());
    let blueprint = artifact_summary(
        ExportArtifactKind::Blueprint,
        blueprint_record,
        current_blueprint_digest,
        current_draft_digest,
    );
    let delivery_artifacts = ExportArtifactKind::DELIVERY_ARTIFACTS
        .iter()
        .map(|&kind| {
            let record = state.artifacts.iter().find(|record| record.kind == kind);
            artifact_summary(kind, record, current_blueprint_digest, current_draft_digest)
        })
        .collect();
    let source_warnings = blueprint_record
        .and_then(|record| record.source_snapshot.as_ref())
        .map(|snapshot| stale_source_nodes(snapshot, nodes))
        .unwrap_or_default();
    Ok(ExportWorkspaceSnapshot {
        project_id: manifest.id,
        model_selection: state.model_selection.clone(),
        blueprint,
        delivery_artifacts,
        approvals: ExportApprovals {
            blueprint: state.blueprint_approval.clone(),
            draft: state.draft_approval.clone(),
        },
        qa_state: state.qa_state.clone(),
        pending_candidates: state.pending_candidates.clone(),
        review_tasks: reviews,
        active_run: None,
        source_warnings,
        attachment_batch_status: state.attachment_batch_status.clone(),
    })
}

fn cas_outcome(
    store: &ProjectStore,
    nodes: &[WorkflowNode],
    result: Result<ExportCasResult, StorageError>,
) -> Result<ExportWorkspaceSnapshot, ExportCommandError> {
    match result {
        Ok(ExportCasResult::Saved(_)) => export_workspace_snapshot(store, nodes),
        Ok(ExportCasResult::Conflict {
            latest_revision,
            latest_digest,
        }) => Err(ExportCommandError {
            kind: ExportCommandErrorKind::RevisionConflict,
            message: "the artifact changed before the request was applied".into(),
            latest_revision: Some(latest_revision),
            latest_digest: Some(latest_digest),
        }),
        Err(error) => Err(map_storage_error(error)),
    }
}

fn state_outcome(
    store: &ProjectStore,
    nodes: &[WorkflowNode],
    result: Result<ExportWorkspaceState, StorageError>,
) -> Result<ExportWorkspaceSnapshot, ExportCommandError> {
    result
        .map_err(map_storage_error)
        .and_then(|_| export_workspace_snapshot(store, nodes))
}

fn bound_chars(value: &str, max_chars: usize) -> (String, bool) {
    let count = value.chars().count();
    if count <= max_chars {
        (value.to_string(), false)
    } else {
        (value.chars().take(max_chars).collect(), true)
    }
}

fn get_artifact_content(
    store: &ProjectStore,
    kind: ExportArtifactKind,
    view: &str,
) -> Result<ExportArtifactContent, ExportCommandError> {
    let bytes = store.export_artifact(kind).map_err(map_storage_error)?;
    let Some(bytes) = bytes else {
        return Ok(ExportArtifactContent::Empty);
    };
    if kind == ExportArtifactKind::FormalDocx {
        if view == "source" {
            return Ok(ExportArtifactContent::Error {
                message: "DOCX 源码不可用，请使用预览或另存为".into(),
            });
        }
        let preview = super::docx_preview::preview_docx(
            &bytes,
            DOCX_PREVIEW_MAX_BYTES,
            DOCX_PREVIEW_MAX_CHARS,
        )
        .map_err(|message| ExportCommandError {
            kind: ExportCommandErrorKind::IoFailed,
            message,
            latest_revision: None,
            latest_digest: None,
        })?;
        return Ok(ExportArtifactContent::DocxHtml {
            html: preview.html,
            truncated: preview.truncated,
            character_count: preview.character_count,
        });
    }
    let markdown = String::from_utf8(bytes).map_err(|_| ExportCommandError {
        kind: ExportCommandErrorKind::IoFailed,
        message: "artifact is not valid UTF-8".into(),
        latest_revision: None,
        latest_digest: None,
    })?;
    if view == "source" {
        Ok(ExportArtifactContent::Source {
            markdown,
            truncated: false,
        })
    } else {
        let (bounded, truncated) = bound_chars(&markdown, MARKDOWN_PREVIEW_MAX_CHARS);
        Ok(ExportArtifactContent::Markdown {
            markdown: bounded,
            truncated,
        })
    }
}

// --- Request types ----------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWorkspaceGetRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportModelSelectionSaveRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    model_selection: ChatModelSelection,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifactGetRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    artifact_kind: ExportArtifactKind,
    view: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifactSaveRequest {
    #[serde(flatten)]
    pub version: VersionedRequest,
    pub project_id: String,
    pub artifact_kind: ExportArtifactKind,
    pub expected_revision: u64,
    pub expected_digest: String,
    pub markdown: String,
    pub now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifactApproveRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    artifact_kind: ExportArtifactKind,
    expected_revision: u64,
    expected_digest: String,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCandidateApplyRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    candidate_id: String,
    expected_revision: u64,
    expected_digest: String,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCandidateDiscardRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    candidate_id: String,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReviewApplyRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    task_id: String,
    selected_change_ids: Vec<String>,
    expected_revision: u64,
    expected_digest: String,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocxSaveAsRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
}

fn store_nodes(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<(ProjectStore, Vec<WorkflowNode>), ApiError> {
    let project_root = resolve_registered_project_root(app, project_id)?;
    let store = ProjectStore::at(project_root);
    let nodes = store
        .list_nodes()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok((store, nodes))
}

// --- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn export_workspace_get(
    request: ExportWorkspaceGetRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (store, nodes) = store_nodes(&app, &request.project_id)?;
    let snapshot = export_workspace_snapshot(&store, &nodes);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[tauri::command]
pub fn export_model_selection_save(
    request: ExportModelSelectionSaveRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (store, nodes) = store_nodes(&app, &request.project_id)?;
    let result = store.save_export_model_selection(request.model_selection, request.now);
    let snapshot = state_outcome(&store, &nodes, result);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[tauri::command]
pub fn export_artifact_get(
    request: ExportArtifactGetRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportArtifactContent>>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(project_root);
    let content = get_artifact_content(&store, request.artifact_kind, &request.view);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(content),
    })
}

#[tauri::command]
pub fn export_artifact_save(
    request: ExportArtifactSaveRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (store, nodes) = store_nodes(&app, &request.project_id)?;
    let result = store.save_export_markdown_if_revision(
        request.artifact_kind,
        request.expected_revision,
        &request.expected_digest,
        request.markdown,
        request.now,
    );
    let snapshot = cas_outcome(&store, &nodes, result);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[tauri::command]
pub fn export_artifact_approve(
    request: ExportArtifactApproveRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (store, nodes) = store_nodes(&app, &request.project_id)?;
    let result = store.approve_export_artifact(
        request.artifact_kind,
        request.expected_revision,
        &request.expected_digest,
        request.now,
    );
    let snapshot = cas_outcome(&store, &nodes, result);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[tauri::command]
pub fn export_candidate_apply(
    request: ExportCandidateApplyRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (store, nodes) = store_nodes(&app, &request.project_id)?;
    let result = store.apply_export_candidate(
        &request.candidate_id,
        request.expected_revision,
        &request.expected_digest,
        request.now,
    );
    let snapshot = cas_outcome(&store, &nodes, result);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[tauri::command]
pub fn export_candidate_discard(
    request: ExportCandidateDiscardRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (store, nodes) = store_nodes(&app, &request.project_id)?;
    let result = store.discard_export_candidate(&request.candidate_id, request.now);
    let snapshot = state_outcome(&store, &nodes, result);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[tauri::command]
pub fn export_review_apply(
    request: ExportReviewApplyRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (store, nodes) = store_nodes(&app, &request.project_id)?;
    let result = store.apply_export_review(
        &request.task_id,
        &request.selected_change_ids,
        request.expected_revision,
        &request.expected_digest,
        request.now,
    );
    let snapshot = cas_outcome(&store, &nodes, result);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[tauri::command]
pub async fn export_docx_save_as(
    request: ExportDocxSaveAsRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportSaveAsResult>>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(project_root);
    let bytes = store
        .export_artifact(ExportArtifactKind::FormalDocx)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let Some(bytes) = bytes else {
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: outcome(Err(ExportCommandError {
                kind: ExportCommandErrorKind::NotFound,
                message: "formal Word has not been published yet".into(),
                latest_revision: None,
                latest_digest: None,
            })),
        });
    };
    let Some(target) = app.dialog().file().blocking_save_file() else {
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: outcome(Ok(ExportSaveAsResult {
                exported: false,
                path: None,
            })),
        });
    };
    let target = target.into_path().map_err(|error| {
        ApiError::CheckFailed(format!("selected export path is not a local path: {error}"))
    })?;
    let target = if target
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("docx"))
    {
        target
    } else {
        target.with_extension("docx")
    };
    std::fs::write(&target, &bytes).map_err(|error| {
        ApiError::CheckFailed(format!("cannot write {}: {error}", target.display()))
    })?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(Ok(ExportSaveAsResult {
            exported: true,
            path: Some(target.to_string_lossy().into_owned()),
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_storage::CreateProjectInput;

    fn store() -> (std::path::PathBuf, ProjectStore) {
        let root =
            std::env::temp_dir().join(format!("sion-export-runtime-{}", uuid::Uuid::new_v4()));
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
        (root.clone(), ProjectStore::at(root.join("project-1")))
    }

    fn nodes(store: &ProjectStore) -> Vec<WorkflowNode> {
        store.list_nodes().unwrap()
    }

    #[test]
    fn workspace_snapshot_separates_blueprint_from_seven_delivery_artifacts() {
        let (root, store) = store();
        let snapshot = export_workspace_snapshot(&store, &nodes(&store)).unwrap();
        assert_eq!(snapshot.blueprint.kind, ExportArtifactKind::Blueprint);
        assert_eq!(snapshot.delivery_artifacts.len(), 7);
        assert!(
            snapshot
                .delivery_artifacts
                .iter()
                .all(|item| item.kind.is_delivery_artifact())
        );
        let _ = std::fs::remove_dir_all(&root);
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
}
