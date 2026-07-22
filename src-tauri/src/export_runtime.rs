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
use sion_agent::{
    AgentRunKind, AgentRunStatus, RunRequest, SchedulerError,
    model_stream::{self, ProviderProtocol, StreamOutcome, StreamRequest},
};
use sion_core::{
    ChatModelSelection, ExportApproval, ExportArtifactKind, ExportArtifactRecord,
    ExportAttachmentBatchStatus, ExportBlueprint, ExportCandidate, ExportDelivery,
    ExportProposedChange, ExportProposedOp, ExportQaState, ExportReviewStatus, ExportReviewTask,
    ExportWorkspaceState, NodeStatus, WorkflowNode, WorkflowNodeId, apply_blueprint_patch,
    apply_draft_patch, build_blueprint_prompt, build_draft_prompt, build_review_prompt,
    capture_export_source, export_digest, parse_export_delivery, serialize_blueprint,
    stale_source_nodes, validate_draft,
};
use sion_storage::{ExportCasResult, ExportMarkdownLineage, ProjectStore, StorageError};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use super::{
    API_VERSION, AgentState, ApiError, VersionedRequest, VersionedResponse, assert_api_version,
    resolve_registered_project_root, sion_root,
};

/// AgentState is managed as `Arc<AgentState>` in the Tauri builder. Looking up
/// the bare type panics at runtime and was the cause of the acknowledge-start
/// crash (first path that touches the scheduler).
fn agent_state(app: &tauri::AppHandle) -> Arc<AgentState> {
    app.state::<Arc<AgentState>>().inner().clone()
}

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
/// and incomplete-node warnings, and the active export run when one is set.
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
    let source_warnings = advisory_export_warnings(&state, nodes);
    let active_run = resolve_active_export_run(store, &state);
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
        active_run,
        source_warnings,
        attachment_batch_status: state.attachment_batch_status.clone(),
    })
}

