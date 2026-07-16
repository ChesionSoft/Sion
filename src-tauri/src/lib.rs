mod docx_check;
mod keyring_check;
mod migration;
mod project_export;
mod provider_migration;
mod provider_settings;

use serde::{Deserialize, Serialize};
use sion_core::{
    ChatMessage, ChatRole, ChatSession, NodeStatus, ProjectFile, ProjectManifest, WorkflowNode,
    WorkflowNodeId, apply_agent_delivery,
};
use sion_storage::{
    CreateProjectInput, ProjectRegistry, ProjectStore, RecentProject, SaveNodeResult,
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

const API_VERSION: u16 = 1;

struct AgentState {
    scheduler: Mutex<sion_agent::RunScheduler>,
    jobs: Mutex<HashMap<String, AgentJob>>,
    client: reqwest::Client,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            scheduler: Mutex::new(sion_agent::RunScheduler::default()),
            jobs: Mutex::new(HashMap::new()),
            client: reqwest::Client::new(),
        }
    }
}

#[derive(Clone)]
struct AgentJob {
    project_root: PathBuf,
    session_id: String,
    prompt: String,
    model: provider_settings::ResolvedModel,
    cancellation: CancellationToken,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentTokenEvent {
    run_id: String,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    delta: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentFinishedEvent {
    run: sion_agent::AgentRun,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedRequest {
    api_version: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedResponse<T> {
    api_version: u16,
    #[serde(flatten)]
    payload: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppVersion {
    app_version: String,
    rust_target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpikeCheck {
    label: String,
    detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationInspectRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    legacy_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationInspection {
    project_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationWorkspaceSelection {
    selected: bool,
    legacy_root: Option<String>,
    project_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationRunRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    legacy_root: String,
    project_id: String,
    target_project_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationNativeRunRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    legacy_root: String,
    project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationNativeResult {
    report: migration::MigrationReport,
    project: ProjectManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMigrationInspectRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    legacy_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMigrationRunRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    legacy_root: String,
    app_data_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMigrationNativeRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    legacy_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderListRequest {
    #[serde(flatten)]
    version: VersionedRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSaveRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    #[serde(flatten)]
    provider: provider_settings::ProviderInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDeleteRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    provider_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderList {
    providers: Vec<provider_settings::ProviderSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunStartRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    file_ids: Vec<String>,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunListRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunCancelRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    run_id: String,
    now: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunList {
    runs: Vec<sion_agent::AgentRun>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCreateRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    id: String,
    name: String,
    customer_name: String,
    author_name: String,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectListRequest {
    #[serde(flatten)]
    version: VersionedRequest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCreateResult {
    created: bool,
    project: Option<ProjectManifest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectList {
    projects: Vec<RecentProject>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectNodeRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAgentOverrideSaveRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    markdown: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAgentOverride {
    markdown: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSaveNodeRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    expected_revision: u64,
    markdown: String,
    status: NodeStatus,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectApplyAssistantRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    assistant_message_id: String,
    expected_revision: u64,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPreviewAssistantRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    assistant_message_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantDeliveryPreview {
    assistant_message_id: String,
    node_id: WorkflowNodeId,
    current_revision: u64,
    markdown: String,
    additions: usize,
    deletions: usize,
    unchanged: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectExportRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectExportResult {
    exported: bool,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionListRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreateRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    name: String,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageListRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageAppendRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    message: ChatMessage,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileListRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileImportRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    now: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileImportResult {
    imported: bool,
    file: Option<ProjectFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionList {
    sessions: Vec<ChatSession>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageList {
    messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    files: Vec<ProjectFile>,
}

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("IPC API version {received} is unsupported; expected {expected}")]
    UnsupportedApiVersion { received: u16, expected: u16 },
    #[error("{0}")]
    CheckFailed(String),
}

impl Serialize for ApiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

fn assert_api_version(request: &VersionedRequest) -> Result<(), ApiError> {
    if request.api_version == API_VERSION {
        Ok(())
    } else {
        Err(ApiError::UnsupportedApiVersion {
            received: request.api_version,
            expected: API_VERSION,
        })
    }
}

#[tauri::command]
fn app_get_version(
    request: VersionedRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<AppVersion>, ApiError> {
    assert_api_version(&request)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: AppVersion {
            app_version: app.package_info().version.to_string(),
            rust_target: std::env::consts::ARCH.to_string(),
        },
    })
}

#[tauri::command]
fn spike_docx_check(request: VersionedRequest) -> Result<VersionedResponse<SpikeCheck>, ApiError> {
    assert_api_version(&request)?;
    docx_check::round_trip_check().map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: SpikeCheck {
            label: "DOCX round trip passed".to_string(),
            detail: "生成、解包与中文正文检查均通过".to_string(),
        },
    })
}

#[tauri::command]
fn spike_keyring_check(
    request: VersionedRequest,
) -> Result<VersionedResponse<SpikeCheck>, ApiError> {
    assert_api_version(&request)?;
    keyring_check::round_trip_check().map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: SpikeCheck {
            label: "System credential round trip passed".to_string(),
            detail: "临时凭据已写入、读取并删除".to_string(),
        },
    })
}

#[tauri::command]
fn migration_inspect(
    request: MigrationInspectRequest,
) -> Result<VersionedResponse<MigrationInspection>, ApiError> {
    assert_api_version(&request.version)?;
    let project_ids = migration::inspect_legacy_workspace(Path::new(&request.legacy_root))
        .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: MigrationInspection { project_ids },
    })
}

#[tauri::command]
async fn migration_pick_workspace(
    request: VersionedRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<MigrationWorkspaceSelection>, ApiError> {
    assert_api_version(&request)?;
    let Some(root) = app.dialog().file().blocking_pick_folder() else {
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: MigrationWorkspaceSelection {
                selected: false,
                legacy_root: None,
                project_ids: Vec::new(),
            },
        });
    };
    let root = root.into_path().map_err(|error| {
        ApiError::CheckFailed(format!(
            "selected legacy workspace is not a local path: {error}"
        ))
    })?;
    let project_ids = migration::inspect_legacy_workspace(&root).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: MigrationWorkspaceSelection {
            selected: true,
            legacy_root: Some(root.to_string_lossy().into_owned()),
            project_ids,
        },
    })
}

#[tauri::command]
fn migration_run(
    request: MigrationRunRequest,
) -> Result<VersionedResponse<migration::MigrationReport>, ApiError> {
    assert_api_version(&request.version)?;
    let report = migration::migrate_legacy_project(
        Path::new(&request.legacy_root),
        &request.project_id,
        Path::new(&request.target_project_root),
    )
    .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: report,
    })
}

#[tauri::command]
async fn migration_run_native(
    request: MigrationNativeRunRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<MigrationNativeResult>, ApiError> {
    assert_api_version(&request.version)?;
    let Some(target) = app.dialog().file().blocking_pick_folder() else {
        return Err(ApiError::CheckFailed(
            "migration target directory selection was cancelled".to_string(),
        ));
    };
    let target = target.into_path().map_err(|error| {
        ApiError::CheckFailed(format!(
            "selected project directory is not a local path: {error}"
        ))
    })?;
    let report = migration::migrate_legacy_project(
        Path::new(&request.legacy_root),
        &request.project_id,
        &target,
    )
    .map_err(ApiError::CheckFailed)?;
    let store = ProjectStore::at(&target);
    let project = store
        .manifest()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    ProjectRegistry::at(app_data_root)
        .register(&project, target, project.updated_at.clone())
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: MigrationNativeResult { report, project },
    })
}

#[tauri::command]
fn provider_migration_inspect(
    request: ProviderMigrationInspectRequest,
) -> Result<VersionedResponse<provider_migration::ProviderMigrationInspection>, ApiError> {
    assert_api_version(&request.version)?;
    let inspection = provider_migration::inspect_legacy_providers(Path::new(&request.legacy_root))
        .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: inspection,
    })
}

#[tauri::command]
fn provider_migration_run(
    request: ProviderMigrationRunRequest,
) -> Result<VersionedResponse<provider_migration::ProviderMigrationReport>, ApiError> {
    assert_api_version(&request.version)?;
    let report = provider_migration::migrate_legacy_providers(
        Path::new(&request.legacy_root),
        Path::new(&request.app_data_root),
    )
    .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: report,
    })
}

#[tauri::command]
fn provider_migration_run_native(
    request: ProviderMigrationNativeRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<provider_migration::ProviderMigrationReport>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    let report = provider_migration::migrate_legacy_providers(
        Path::new(&request.legacy_root),
        &app_data_root,
    )
    .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: report,
    })
}

#[tauri::command]
fn provider_list(
    request: ProviderListRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProviderList>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    let providers = provider_settings::list(&app_data_root).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProviderList { providers },
    })
}

#[tauri::command]
fn provider_save(
    request: ProviderSaveRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<provider_settings::ProviderSummary>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    let provider =
        provider_settings::save(&app_data_root, request.provider).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: provider,
    })
}

#[tauri::command]
fn provider_delete(
    request: ProviderDeleteRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<()>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    provider_settings::delete(&app_data_root, &request.provider_id)
        .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: (),
    })
}

#[tauri::command]
fn agent_run_start(
    request: AgentRunStartRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<VersionedResponse<sion_agent::AgentRun>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    let model =
        provider_settings::resolve_default_model(&app_data_root).map_err(ApiError::CheckFailed)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(&project_root);
    let node = store
        .node(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let messages = store
        .messages(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let project_override = store
        .agent_override(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let attachments = selected_file_context(&store, &request.file_ids)?;
    let prompt = agent_prompt(&node, &messages, project_override.as_deref(), &attachments);
    let run = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?
        .enqueue(request.project_id.clone(), request.node_id, request.now)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    store
        .save_run(&run)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let job = AgentJob {
        project_root,
        session_id: request.session_id,
        prompt,
        model,
        cancellation: CancellationToken::new(),
    };
    state
        .jobs
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent job lock is poisoned".to_string()))?
        .insert(run.id.clone(), job.clone());
    if run.status == sion_agent::AgentRunStatus::Running {
        spawn_agent_run(app, state.inner().clone(), run.clone(), job);
    }
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: run,
    })
}

#[tauri::command]
fn agent_run_list(
    request: AgentRunListRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<AgentRunList>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let runs = ProjectStore::at(project_root)
        .list_runs()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: AgentRunList { runs },
    })
}