fn resolve_active_export_run(
    store: &ProjectStore,
    state: &ExportWorkspaceState,
) -> Option<ExportRunSummary> {
    let run_id = state.active_run_id.as_ref()?;
    let run = store.run(run_id).ok()?;
    Some(ExportRunSummary {
        run_id: run.id,
        status: run.status,
        public_summary: run.summary,
        updated_at: run.finished_at.or(run.started_at).unwrap_or(run.created_at),
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

fn store_nodes_with_root(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<(PathBuf, ProjectStore, Vec<WorkflowNode>), ApiError> {
    let project_root = resolve_registered_project_root(app, project_id)?;
    let store = ProjectStore::at(&project_root);
    let nodes = store
        .list_nodes()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok((project_root, store, nodes))
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
        ExportMarkdownLineage::default(),
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

// --- Task 8: model runs, candidates, review, finalization -------------------

use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportModelTarget {
    GenerateBlueprint,
    RegenerateBlueprint,
    GenerateDraft,
    RegenerateDraft,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportAction {
    GenerateBlueprint,
    RegenerateBlueprint,
    GenerateDraft,
    RegenerateDraft,
    FinalizeDocx,
    GenerateEngineeringAttachments,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRunEvent {
    pub project_id: String,
    pub run_id: String,
    pub status: AgentRunStatus,
    pub public_summary: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWorkspaceInvalidatedEvent {
    pub project_id: String,
}

fn current_record(state: &ExportWorkspaceState, kind: ExportArtifactKind) -> (u64, String) {
    state
        .artifacts
        .iter()
        .find(|record| record.kind == kind)
        .map(|record| (record.revision, record.digest.clone()))
        .unwrap_or((0, String::new()))
}

fn validation_error(message: impl Into<String>) -> ExportCommandError {
    ExportCommandError {
        kind: ExportCommandErrorKind::ValidationFailed,
        message: message.into(),
        latest_revision: None,
        latest_digest: None,
    }
}

fn io_error(message: impl Into<String>) -> ExportCommandError {
    ExportCommandError {
        kind: ExportCommandErrorKind::IoFailed,
        message: message.into(),
        latest_revision: None,
        latest_digest: None,
    }
}

fn require_cas_saved(
    result: Result<ExportCasResult, StorageError>,
) -> Result<(), ExportCommandError> {
    match result {
        Ok(ExportCasResult::Saved(_)) => Ok(()),
        Ok(ExportCasResult::Conflict {
            latest_revision,
            latest_digest,
        }) => Err(ExportCommandError {
            kind: ExportCommandErrorKind::RevisionConflict,
            message: "export artifact changed while the model was running".into(),
            latest_revision: Some(latest_revision),
            latest_digest: Some(latest_digest),
        }),
        Err(error) => Err(map_storage_error(error)),
    }
}

fn progress_summary_for_target(target: ExportModelTarget) -> &'static str {
    match target {
        ExportModelTarget::GenerateBlueprint => "正在生成导出蓝图…",
        ExportModelTarget::RegenerateBlueprint => "正在重新生成导出蓝图…",
        ExportModelTarget::GenerateDraft => "正在生成正式正文…",
        ExportModelTarget::RegenerateDraft => "正在重新生成正式正文…",
    }
}

/// Completes an export model run by parsing the agent's delivery and persisting
/// either a new artifact (first generation) or a regeneration candidate (never
/// replacing the current artifact). This is the production completion function.
pub fn complete_export_model_run(
    store: &ProjectStore,
    target: ExportModelTarget,
    delivery_raw: &str,
    run_id: &str,
    now: &str,
) -> Result<(), ExportCommandError> {
    let delivery = parse_export_delivery(delivery_raw).map_err(|error| ExportCommandError {
        kind: ExportCommandErrorKind::ProviderFailed,
        message: format!("model delivery was invalid: {error}"),
        latest_revision: None,
        latest_digest: None,
    })?;
    let state = store.export_workspace().map_err(map_storage_error)?;
    let nodes = store.list_nodes().map_err(map_storage_error)?;
    let source_snapshot = capture_export_source(&nodes);
    match (target, delivery) {
        (ExportModelTarget::GenerateBlueprint, ExportDelivery::ExportBlueprint { blueprint }) => {
            let markdown = serialize_blueprint(&blueprint);
            let (revision, digest) = current_record(&state, ExportArtifactKind::Blueprint);
            require_cas_saved(store.save_export_markdown_if_revision(
                ExportArtifactKind::Blueprint,
                revision,
                &digest,
                markdown,
                now.to_string(),
                ExportMarkdownLineage {
                    source_snapshot: Some(source_snapshot),
                    based_on_blueprint_digest: None,
                },
            ))?;
        }
        (ExportModelTarget::RegenerateBlueprint, ExportDelivery::ExportBlueprint { blueprint }) => {
            let markdown = serialize_blueprint(&blueprint);
            let (base_revision, base_digest) =
                current_record(&state, ExportArtifactKind::Blueprint);
            let candidate = ExportCandidate {
                id: run_id.to_string(),
                target_kind: ExportArtifactKind::Blueprint,
                base_revision,
                base_digest,
                candidate_digest: export_digest(markdown.as_bytes()),
                markdown,
                model_selection: state.model_selection.clone(),
                created_at: now.to_string(),
            };
            store
                .save_export_candidate(candidate, now.to_string())
                .map_err(map_storage_error)?;
        }
        (ExportModelTarget::GenerateDraft, ExportDelivery::ExportDraft { markdown, .. }) => {
            let validated =
                validate_draft(&markdown).map_err(|error| validation_error(error.to_string()))?;
            let (revision, digest) = current_record(&state, ExportArtifactKind::FormalDraft);
            let based_on_blueprint = state
                .blueprint_approval
                .as_ref()
                .map(|approval| approval.approved_digest.clone())
                .or_else(|| {
                    state
                        .artifacts
                        .iter()
                        .find(|record| record.kind == ExportArtifactKind::Blueprint)
                        .map(|record| record.digest.clone())
                });
            require_cas_saved(store.save_export_markdown_if_revision(
                ExportArtifactKind::FormalDraft,
                revision,
                &digest,
                validated,
                now.to_string(),
                ExportMarkdownLineage {
                    source_snapshot: Some(source_snapshot),
                    based_on_blueprint_digest: based_on_blueprint,
                },
            ))?;
        }
        (ExportModelTarget::RegenerateDraft, ExportDelivery::ExportDraft { markdown, .. }) => {
            let validated =
                validate_draft(&markdown).map_err(|error| validation_error(error.to_string()))?;
            let (base_revision, base_digest) =
                current_record(&state, ExportArtifactKind::FormalDraft);
            let candidate = ExportCandidate {
                id: run_id.to_string(),
                target_kind: ExportArtifactKind::FormalDraft,
                base_revision,
                base_digest,
                candidate_digest: export_digest(validated.as_bytes()),
                markdown: validated,
                model_selection: state.model_selection.clone(),
                created_at: now.to_string(),
            };
            store
                .save_export_candidate(candidate, now.to_string())
                .map_err(map_storage_error)?;
        }
        _ => {
            return Err(validation_error(
                "delivery kind does not match the run target",
            ));
        }
    }
    Ok(())
}

/// Marks every persisted Queued or Running export run as Interrupted and clears
/// the active run id, so an unclean shutdown never leaves a stale in-flight run.
pub fn recover_interrupted_export_run(
    store: &ProjectStore,
    now: &str,
) -> Result<(), ExportCommandError> {
    let runs = store.list_runs().map_err(map_storage_error)?;
    for run in runs {
        if matches!(
            run.kind,
            AgentRunKind::ExportBlueprint | AgentRunKind::ExportDraft | AgentRunKind::ExportReview
        ) && matches!(run.status, AgentRunStatus::Queued | AgentRunStatus::Running)
        {
            let mut updated = run.clone();
            updated.status = AgentRunStatus::Interrupted;
            updated.finished_at = Some(now.to_string());
            store.save_run(&updated).map_err(map_storage_error)?;
        }
    }
    store
        .set_export_active_run(None, now.to_string())
        .map_err(map_storage_error)?;
    Ok(())
}

fn format_qa_report_markdown(report: &super::docx_check::DocxQaReport) -> String {
    let mut out = format!(
        "# DOCX QA 报告\n\n- 通过：{}\n- 结构单元数：{}\n- 检查时间：{}\n",
        report.passed, report.structural_unit_count, report.checked_at
    );
    if !report.issues.is_empty() {
        out.push_str("\n## 问题\n\n");
        for issue in &report.issues {
            out.push_str(&format!("- {}: {}\n", issue.code, issue.message));
        }
    }
    out
}

/// Deterministically builds the formal Word from the approved draft, runs
/// structural QA, publishes on pass (then builds engineering attachments), or
/// writes a failure report and keeps the previous passing Word on failure.
pub fn finalize_docx(store: &ProjectStore, now: &str) -> Result<(), ExportCommandError> {
    let state = store.export_workspace().map_err(map_storage_error)?;
    let draft_approval = state
        .draft_approval
        .clone()
        .ok_or_else(|| validation_error("formal draft must be approved before finalizing Word"))?;
    let current_draft_digest = state
        .artifacts
        .iter()
        .find(|record| record.kind == ExportArtifactKind::FormalDraft)
        .map(|record| record.digest.clone());
    if current_draft_digest.as_deref() != Some(draft_approval.approved_digest.as_str()) {
        return Err(validation_error(
            "approved draft digest does not match the current draft",
        ));
    }
    let draft_bytes = store
        .export_artifact(ExportArtifactKind::FormalDraft)
        .map_err(map_storage_error)?
        .ok_or_else(|| validation_error("formal draft is missing"))?;
    let draft_markdown =
        String::from_utf8(draft_bytes).map_err(|_| io_error("draft is not valid UTF-8"))?;
    let manifest = store.manifest().map_err(map_storage_error)?;
    let docx_bytes =
        super::project_export::build_docx(&manifest, &draft_markdown).map_err(io_error)?;
    let qa_report = super::docx_check::check_export_docx(&docx_bytes, &draft_markdown, now);
    let (qa_revision, qa_digest) = current_record(&state, ExportArtifactKind::QaReport);
    let qa_markdown = format_qa_report_markdown(&qa_report);
    store
        .publish_export_bytes(
            ExportArtifactKind::QaReport,
            qa_revision,
            &qa_digest,
            qa_markdown.as_bytes(),
            None,
            now.to_string(),
        )
        .map_err(map_storage_error)?;
    if qa_report.passed {
        let (docx_revision, docx_digest) = current_record(&state, ExportArtifactKind::FormalDocx);
        store
            .publish_export_bytes(
                ExportArtifactKind::FormalDocx,
                docx_revision,
                &docx_digest,
                &docx_bytes,
                None,
                now.to_string(),
            )
            .map_err(map_storage_error)?;
        store
            .set_export_qa_state(
                ExportQaState::Passed {
                    checked_draft_digest: draft_approval.approved_digest.clone(),
                    checked_at: now.to_string(),
                },
                now.to_string(),
            )
            .map_err(map_storage_error)?;
        generate_engineering_attachments(store, &manifest, now)?;
        Ok(())
    } else {
        store
            .set_export_qa_state(
                ExportQaState::Failed {
                    checked_draft_digest: draft_approval.approved_digest.clone(),
                    checked_at: now.to_string(),
                    issue_codes: qa_report
                        .issues
                        .iter()
                        .map(|issue| issue.code.clone())
                        .collect(),
                },
                now.to_string(),
            )
            .map_err(map_storage_error)?;
        Err(ExportCommandError {
            kind: ExportCommandErrorKind::QaFailed,
            message: "DOCX 结构或内容 QA 未通过".into(),
            latest_revision: None,
            latest_digest: None,
        })
    }
}

/// Builds or rebuilds the four engineering attachments deterministically. The
/// batch is `Complete` only when all four publish; otherwise the failed kinds
/// are recorded for retry.
pub fn generate_engineering_attachments(
    store: &ProjectStore,
    manifest: &sion_core::ProjectManifest,
    now: &str,
) -> Result<(), ExportCommandError> {
    let nodes = store.list_nodes().map_err(map_storage_error)?;
    let artifacts =
        super::export_documents::build_engineering_artifacts(manifest, &nodes).map_err(io_error)?;
    let state = store.export_workspace().map_err(map_storage_error)?;
    let source_snapshot = capture_export_source(&nodes);
    let mut failed = Vec::new();
    for (kind, markdown) in artifacts {
        let (revision, digest) = current_record(&state, kind);
        if store
            .publish_export_bytes(
                kind,
                revision,
                &digest,
                markdown.as_bytes(),
                Some(source_snapshot.clone()),
                now.to_string(),
            )
            .is_err()
        {
            failed.push(kind);
        }
    }
    let status = if failed.is_empty() {
        ExportAttachmentBatchStatus::Complete
    } else {
        ExportAttachmentBatchStatus::Failed {
            failed_kinds: failed,
        }
    };
    store
        .set_export_attachment_batch(status, now.to_string())
        .map_err(map_storage_error)?;
    Ok(())
}

fn finish_export_run(
    app: &tauri::AppHandle,
    store: &ProjectStore,
    project_id: &str,
    run_id: &str,
    status: AgentRunStatus,
    summary: Option<String>,
    now: &str,
) {
    {
        let state = agent_state(app);
        if let Ok(mut scheduler) = state.scheduler.lock() {
            let _ = match &status {
                AgentRunStatus::Completed => {
                    scheduler.complete(run_id, now.to_string(), summary.clone())
                }
                AgentRunStatus::Failed => {
                    scheduler.fail(run_id, now.to_string(), summary.clone().unwrap_or_default())
                }
                AgentRunStatus::Cancelled => {
                    scheduler.cancel(run_id, now.to_string(), summary.clone())
                }
                _ => Ok(Vec::new()),
            };
        }
        if let Ok(mut jobs) = state.export_jobs.lock() {
            jobs.remove(run_id);
        }
    }
    if let Ok(mut run) = store.run(run_id) {
        run.status = status.clone();
        run.finished_at = Some(now.to_string());
        run.summary = summary.clone();
        let _ = store.save_run(&run);
    }
    let _ = store.set_export_active_run(None, now.to_string());
    let _ = app.emit(
        "export-run-updated",
        ExportRunEvent {
            project_id: project_id.to_string(),
            run_id: run_id.to_string(),
            status,
            public_summary: summary,
            updated_at: now.to_string(),
        },
    );
    let _ = app.emit(
        "export-workspace-invalidated",
        ExportWorkspaceInvalidatedEvent {
            project_id: project_id.to_string(),
        },
    );
}

#[allow(clippy::too_many_arguments)]
fn spawn_export_model_run(
    app: tauri::AppHandle,
    project_root: PathBuf,
    project_id: String,
    run_id: String,
    target: ExportModelTarget,
    prompt: String,
    model_selection: ChatModelSelection,
    _started_at: String,
) {
    tauri::async_runtime::spawn(async move {
        let store = ProjectStore::at(&project_root);
        let finish = |app: &tauri::AppHandle,
                      store: &ProjectStore,
                      status: AgentRunStatus,
                      summary: Option<String>| {
            // Always stamp finish with wall-clock time so long model runs are
            // not recorded with the start-time `now` snapshot.
            let finished_at = super::utc_now();
            finish_export_run(
                app,
                store,
                &project_id,
                &run_id,
                status,
                summary,
                &finished_at,
            );
        };
        let root = match sion_root(&app) {
            Ok(root) => root,
            Err(error) => {
                finish(
                    &app,
                    &store,
                    AgentRunStatus::Failed,
                    Some(error.to_string()),
                );
                return;
            }
        };
        let resolved = match super::provider_settings::resolve_model(
            &root,
            &model_selection.provider_id,
            &model_selection.model,
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                finish(&app, &store, AgentRunStatus::Failed, Some(error));
                return;
            }
        };
        let protocol = match resolved.protocol.as_str() {
            "chat_completions" => ProviderProtocol::ChatCompletions,
            "openai_responses" => ProviderProtocol::OpenaiResponses,
            _ => {
                finish(
                    &app,
                    &store,
                    AgentRunStatus::Failed,
                    Some("unsupported provider protocol".into()),
                );
                return;
            }
        };
        let cancellation = CancellationToken::new();
        let client = {
            let state = agent_state(&app);
            if let Ok(mut jobs) = state.export_jobs.lock() {
                jobs.insert(run_id.clone(), cancellation.clone());
            }
            state.client.clone()
        };
        let request = StreamRequest {
            endpoint: resolved.endpoint,
            api_key: resolved.api_key,
            protocol,
            model: resolved.model,
            prompt,
            reasoning_effort: model_selection.reasoning_effort,
            request_public_reasoning_summary: true,
        };
        let result = model_stream::stream_text(&client, &request, cancellation).await;
        let finished_at = super::utc_now();
        match result {
            Ok(StreamOutcome::Completed(content)) => {
                let output = content.output.join("");
                let completion =
                    complete_export_model_run(&store, target, &output, &run_id, &finished_at);
                let (status, summary) = match completion {
                    Ok(()) => (
                        AgentRunStatus::Completed,
                        Some(match target {
                            ExportModelTarget::GenerateBlueprint
                            | ExportModelTarget::RegenerateBlueprint => {
                                "导出蓝图已生成".to_string()
                            }
                            ExportModelTarget::GenerateDraft
                            | ExportModelTarget::RegenerateDraft => "正式正文已生成".to_string(),
                        }),
                    ),
                    Err(error) => (AgentRunStatus::Failed, Some(error.message)),
                };
                finish_export_run(
                    &app,
                    &store,
                    &project_id,
                    &run_id,
                    status,
                    summary,
                    &finished_at,
                );
            }
            Ok(StreamOutcome::Cancelled(_)) => {
                finish(
                    &app,
                    &store,
                    AgentRunStatus::Cancelled,
                    Some("用户取消".into()),
                );
            }
            Err(failure) => {
                finish(
                    &app,
                    &store,
                    AgentRunStatus::Failed,
                    Some(format!("provider 失败：{failure:?}")),
                );
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn start_export_model_run(
    app: &tauri::AppHandle,
    store: &ProjectStore,
    project_root: PathBuf,
    project_id: &str,
    target: ExportModelTarget,
    prompt: String,
    model_selection: ChatModelSelection,
    now: &str,
) -> Result<ExportRunSummary, ExportCommandError> {
    let run_kind = match target {
        ExportModelTarget::GenerateBlueprint | ExportModelTarget::RegenerateBlueprint => {
            AgentRunKind::ExportBlueprint
        }
        ExportModelTarget::GenerateDraft | ExportModelTarget::RegenerateDraft => {
            AgentRunKind::ExportDraft
        }
    };
    let request = RunRequest {
        project_id: project_id.to_string(),
        node_id: WorkflowNodeId::FinalExport,
        provider_id: model_selection.provider_id.clone(),
        model: model_selection.model.clone(),
        reasoning_effort: model_selection.reasoning_effort,
        file_ids: Vec::new(),
        kind: run_kind,
        created_at: now.to_string(),
        session_id: None,
        turn_id: None,
        context_snapshot: None,
    };
    let progress = progress_summary_for_target(target);
    let mut run = {
        let state = agent_state(app);
        let mut scheduler = state.scheduler.lock().map_err(|_| ExportCommandError {
            kind: ExportCommandErrorKind::IoFailed,
            message: "export scheduler lock poisoned".into(),
            latest_revision: None,
            latest_digest: None,
        })?;
        scheduler.enqueue(request).map_err(|error| match error {
            SchedulerError::NodeBusy { .. } => ExportCommandError {
                kind: ExportCommandErrorKind::RunBusy,
                message: "an export run is already active for this project".into(),
                latest_revision: None,
                latest_digest: None,
            },
            SchedulerError::NotFound(_) | SchedulerError::NotRunning(_) => ExportCommandError {
                kind: ExportCommandErrorKind::IoFailed,
                message: error.to_string(),
                latest_revision: None,
                latest_digest: None,
            },
        })?
    };
    run.summary = Some(progress.to_string());
    store.save_run(&run).map_err(map_storage_error)?;
    store
        .set_export_active_run(Some(&run.id), now.to_string())
        .map_err(map_storage_error)?;
    let _ = app.emit(
        "export-run-updated",
        ExportRunEvent {
            project_id: project_id.to_string(),
            run_id: run.id.clone(),
            status: run.status.clone(),
            public_summary: Some(progress.to_string()),
            updated_at: now.to_string(),
        },
    );
    let run_id = run.id.clone();
    let run_status = run.status.clone();
    spawn_export_model_run(
        app.clone(),
        project_root,
        project_id.to_string(),
        run_id.clone(),
        target,
        prompt,
        model_selection,
        now.to_string(),
    );
    Ok(ExportRunSummary {
        run_id,
        status: run_status,
        public_summary: Some(progress.to_string()),
        updated_at: now.to_string(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportActionStartRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    action: ExportAction,
    model_selection: Option<ChatModelSelection>,
    #[allow(dead_code)]
    expected_revision: Option<u64>,
    #[allow(dead_code)]
    expected_digest: Option<String>,
    acknowledge_source_warnings: bool,
    now: String,
}

#[tauri::command]
pub fn export_action_start(
    request: ExportActionStartRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (project_root, store, nodes) = store_nodes_with_root(&app, &request.project_id)?;
    let manifest = store
        .manifest()
        .map_err(|e| ApiError::CheckFailed(e.to_string()))?;
    // Advisory source / incomplete-node warnings block generation unless acknowledged.
    if matches!(
        request.action,
        ExportAction::GenerateBlueprint
            | ExportAction::RegenerateBlueprint
            | ExportAction::GenerateDraft
            | ExportAction::RegenerateDraft
    ) && !request.acknowledge_source_warnings
    {
        let state = store
            .export_workspace()
            .map_err(|e| ApiError::CheckFailed(e.to_string()))?;
        let warnings = advisory_export_warnings(&state, &nodes);
        if !warnings.is_empty() {
            return Ok(VersionedResponse {
                api_version: API_VERSION,
                payload: outcome(Err(ExportCommandError {
                    kind: ExportCommandErrorKind::ValidationFailed,
                    message: format!(
                        "source nodes changed or incomplete: {}。请确认按当前已批准内容继续。",
                        warnings
                            .iter()
                            .map(|node| node.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                    latest_revision: None,
                    latest_digest: None,
                })),
            });
        }
    }
    let result: Result<ExportRunSummary, ExportCommandError> = (|| {
        let action = request.action;
        match action {
            ExportAction::FinalizeDocx => {
                finalize_docx(&store, &request.now)?;
                Ok(ExportRunSummary {
                    run_id: "finalize-docx".into(),
                    status: AgentRunStatus::Completed,
                    public_summary: Some("正式 Word 与工程附件已生成".into()),
                    updated_at: request.now.clone(),
                })
            }
            ExportAction::GenerateEngineeringAttachments => {
                generate_engineering_attachments(&store, &manifest, &request.now)?;
                Ok(ExportRunSummary {
                    run_id: "engineering-attachments".into(),
                    status: AgentRunStatus::Completed,
                    public_summary: Some("工程附件已更新".into()),
                    updated_at: request.now.clone(),
                })
            }
            ExportAction::GenerateBlueprint => {
                let model_selection = require_model_selection(&store, request.model_selection)?;
                let prompt = build_blueprint_prompt(&manifest, &nodes);
                start_export_model_run(
                    &app,
                    &store,
                    project_root.clone(),
                    &request.project_id,
                    ExportModelTarget::GenerateBlueprint,
                    prompt,
                    model_selection,
                    &request.now,
                )
            }
            ExportAction::RegenerateBlueprint => {
                let model_selection = require_model_selection(&store, request.model_selection)?;
                let prompt = build_blueprint_prompt(&manifest, &nodes);
                start_export_model_run(
                    &app,
                    &store,
                    project_root.clone(),
                    &request.project_id,
                    ExportModelTarget::RegenerateBlueprint,
                    prompt,
                    model_selection,
                    &request.now,
                )
            }
            ExportAction::GenerateDraft => {
                let model_selection = require_model_selection(&store, request.model_selection)?;
                let blueprint = approved_blueprint(&store)?;
                let prompt = build_draft_prompt(&manifest, &blueprint, &nodes);
                start_export_model_run(
                    &app,
                    &store,
                    project_root.clone(),
                    &request.project_id,
                    ExportModelTarget::GenerateDraft,
                    prompt,
                    model_selection,
                    &request.now,
                )
            }
            ExportAction::RegenerateDraft => {
                let model_selection = require_model_selection(&store, request.model_selection)?;
                let blueprint = approved_blueprint(&store)?;
                let prompt = build_draft_prompt(&manifest, &blueprint, &nodes);
                start_export_model_run(
                    &app,
                    &store,
                    project_root.clone(),
                    &request.project_id,
                    ExportModelTarget::RegenerateDraft,
                    prompt,
                    model_selection,
                    &request.now,
                )
            }
        }
    })();
    let snapshot = match result {
        Ok(_) => export_workspace_snapshot(&store, &nodes),
        Err(error) => Err(error),
    };
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportActionCancelRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    run_id: String,
    now: String,
}

#[tauri::command]
pub fn export_action_cancel(
    request: ExportActionCancelRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (store, nodes) = store_nodes(&app, &request.project_id)?;
    let cancelled = {
        let state = agent_state(&app);
        if let Ok(jobs) = state.export_jobs.lock() {
            if let Some(token) = jobs.get(&request.run_id) {
                token.cancel();
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if !cancelled {
        let state = agent_state(&app);
        if let Ok(mut scheduler) = state.scheduler.lock() {
            let _ = scheduler.cancel(
                &request.run_id,
                request.now.clone(),
                Some("用户取消".into()),
            );
        }
    }
    let _ = store.set_export_active_run(None, request.now.clone());
    let _ = app.emit(
        "export-workspace-invalidated",
        ExportWorkspaceInvalidatedEvent {
            project_id: request.project_id.clone(),
        },
    );
    let snapshot = export_workspace_snapshot(&store, &nodes);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReviewStartRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    artifact_kind: ExportArtifactKind,
    instruction: String,
    expected_revision: u64,
    expected_digest: String,
    model_selection: ChatModelSelection,
    now: String,
}

#[tauri::command]
pub fn export_review_start(
    request: ExportReviewStartRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ExportCommandOutcome<ExportWorkspaceSnapshot>>, ApiError> {
    assert_api_version(&request.version)?;
    let (project_root, store, nodes) = store_nodes_with_root(&app, &request.project_id)?;
    if !matches!(
        request.artifact_kind,
        ExportArtifactKind::Blueprint | ExportArtifactKind::FormalDraft
    ) {
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: outcome(Err(validation_error(
                "only blueprint or formal draft can be reviewed",
            ))),
        });
    }
    let current_bytes = store
        .export_artifact(request.artifact_kind)
        .map_err(|e| ApiError::CheckFailed(e.to_string()))?
        .ok_or_else(|| ApiError::CheckFailed("artifact missing".into()))?;
    let current_markdown = String::from_utf8(current_bytes)
        .map_err(|_| ApiError::CheckFailed("artifact not utf-8".into()))?;
    let task = ExportReviewTask {
        id: uuid::Uuid::new_v4().to_string(),
        target_kind: request.artifact_kind,
        instruction: request.instruction.clone(),
        base_revision: request.expected_revision,
        base_digest: request.expected_digest.clone(),
        model_selection: Some(request.model_selection.clone()),
        status: ExportReviewStatus::Running,
        proposed_changes: Vec::new(),
        applied_results: Vec::new(),
        created_at: request.now.clone(),
        finished_at: None,
        applied_at: None,
    };
    store
        .save_export_review(&task)
        .map_err(|e| ApiError::CheckFailed(e.to_string()))?;
    let run_request = RunRequest {
        project_id: request.project_id.clone(),
        node_id: WorkflowNodeId::FinalExport,
        provider_id: request.model_selection.provider_id.clone(),
        model: request.model_selection.model.clone(),
        reasoning_effort: request.model_selection.reasoning_effort,
        file_ids: Vec::new(),
        kind: AgentRunKind::ExportReview,
        created_at: request.now.clone(),
        session_id: None,
        turn_id: None,
        context_snapshot: None,
    };
    let run = {
        let state = agent_state(&app);
        let mut scheduler = state
            .scheduler
            .lock()
            .map_err(|_| ApiError::CheckFailed("export scheduler lock poisoned".into()))?;
        scheduler
            .enqueue(run_request)
            .map_err(|e| ApiError::CheckFailed(e.to_string()))?
    };
    store
        .save_run(&run)
        .map_err(|e| ApiError::CheckFailed(e.to_string()))?;
    store
        .set_export_active_run(Some(&run.id), request.now.clone())
        .map_err(|e| ApiError::CheckFailed(e.to_string()))?;
    spawn_export_review_run(
        app.clone(),
        project_root,
        request.project_id.clone(),
        run.id.clone(),
        task.id.clone(),
        request.artifact_kind,
        current_markdown,
        request.expected_digest.clone(),
        request.instruction.clone(),
        request.model_selection,
        request.now.clone(),
    );
    let snapshot = export_workspace_snapshot(&store, &nodes);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: outcome(snapshot),
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_export_review_run(
    app: tauri::AppHandle,
    project_root: PathBuf,
    project_id: String,
    run_id: String,
    task_id: String,
    target_kind: ExportArtifactKind,
    current_markdown: String,
    digest: String,
    instruction: String,
    model_selection: ChatModelSelection,
    now: String,
) {
    tauri::async_runtime::spawn(async move {
        let store = ProjectStore::at(&project_root);
        let nodes = store.list_nodes().unwrap_or_default();
        let prompt = match build_review_prompt(
            target_kind,
            &current_markdown,
            &digest,
            &instruction,
            &nodes,
        ) {
            Ok(prompt) => prompt,
            Err(_) => {
                finish_review_run(
                    &app,
                    &store,
                    &project_id,
                    &run_id,
                    &task_id,
                    ExportReviewStatus::Failed,
                    &now,
                );
                return;
            }
        };
        let root = match sion_root(&app) {
            Ok(root) => root,
            Err(error) => {
                let _ = finish_review_run_status(
                    &app,
                    &store,
                    &project_id,
                    &run_id,
                    &task_id,
                    ExportReviewStatus::Failed,
                    &now,
                );
                let _ = error;
                return;
            }
        };
        let resolved = match super::provider_settings::resolve_model(
            &root,
            &model_selection.provider_id,
            &model_selection.model,
        ) {
            Ok(resolved) => resolved,
            Err(_) => {
                finish_review_run(
                    &app,
                    &store,
                    &project_id,
                    &run_id,
                    &task_id,
                    ExportReviewStatus::Failed,
                    &now,
                );
                return;
            }
        };
        let protocol = match resolved.protocol.as_str() {
            "chat_completions" => ProviderProtocol::ChatCompletions,
            "openai_responses" => ProviderProtocol::OpenaiResponses,
            _ => {
                finish_review_run(
                    &app,
                    &store,
                    &project_id,
                    &run_id,
                    &task_id,
                    ExportReviewStatus::Failed,
                    &now,
                );
                return;
            }
        };
        let cancellation = CancellationToken::new();
        let client = {
            let state = agent_state(&app);
            if let Ok(mut jobs) = state.export_jobs.lock() {
                jobs.insert(run_id.clone(), cancellation.clone());
            }
            state.client.clone()
        };
        let request = StreamRequest {
            endpoint: resolved.endpoint,
            api_key: resolved.api_key,
            protocol,
            model: resolved.model,
            prompt,
            reasoning_effort: model_selection.reasoning_effort,
            request_public_reasoning_summary: true,
        };
        let result = model_stream::stream_text(&client, &request, cancellation).await;
        let status = match result {
            Ok(StreamOutcome::Completed(content)) => {
                let output = content.output.join("");
                populate_review_proposals(
                    &store,
                    &task_id,
                    target_kind,
                    &current_markdown,
                    &output,
                    &now,
                );
                ExportReviewStatus::Ready
            }
            Ok(StreamOutcome::Cancelled(_)) => ExportReviewStatus::Cancelled,
            Err(_) => ExportReviewStatus::Failed,
        };
        finish_review_run(&app, &store, &project_id, &run_id, &task_id, status, &now);
    });
}

fn populate_review_proposals(
    store: &ProjectStore,
    task_id: &str,
    target_kind: ExportArtifactKind,
    current_markdown: &str,
    delivery_raw: &str,
    now: &str,
) {
    let Ok(mut task) = store.read_export_review(task_id) else {
        return;
    };
    let delivery = match parse_export_delivery(delivery_raw) {
        Ok(delivery) => delivery,
        Err(_) => {
            task.status = ExportReviewStatus::Failed;
            task.finished_at = Some(now.to_string());
            let _ = store.save_export_review(&task);
            return;
        }
    };
    let changes = match (target_kind, delivery) {
        (ExportArtifactKind::Blueprint, ExportDelivery::BlueprintPatch { ops, .. }) => {
            let blueprint = match sion_core::parse_blueprint(current_markdown) {
                Ok(blueprint) => blueprint,
                Err(_) => {
                    task.status = ExportReviewStatus::Failed;
                    task.finished_at = Some(now.to_string());
                    let _ = store.save_export_review(&task);
                    return;
                }
            };
            build_proposed_changes(
                target_kind,
                ops.into_iter().map(ExportProposedOp::Blueprint).collect(),
                &blueprint,
                current_markdown,
            )
        }
        (ExportArtifactKind::FormalDraft, ExportDelivery::DraftPatch { ops, .. }) => {
            build_proposed_changes_draft(target_kind, ops, current_markdown)
        }
        _ => Vec::new(),
    };
    task.proposed_changes = changes;
    task.status = ExportReviewStatus::Ready;
    task.finished_at = Some(now.to_string());
    let _ = store.save_export_review(&task);
}

#[allow(clippy::too_many_arguments)]
fn finish_review_run(
    app: &tauri::AppHandle,
    store: &ProjectStore,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    status: ExportReviewStatus,
    now: &str,
) {
    let _ = finish_review_run_status(app, store, project_id, run_id, task_id, status, now);
}

#[allow(clippy::too_many_arguments)]
fn finish_review_run_status(
    app: &tauri::AppHandle,
    store: &ProjectStore,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    status: ExportReviewStatus,
    now: &str,
) -> Result<(), ExportCommandError> {
    {
        let state = agent_state(app);
        let terminal = match status {
            ExportReviewStatus::Ready => AgentRunStatus::Completed,
            ExportReviewStatus::Failed => AgentRunStatus::Failed,
            ExportReviewStatus::Cancelled => AgentRunStatus::Cancelled,
            _ => AgentRunStatus::Completed,
        };
        if let Ok(mut scheduler) = state.scheduler.lock() {
            let _ = match terminal {
                AgentRunStatus::Completed => {
                    scheduler.complete(run_id, now.to_string(), Some(format!("review {task_id}")))
                }
                AgentRunStatus::Failed => {
                    scheduler.fail(run_id, now.to_string(), format!("review {task_id} failed"))
                }
                AgentRunStatus::Cancelled => {
                    scheduler.cancel(run_id, now.to_string(), Some("cancelled".into()))
                }
                _ => Ok(Vec::new()),
            };
        }
        if let Ok(mut jobs) = state.export_jobs.lock() {
            jobs.remove(run_id);
        }
    }
    if let Ok(mut run) = store.run(run_id) {
        run.status = AgentRunStatus::Completed;
        run.finished_at = Some(now.to_string());
        let _ = store.save_run(&run);
    }
    store
        .set_export_active_run(None, now.to_string())
        .map_err(map_storage_error)?;
    let _ = app.emit(
        "export-review-updated",
        ExportRunEvent {
            project_id: project_id.to_string(),
            run_id: run_id.to_string(),
            status: AgentRunStatus::Completed,
            public_summary: Some(format!("review {task_id} {status:?}")),
            updated_at: now.to_string(),
        },
    );
    let _ = app.emit(
        "export-workspace-invalidated",
        ExportWorkspaceInvalidatedEvent {
            project_id: project_id.to_string(),
        },
    );
    Ok(())
}

fn build_proposed_changes(
    target_kind: ExportArtifactKind,
    ops: Vec<ExportProposedOp>,
    blueprint: &ExportBlueprint,
    current_markdown: &str,
) -> Vec<ExportProposedChange> {
    ops.into_iter()
        .enumerate()
        .filter_map(|(index, op)| {
            let ExportProposedOp::Blueprint(patch) = &op else {
                return None;
            };
            let (updated, _results) =
                apply_blueprint_patch(blueprint, std::slice::from_ref(patch)).ok()?;
            let after = serialize_blueprint(&updated);
            Some(ExportProposedChange {
                id: format!("change-{index}"),
                target_kind,
                op,
                before: current_markdown.to_string(),
                after,
            })
        })
        .collect()
}

fn build_proposed_changes_draft(
    target_kind: ExportArtifactKind,
    ops: Vec<sion_core::DraftPatchOp>,
    current_markdown: &str,
) -> Vec<ExportProposedChange> {
    ops.into_iter()
        .enumerate()
        .filter_map(|(index, op)| {
            let (after, results) =
                apply_draft_patch(current_markdown, std::slice::from_ref(&op)).ok()?;
            let _ = results;
            Some(ExportProposedChange {
                id: format!("change-{index}"),
                target_kind,
                op: ExportProposedOp::Draft(op),
                before: current_markdown.to_string(),
                after,
            })
        })
        .collect()
}

/// Advisory warnings for generation actions: source nodes that changed since
/// the blueprint/draft was captured, plus content nodes that are still
/// incomplete. Never revokes approvals and never blocks preview/Save As.
fn advisory_export_warnings(
    state: &ExportWorkspaceState,
    nodes: &[WorkflowNode],
) -> Vec<WorkflowNodeId> {
    let mut warnings = Vec::new();
    let mut push_unique = |id: WorkflowNodeId| {
        if !warnings.contains(&id) {
            warnings.push(id);
        }
    };
    if let Some(snapshot) = state
        .artifacts
        .iter()
        .find(|record| record.kind == ExportArtifactKind::Blueprint)
        .and_then(|record| record.source_snapshot.as_ref())
    {
        for id in stale_source_nodes(snapshot, nodes) {
            push_unique(id);
        }
    }
    if let Some(snapshot) = state
        .artifacts
        .iter()
        .find(|record| record.kind == ExportArtifactKind::FormalDraft)
        .and_then(|record| record.source_snapshot.as_ref())
    {
        for id in stale_source_nodes(snapshot, nodes) {
            push_unique(id);
        }
    }
    for node in nodes {
        if node.id == WorkflowNodeId::FinalExport {
            continue;
        }
        if matches!(
            node.status,
            NodeStatus::NotStarted | NodeStatus::NeedsConfirmation
        ) {
            push_unique(node.id);
        }
    }
    warnings
}

fn require_model_selection(
    store: &ProjectStore,
    supplied: Option<ChatModelSelection>,
) -> Result<ChatModelSelection, ExportCommandError> {
    if let Some(selection) = supplied {
        return Ok(selection);
    }
    store
        .export_workspace()
        .map_err(map_storage_error)?
        .model_selection
        .ok_or_else(|| validation_error("no model selection configured for this project"))
}

fn approved_blueprint(store: &ProjectStore) -> Result<ExportBlueprint, ExportCommandError> {
    let state = store.export_workspace().map_err(map_storage_error)?;
    if state.blueprint_approval.is_none() {
        return Err(validation_error(
            "blueprint must be approved before generating the draft",
        ));
    }
    let bytes = store
        .export_artifact(ExportArtifactKind::Blueprint)
        .map_err(map_storage_error)?
        .ok_or_else(|| validation_error("blueprint is missing"))?;
    let markdown =
        String::from_utf8(bytes).map_err(|_| io_error("blueprint is not valid UTF-8"))?;
    sion_core::parse_blueprint(&markdown).map_err(|error| validation_error(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_agent::AgentRun;
    use sion_core::{ExportBlueprintSection, ExportInclusion, ExportPresentation};
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

    fn original_blueprint() -> String {
        "# 示例导出蓝图\n\n## 目标\n\n- id: goal\n- inclusion: confirmed\n- presentation: paragraphs\n- source: basic-info\n- headings: 建设目标\n- rationale: 对外交付\n".into()
    }

    fn valid_blueprint_delivery() -> String {
        let blueprint = ExportBlueprint {
            title: "示例导出蓝图".into(),
            sections: vec![ExportBlueprintSection {
                title: "目标".into(),
                id: "goal".into(),
                inclusion: ExportInclusion::Confirmed,
                presentation: ExportPresentation::Paragraphs,
                source: WorkflowNodeId::BasicInfo,
                headings: "建设目标".into(),
                rationale: "对外交付与评审".into(),
            }],
        };
        let body = serde_json::json!({ "kind": "export_blueprint", "blueprint": blueprint });
        format!("```delivery\n{body}\n```")
    }

    fn export_store_with_blueprint() -> (std::path::PathBuf, ProjectStore) {
        let (root, store) = store();
        let nodes = store.list_nodes().unwrap();
        store
            .save_export_markdown_if_revision(
                ExportArtifactKind::Blueprint,
                0,
                "",
                original_blueprint(),
                "2026-07-19T00:00:00Z".into(),
                ExportMarkdownLineage {
                    source_snapshot: Some(capture_export_source(&nodes)),
                    based_on_blueprint_digest: None,
                },
            )
            .unwrap();
        (root, store)
    }

    #[test]
    fn workspace_snapshot_surfaces_active_run() {
        let (root, store) = export_store_with_running_export("run-active");
        let snapshot = export_workspace_snapshot(&store, &nodes(&store)).unwrap();
        let active = snapshot.active_run.expect("active run should be present");
        assert_eq!(active.run_id, "run-active");
        assert_eq!(active.status, AgentRunStatus::Running);
        let _ = std::fs::remove_dir_all(&root);
    }

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

    fn read_blueprint(store: &ProjectStore) -> String {
        String::from_utf8(
            store
                .export_artifact(ExportArtifactKind::Blueprint)
                .unwrap()
                .unwrap(),
        )
        .unwrap()
    }

    fn export_store_with_running_export(run_id: &str) -> (std::path::PathBuf, ProjectStore) {
        let (root, store) = store();
        let run = AgentRun {
            id: run_id.to_string(),
            project_id: "project-1".to_string(),
            node_id: WorkflowNodeId::FinalExport,
            status: AgentRunStatus::Running,
            created_at: "2026-07-19T00:00:00Z".to_string(),
            started_at: Some("2026-07-19T00:00:00Z".to_string()),
            finished_at: None,
            summary: None,
            provider_id: Some("provider-1".to_string()),
            model: Some("model-1".to_string()),
            reasoning_effort: None,
            file_ids: Vec::new(),
            kind: AgentRunKind::ExportBlueprint,
            session_id: None,
            turn_id: None,
            context_snapshot: None,
            usage: None,
            duration_ms: None,
        };
        store.save_run(&run).unwrap();
        store
            .set_export_active_run(Some(run_id), "2026-07-19T00:00:00Z".into())
            .unwrap();
        (root, store)
    }

    fn read_export_run(store: &ProjectStore, run_id: &str) -> AgentRun {
        store.run(run_id).unwrap()
    }

    #[test]
    fn regeneration_completion_persists_candidate_without_replacing_current_artifact() {
        let (root, store) = export_store_with_blueprint();
        complete_export_model_run(
            &store,
            ExportModelTarget::RegenerateBlueprint,
            &valid_blueprint_delivery(),
            "run-1",
            "2026-07-19T00:00:00Z",
        )
        .unwrap();
        assert_eq!(read_blueprint(&store), original_blueprint());
        assert_eq!(
            store.export_workspace().unwrap().pending_candidates.len(),
            1
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unfinished_export_run_recovers_as_interrupted() {
        let (root, store) = export_store_with_running_export("run-1");
        recover_interrupted_export_run(&store, "2026-07-19T00:10:00Z").unwrap();
        let run = read_export_run(&store, "run-1");
        assert_eq!(run.status, AgentRunStatus::Interrupted);
        assert!(store.export_workspace().unwrap().active_run_id.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