#[tauri::command]
fn agent_run_cancel(
    request: AgentRunCancelRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<VersionedResponse<sion_agent::AgentRun>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let job = state
        .jobs
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent job lock is poisoned".to_string()))?
        .get(&request.run_id)
        .cloned()
        .ok_or_else(|| ApiError::CheckFailed("agent run was not found".to_string()))?;
    let status = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?
        .get(&request.run_id)
        .map(|run| run.status.clone())
        .ok_or_else(|| ApiError::CheckFailed("agent run was not found".to_string()))?;
    if status == sion_agent::AgentRunStatus::Queued {
        let promoted = state
            .scheduler
            .lock()
            .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?
            .cancel(&request.run_id, request.now, Some("用户取消".to_string()))
            .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
        let cancelled = state
            .scheduler
            .lock()
            .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?
            .get(&request.run_id)
            .cloned()
            .ok_or_else(|| ApiError::CheckFailed("agent run was not found".to_string()))?;
        ProjectStore::at(&project_root)
            .save_run(&cancelled)
            .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
        state
            .jobs
            .lock()
            .map_err(|_| ApiError::CheckFailed("agent job lock is poisoned".to_string()))?
            .remove(&request.run_id);
        spawn_promoted_runs(app, state.inner().clone(), promoted);
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: cancelled,
        });
    }
    job.cancellation.cancel();
    let run = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?
        .get(&request.run_id)
        .cloned()
        .ok_or_else(|| ApiError::CheckFailed("agent run was not found".to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: run,
    })
}

#[tauri::command]
async fn project_create(
    request: ProjectCreateRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProjectCreateResult>, ApiError> {
    assert_api_version(&request.version)?;
    let Some(project_root) = app.dialog().file().blocking_pick_folder() else {
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: ProjectCreateResult {
                created: false,
                project: None,
            },
        });
    };
    let project_root = project_root.into_path().map_err(|error| {
        ApiError::CheckFailed(format!(
            "selected project directory is not a local path: {error}"
        ))
    })?;
    let manifest = ProjectStore::at(&project_root)
        .create(CreateProjectInput {
            id: request.id,
            name: request.name,
            customer_name: request.customer_name,
            author_name: request.author_name,
            now: request.now,
        })
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    ProjectRegistry::at(app_data_root)
        .register(&manifest, project_root, manifest.updated_at.clone())
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProjectCreateResult {
            created: true,
            project: Some(manifest),
        },
    })
}

#[tauri::command]
fn project_list(
    request: ProjectListRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProjectList>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    let projects = ProjectRegistry::at(app_data_root)
        .list()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProjectList { projects },
    })
}

#[tauri::command]
fn project_get_node(
    request: ProjectNodeRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<WorkflowNode>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let node = ProjectStore::at(project_root)
        .node(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: node,
    })
}

#[tauri::command]
fn project_get_agent_override(
    request: ProjectNodeRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProjectAgentOverride>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let markdown = ProjectStore::at(project_root)
        .agent_override(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProjectAgentOverride { markdown },
    })
}

#[tauri::command]
fn project_save_agent_override(
    request: ProjectAgentOverrideSaveRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProjectAgentOverride>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let markdown = ProjectStore::at(project_root)
        .save_agent_override(request.node_id, request.markdown)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProjectAgentOverride { markdown },
    })
}

#[tauri::command]
fn project_save_node(
    request: ProjectSaveNodeRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<SaveNodeResult>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let result = ProjectStore::at(project_root)
        .save_node_if_revision(
            request.node_id,
            request.expected_revision,
            request.markdown,
            request.status,
            request.now,
        )
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: result,
    })
}

#[tauri::command]
fn project_preview_assistant_delivery(
    request: ProjectPreviewAssistantRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<AssistantDeliveryPreview>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(project_root);
    let node = store
        .node(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let markdown = assistant_delivery_markdown(
        &store,
        request.node_id,
        &request.session_id,
        &request.assistant_message_id,
        &node.markdown,
    )?;
    let stats = line_change_stats(&node.markdown, &markdown);
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: AssistantDeliveryPreview {
            assistant_message_id: request.assistant_message_id,
            node_id: request.node_id,
            current_revision: node.revision,
            markdown,
            additions: stats.additions,
            deletions: stats.deletions,
            unchanged: stats.unchanged,
        },
    })
}

#[tauri::command]
fn project_apply_assistant(
    request: ProjectApplyAssistantRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<SaveNodeResult>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(project_root);
    let node = store
        .node(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let markdown = assistant_delivery_markdown(
        &store,
        request.node_id,
        &request.session_id,
        &request.assistant_message_id,
        &node.markdown,
    )?;
    let result = store
        .save_node_if_revision(
            request.node_id,
            request.expected_revision,
            markdown,
            NodeStatus::Generated,
            request.now,
        )
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: result,
    })
}

fn assistant_delivery_markdown(
    store: &ProjectStore,
    node_id: WorkflowNodeId,
    session_id: &str,
    assistant_message_id: &str,
    current_markdown: &str,
) -> Result<String, ApiError> {
    let message = store
        .messages(node_id, session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?
        .into_iter()
        .find(|message| message.id == assistant_message_id)
        .ok_or_else(|| {
            ApiError::CheckFailed("assistant message was not found in this session".to_string())
        })?;
    if message.role != ChatRole::Assistant {
        return Err(ApiError::CheckFailed(
            "only an assistant message can produce a node delivery".to_string(),
        ));
    }
    apply_agent_delivery(&message.content, node_id, current_markdown)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))
}

#[derive(Debug, PartialEq, Eq)]
struct LineChangeStats {
    additions: usize,
    deletions: usize,
    unchanged: usize,
}

fn line_change_stats(before: &str, after: &str) -> LineChangeStats {
    let before_lines = before.lines().collect::<Vec<_>>();
    let after_lines = after.lines().collect::<Vec<_>>();
    let mut previous = vec![0; after_lines.len() + 1];
    let mut current = vec![0; after_lines.len() + 1];
    for before_line in &before_lines {
        for (index, after_line) in after_lines.iter().enumerate() {
            current[index + 1] = if before_line == after_line {
                previous[index] + 1
            } else {
                previous[index + 1].max(current[index])
            };
        }
        std::mem::swap(&mut previous, &mut current);
        current.fill(0);
    }
    let unchanged = previous[after_lines.len()];
    LineChangeStats {
        additions: after_lines.len().saturating_sub(unchanged),
        deletions: before_lines.len().saturating_sub(unchanged),
        unchanged,
    }
}

#[tauri::command]
async fn project_export_docx(
    request: ProjectExportRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProjectExportResult>, ApiError> {
    assert_api_version(&request.version)?;
    let Some(target) = app.dialog().file().blocking_save_file() else {
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: ProjectExportResult {
                exported: false,
                path: None,
            },
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
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(project_root);
    let manifest = store
        .manifest()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let nodes = store
        .list_nodes()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    project_export::write_docx(&target, &manifest, &nodes).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProjectExportResult {
            exported: true,
            path: Some(target.to_string_lossy().into_owned()),
        },
    })
}

#[tauri::command]
fn session_list(
    request: SessionListRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<SessionList>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let sessions = ProjectStore::at(project_root)
        .list_sessions(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: SessionList { sessions },
    })
}

#[tauri::command]
fn session_create(
    request: SessionCreateRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ChatSession>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let session = ProjectStore::at(project_root)
        .create_session(request.node_id, request.name, request.now)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: session,
    })
}

#[tauri::command]
fn message_list(
    request: MessageListRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<MessageList>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let messages = ProjectStore::at(project_root)
        .messages(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: MessageList { messages },
    })
}

#[tauri::command]
fn message_append(
    request: MessageAppendRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ChatSession>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let session = ProjectStore::at(project_root)
        .append_message(
            request.node_id,
            &request.session_id,
            request.message,
            request.now,
        )
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: session,
    })
}

#[tauri::command]
fn file_list(
    request: FileListRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<FileList>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let files = ProjectStore::at(project_root)
        .list_files()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: FileList { files },
    })
}

#[tauri::command]
async fn file_import(
    request: FileImportRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<FileImportResult>, ApiError> {
    assert_api_version(&request.version)?;
    let Some(source) = app.dialog().file().blocking_pick_file() else {
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: FileImportResult {
                imported: false,
                file: None,
            },
        });
    };
    let source = source.into_path().map_err(|error| {
        ApiError::CheckFailed(format!("selected source file is not a local path: {error}"))
    })?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let file = ProjectStore::at(project_root)
        .import_file(&source, request.now)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: FileImportResult {
            imported: true,
            file: Some(file),
        },
    })
}

fn agent_prompt(
    node: &WorkflowNode,
    messages: &[ChatMessage],
    project_override: Option<&str>,
    attachments: &[(String, String)],
) -> String {
    let transcript = messages
        .iter()
        .rev()
        .take(16)
        .rev()
        .map(|message| {
            format!(
                "{}: {}",
                match message.role {
                    ChatRole::User => "用户",
                    ChatRole::Assistant => "助手",
                    ChatRole::System => "系统",
                },
                message.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let override_block = project_override
        .filter(|rule| !rule.trim().is_empty())
        .map(|rule| format!("\n\n# 项目覆盖规则\n{rule}"))
        .unwrap_or_default();
    let attachment_block = attachments
        .iter()
        .map(|(name, text)| format!("## {name}\n{text}"))
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "你是 Sion 桌面应用中负责项目设计文档的助手。不要浏览网页、不要声称调用过外部搜索。请基于当前节点、选定文件和会话，给出可直接用于设计文档的中文建议。\n\n必须在回复末尾提供且只提供一个 fenced delivery JSON 交付块。默认使用分节补丁，格式为：```delivery\n{{\"mode\":\"patch\",\"sections\":[{{\"title\":\"当前已有的二级章节名\",\"content\":\"该章节的新内容，不含 # 或 ## 标题\"}}]}}\n```。`title` 必须精确匹配当前 Markdown 中本节点已有的必填二级标题；`content` 只能包含该章节正文，可使用三级标题，不能包含一级或二级标题。只提交需要改动的章节。\n\n兼容例外：只有当用户明确要求整篇重写时，才可用 `{{\"mode\":\"rewrite\",\"markdown\":\"完整节点 Markdown\"}}`，且必须保留本节点所有必填二级标题。\n\n# 本节点规则\n{}{}\n\n# 选定文件\n{}\n\n# 当前节点\n{}\n\n# 当前 Markdown\n{}\n\n# 会话\n{}",
        sion_core::agent_rule(node.id),
        override_block,
        attachment_block,
        node.id.as_str(),
        node.markdown,
        transcript
    )
}

fn selected_file_context(
    store: &ProjectStore,
    file_ids: &[String],
) -> Result<Vec<(String, String)>, ApiError> {
    const MAX_TOTAL_CHARS: usize = 48_000;
    const MAX_PER_FILE_CHARS: usize = 12_000;
    let files = store
        .list_files()
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let mut seen = HashSet::new();
    let mut remaining = MAX_TOTAL_CHARS;
    let mut result = Vec::new();
    for id in file_ids {
        if !seen.insert(id) || remaining == 0 {
            continue;
        }
        let file = files
            .iter()
            .find(|file| file.id == *id)
            .ok_or_else(|| ApiError::CheckFailed(format!("selected file {id} was not found")))?;
        let text = store
            .read_file_text(id)
            .map_err(|error| ApiError::CheckFailed(error.to_string()))?
            .ok_or_else(|| {
                ApiError::CheckFailed(format!(
                    "selected file {} has no extracted text",
                    file.original_name
                ))
            })?;
        let excerpt = text
            .chars()
            .take(remaining.min(MAX_PER_FILE_CHARS))
            .collect::<String>();
        remaining -= excerpt.chars().count();
        result.push((file.original_name.clone(), excerpt));
    }
    Ok(result)
}

fn spawn_agent_run(
    app: tauri::AppHandle,
    state: Arc<AgentState>,
    run: sion_agent::AgentRun,
    job: AgentJob,
) {
    tauri::async_runtime::spawn(async move {
        let protocol = match job.model.protocol.as_str() {
            "chat_completions" => sion_agent::model_stream::ProviderProtocol::ChatCompletions,
            "openai_responses" => sion_agent::model_stream::ProviderProtocol::OpenaiResponses,
            _ => {
                complete_agent_run(
                    &app,
                    &state,
                    &run,
                    &job,
                    Err("unsupported provider protocol".to_string()),
                );
                return;
            }
        };
        let event_app = app.clone();
        let event_run = run.clone();
        let event_session = job.session_id.clone();
        let stream = sion_agent::model_stream::stream_text_with(
            &state.client,
            &sion_agent::model_stream::StreamRequest {
                endpoint: job.model.endpoint.clone(),
                api_key: job.model.api_key.clone(),
                protocol,
                model: job.model.model.clone(),
                prompt: job.prompt.clone(),
            },
            job.cancellation.clone(),
            move |delta| {
                let _ = event_app.emit(
                    "agent-token",
                    AgentTokenEvent {
                        run_id: event_run.id.clone(),
                        project_id: event_run.project_id.clone(),
                        node_id: event_run.node_id,
                        session_id: event_session.clone(),
                        delta: delta.to_string(),
                    },
                );
            },
        )
        .await;
        complete_agent_run(&app, &state, &run, &job, stream);
    });
}

fn complete_agent_run(
    app: &tauri::AppHandle,
    state: &Arc<AgentState>,
    run: &sion_agent::AgentRun,
    job: &AgentJob,
    outcome: Result<sion_agent::model_stream::StreamOutcome, String>,
) {
    let finished_at = run.created_at.clone();
    let completion = completion_from_stream(outcome);
    let (final_run, promoted) = {
        let Ok(mut scheduler) = state.scheduler.lock() else {
            return;
        };
        let transition = match completion {
            Ok((cancelled, content)) if cancelled => scheduler
                .cancel(
                    &run.id,
                    finished_at.clone(),
                    Some("已取消；部分输出不会自动写入节点".to_string()),
                )
                .map(|promoted| (promoted, content)),
            Ok((_cancelled, content)) => scheduler
                .complete(
                    &run.id,
                    finished_at.clone(),
                    Some(format!(
                        "已使用 {} 的模型回复并保存到本地会话",
                        job.model.provider_id
                    )),
                )
                .map(|promoted| (promoted, content)),
            Err(error) => scheduler
                .fail(
                    &run.id,
                    finished_at.clone(),
                    format!("模型调用失败：{error}"),
                )
                .map(|promoted| (promoted, None)),
        };
        let Ok((promoted, content)) = transition else {
            return;
        };
        let Some(final_run) = scheduler.get(&run.id).cloned() else {
            return;
        };
        (final_run, (promoted, content))
    };
    let (promoted, content) = promoted;
    let store = ProjectStore::at(&job.project_root);
    if let Some(content) = content.filter(|content| !content.is_empty()) {
        let _ = store.append_message(
            run.node_id,
            &job.session_id,
            ChatMessage {
                id: uuid::Uuid::new_v4().to_string(),
                role: ChatRole::Assistant,
                content,
                reasoning_content: None,
                sources: None,
                created_at: finished_at.clone(),
                turn_id: Some(run.id.clone()),
                reasoning_duration_ms: None,
                usage: None,
            },
            finished_at.clone(),
        );
    }
    let _ = store.save_run(&final_run);
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.remove(&run.id);
    }
    let _ = app.emit("agent-run-finished", AgentFinishedEvent { run: final_run });
    spawn_promoted_runs(app.clone(), state.clone(), promoted);
}

/// A cancelled stream may be shown transiently in the UI, but is never an
/// assistant message on disk. This makes a retry unambiguous and prevents a
/// user from mistaking a truncated draft for a completed answer.
fn completion_from_stream(
    outcome: Result<sion_agent::model_stream::StreamOutcome, String>,
) -> Result<(bool, Option<String>), String> {
    match outcome {
        Ok(sion_agent::model_stream::StreamOutcome::Completed(tokens)) => {
            Ok((false, Some(tokens.join(""))))
        }
        Ok(sion_agent::model_stream::StreamOutcome::Cancelled(_)) => Ok((true, None)),
        Err(error) => Err(error),
    }
}

fn spawn_promoted_runs(
    app: tauri::AppHandle,
    state: Arc<AgentState>,
    promoted: Vec<sion_agent::AgentRun>,
) {
    for run in promoted {
        let job = state
            .jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(&run.id).cloned());
        if let Some(job) = job {
            spawn_agent_run(app.clone(), state.clone(), run, job);
        }
    }
}

fn resolve_registered_project_root(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<std::path::PathBuf, ApiError> {
    let app_data_root = app.path().app_data_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine app data directory: {error}"))
    })?;
    ProjectRegistry::at(app_data_root)
        .resolve(project_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AgentState::default()))
        .invoke_handler(tauri::generate_handler![
            app_get_version,
            spike_docx_check,
            spike_keyring_check,
            migration_inspect,
            migration_run,
            migration_pick_workspace,
            migration_run_native,
            provider_migration_inspect,
            provider_migration_run,
            provider_migration_run_native,
            provider_list,
            provider_save,
            provider_delete,
            agent_run_start,
            agent_run_list,
            agent_run_cancel,
            project_create,
            project_list,
            project_get_node,
            project_get_agent_override,
            project_save_agent_override,
            project_save_node,
            project_preview_assistant_delivery,
            project_apply_assistant,
            project_export_docx,
            session_list,
            session_create,
            message_list,
            message_append,
            file_list,
            file_import
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Sion desktop spike");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_unknown_ipc_version() {
        let error = assert_api_version(&VersionedRequest { api_version: 2 }).unwrap_err();
        assert!(error.to_string().contains("unsupported"));
    }

    #[test]
    fn accepts_the_current_ipc_version() {
        assert!(
            assert_api_version(&VersionedRequest {
                api_version: API_VERSION
            })
            .is_ok()
        );
    }

    #[test]
    fn cancelled_streams_never_produce_a_persistable_assistant_message() {
        let completion = completion_from_stream(Ok(
            sion_agent::model_stream::StreamOutcome::Cancelled(vec!["partial".to_string()]),
        ))
        .unwrap();
        assert_eq!(completion, (true, None));
    }

    #[test]
    fn line_change_stats_counts_kept_added_and_deleted_lines() {
        let stats = line_change_stats("A\nB\nC", "A\nB2\nC\nD");
        assert_eq!(
            stats,
            LineChangeStats {
                additions: 2,
                deletions: 1,
                unchanged: 2,
            }
        );
    }

    #[test]
    fn agent_prompt_embeds_the_selected_node_rule() {
        let node = WorkflowNode {
            id: WorkflowNodeId::BasicInfo,
            status: NodeStatus::Draft,
            markdown: "# 项目基本信息".to_string(),
            revision: 0,
            updated_at: "now".to_string(),
        };
        let prompt = agent_prompt(
            &node,
            &[],
            Some("只写确认事实"),
            &[("资料.txt".to_string(), "资料正文".to_string())],
        );
        assert!(prompt.contains("你只负责项目基本信息"));
        assert!(prompt.contains("只写确认事实"));
        assert!(prompt.contains("资料正文"));
        assert!(prompt.contains("不要浏览网页"));
        assert!(prompt.contains("```delivery"));
    }
}
