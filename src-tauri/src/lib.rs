mod app_paths;
mod app_settings;
pub mod docx_check;
pub mod docx_preview;
pub mod export_documents;
mod export_runtime;
mod project_export;
mod provider_settings;
mod run_detail;

use serde::{Deserialize, Serialize};
use sion_core::{
    AgentDelivery, ChatMessage, ChatModelSelection, ChatRole, ChatSession,
    ConversationContextSnapshot, ConversationTurn, DeliveryOutcome, DeliveryStage, NodeStatus,
    ProjectFile, ProjectManifest, ReasoningEffort, TurnStatus, WorkflowNode, WorkflowNodeId,
};
use sion_storage::{
    CreateProjectInput, FilePreview, ProjectDiscovery, ProjectRegistry, ProjectStore,
    RecentProject, SaveNodeResult,
};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

mod conversation_runtime;
mod turn_runtime;
use conversation_runtime::{EffectiveAgentRules, compose_effective_agent_rules};

const API_VERSION: u16 = 1;

fn utc_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

struct AgentState {
    scheduler: Mutex<sion_agent::RunScheduler>,
    jobs: Mutex<HashMap<String, AgentJob>>,
    regenerations: Mutex<HashMap<String, RegenerationJob>>,
    client: reqwest::Client,
}

#[derive(Default)]
struct SettingsState {
    mutation: Mutex<()>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            scheduler: Mutex::new(sion_agent::RunScheduler::default()),
            jobs: Mutex::new(HashMap::new()),
            regenerations: Mutex::new(HashMap::new()),
            client: reqwest::Client::new(),
        }
    }
}

#[derive(Clone)]
struct AgentJob {
    project_root: PathBuf,
    #[allow(dead_code)]
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    prompt: String,
    model: provider_settings::ResolvedModel,
    reasoning_effort: ReasoningEffort,
    cancellation: CancellationToken,
    turn_id: String,
    expected_revision: u64,
    delivery_write_allowed: bool,
    started_instant: Instant,
}

#[derive(Clone)]
struct RegenerationJob {
    generation: DeliveryGeneration,
    project_root: PathBuf,
    node_id: WorkflowNodeId,
    expected_revision: u64,
    prompt: String,
    model: provider_settings::ResolvedModel,
    reasoning_effort: ReasoningEffort,
    cancellation: CancellationToken,
    candidate: Arc<Mutex<String>>,
    started_instant: Instant,
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
struct AgentReasoningSummaryEvent {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunStartResult {
    run: sion_agent::AgentRun,
    turn: ConversationTurn,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum AgentRunStartOutcome {
    Started {
        run: Box<sion_agent::AgentRun>,
        turn: Box<ConversationTurn>,
    },
    ContextBlocked {
        snapshot: ConversationContextSnapshot,
        excess_tokens: u64,
        largest_section: String,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConversationTurnEvent {
    turn: ConversationTurn,
    #[serde(skip_serializing_if = "Option::is_none")]
    saved_node: Option<WorkflowNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTurnList {
    turns: Vec<ConversationTurn>,
}

#[derive(Debug, Serialize, Deserialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSummary {
    projects_directory: Option<String>,
    ui: app_settings::UiSettings,
}

fn settings_summary(settings: &app_settings::AppSettings) -> SettingsSummary {
    SettingsSummary {
        projects_directory: settings
            .projects_directory
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        ui: settings.ui.clone(),
    }
}

#[derive(Debug)]
struct FileManagerCommand {
    program: &'static str,
    arguments: Vec<OsString>,
}

#[cfg(target_os = "macos")]
fn file_manager_command(path: &Path) -> Result<FileManagerCommand, ApiError> {
    Ok(FileManagerCommand {
        program: "open",
        arguments: vec![path.as_os_str().to_owned()],
    })
}

#[cfg(target_os = "windows")]
fn file_manager_command(path: &Path) -> Result<FileManagerCommand, ApiError> {
    Ok(FileManagerCommand {
        program: "explorer",
        arguments: vec![path.as_os_str().to_owned()],
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn file_manager_command(_path: &Path) -> Result<FileManagerCommand, ApiError> {
    Err(ApiError::CheckFailed(
        "revealing projects is unsupported on this platform".to_string(),
    ))
}

/// Builds the native folder picker for choosing a projects container, seeded
/// with the saved projects directory when it still exists on disk. A stale
/// directory falls back to the operating system's default location.
fn project_directory_dialog(
    app: &tauri::AppHandle,
    settings: &app_settings::AppSettings,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    match app_settings::usable_projects_directory(settings) {
        Some(path) => app.dialog().file().set_directory(path),
        None => app.dialog().file(),
    }
}

/// Resolves the single global Sion configuration root (`~/.sion/`) for the
/// current user. All application-level state lives here; project data does not.
fn sion_root(app: &tauri::AppHandle) -> Result<PathBuf, ApiError> {
    let home = app.path().home_dir().map_err(|error| {
        ApiError::CheckFailed(format!("cannot determine user home directory: {error}"))
    })?;
    Ok(app_paths::global_sion_root(&home))
}

/// Returns the configured projects container, rejecting a missing or stale
/// directory so the caller can prompt the user to choose one.
fn configured_projects_directory(settings: &app_settings::AppSettings) -> Result<&Path, ApiError> {
    app_settings::usable_projects_directory(settings).ok_or_else(|| {
        ApiError::CheckFailed("choose an available project container first".to_string())
    })
}

/// Creates a project inside the saved container and records a recent-open
/// timestamp. Project creation never opens a folder picker: the container is
/// chosen once and reused, so multiple projects become UUID siblings.
fn create_project_from_settings(
    root: &Path,
    request: ProjectCreateRequest,
) -> Result<ProjectManifest, ApiError> {
    let settings = app_settings::load(root).map_err(ApiError::CheckFailed)?;
    let directory = configured_projects_directory(&settings)?;
    let manifest = ProjectStore::create_in(
        directory,
        CreateProjectInput {
            id: request.id,
            name: request.name,
            customer_name: request.customer_name,
            author_name: request.author_name,
            now: request.now,
        },
    )
    .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    ProjectRegistry::at(root)
        .register(
            &manifest,
            directory.join(&manifest.id),
            manifest.updated_at.clone(),
        )
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(manifest)
}

/// Lists projects by discovering directories on disk under the saved container.
/// The registry only contributes recent-open timestamps; unregistered projects
/// are still listed. An unset container yields an empty list rather than an
/// error so the UI can prompt the user to choose one.
fn list_projects_from_settings(root: &Path) -> Result<ProjectDiscovery, ApiError> {
    let settings = app_settings::load(root).map_err(ApiError::CheckFailed)?;
    let Some(configured) = settings.projects_directory.as_deref() else {
        return Ok(ProjectDiscovery {
            projects: Vec::new(),
            warnings: Vec::new(),
        });
    };
    if !configured.is_dir() {
        return Err(ApiError::CheckFailed(format!(
            "configured project container is unavailable: {}",
            configured.display()
        )));
    }
    ProjectRegistry::at(root)
        .discover(configured)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSetDefaultRequest {
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
    message: String,
    file_ids: Vec<String>,
    expected_revision: u64,
    delivery_write_allowed: bool,
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
struct AgentRunDetailRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    run_id: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRevealRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRevealResult {
    revealed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSaveUiRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    ui: app_settings::UiSettings,
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
    warnings: Vec<String>,
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
    model_selection: Option<ChatModelSelection>,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionModelUpdateRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    model_selection: ChatModelSelection,
    now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDeleteRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationContextGetRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    model_selection: ChatModelSelection,
    file_ids: Vec<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePreviewRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    file_id: String,
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
fn provider_list(
    request: ProviderListRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProviderList>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = sion_root(&app)?;
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
    let app_data_root = sion_root(&app)?;
    let provider =
        provider_settings::save(&app_data_root, request.provider).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: provider,
    })
}

#[tauri::command]
fn provider_set_default(
    request: ProviderSetDefaultRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<provider_settings::ProviderSummary>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = sion_root(&app)?;
    let provider = provider_settings::set_default(&app_data_root, &request.provider_id)
        .map_err(ApiError::CheckFailed)?;
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
    let app_data_root = sion_root(&app)?;
    provider_settings::delete(&app_data_root, &request.provider_id)
        .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: (),
    })
}

#[derive(Debug)]
struct PreparedSend {
    resolved: provider_settings::ResolvedModel,
    selection: ChatModelSelection,
    prompt: String,
    snapshot: ConversationContextSnapshot,
    user_message: ChatMessage,
    file_ids: Vec<String>,
    turn_id: String,
    session_id: String,
}

impl PreparedSend {
    fn run_request(
        &self,
        project_id: String,
        node_id: WorkflowNodeId,
        created_at: String,
    ) -> sion_agent::RunRequest {
        sion_agent::RunRequest {
            project_id,
            node_id,
            provider_id: self.selection.provider_id.clone(),
            model: self.selection.model.clone(),
            reasoning_effort: self.selection.reasoning_effort,
            file_ids: self.file_ids.clone(),
            kind: sion_agent::AgentRunKind::Conversation,
            created_at,
            session_id: Some(self.session_id.clone()),
            turn_id: Some(self.turn_id.clone()),
            context_snapshot: Some(self.snapshot.clone()),
        }
    }
}

#[derive(Debug)]
struct SendPersistenceError {
    message: String,
    promoted: Vec<sion_agent::AgentRun>,
}

#[allow(clippy::too_many_arguments)]
fn persist_prepared_send(
    store: &ProjectStore,
    scheduler: &mut sion_agent::RunScheduler,
    run_request: sion_agent::RunRequest,
    node_id: WorkflowNodeId,
    session_id: &str,
    user_message: ChatMessage,
    turn_id: String,
    expected_revision: u64,
    delivery_write_allowed: bool,
    now: String,
) -> Result<AgentRunStartResult, SendPersistenceError> {
    let _ = (expected_revision, delivery_write_allowed);
    scheduler
        .ensure_available(&run_request.project_id, node_id)
        .map_err(|error| SendPersistenceError {
            message: error.to_string(),
            promoted: Vec::new(),
        })?;
    let run = scheduler
        .enqueue(run_request)
        .map_err(|error| SendPersistenceError {
            message: error.to_string(),
            promoted: Vec::new(),
        })?;
    if let Err(error) = store.save_run(&run) {
        let promoted = scheduler
            .cancel(&run.id, now, Some("运行记录保存失败".into()))
            .unwrap_or_default();
        return Err(SendPersistenceError {
            message: error.to_string(),
            promoted,
        });
    }
    let running = run.status == sion_agent::AgentRunStatus::Running;
    let turn = ConversationTurn {
        id: turn_id,
        project_id: run.project_id.clone(),
        node_id,
        session_id: session_id.to_string(),
        run_id: run.id.clone(),
        user_message_id: user_message.id.clone(),
        assistant_message_id: None,
        status: if running {
            TurnStatus::Running
        } else {
            TurnStatus::Queued
        },
        activities: if running {
            turn_runtime::running_activities(&now)
        } else {
            Vec::new()
        },
        reasoning_summary: None,
        delivery_outcome: DeliveryOutcome::Pending,
        started_at: now.clone(),
        finished_at: None,
    };
    if let Err(error) =
        store.begin_turn(node_id, session_id, user_message, turn.clone(), now.clone())
    {
        let promoted = scheduler
            .cancel(&run.id, now, Some("用户消息保存失败".into()))
            .unwrap_or_default();
        if let Some(cancelled) = scheduler.get(&run.id) {
            let _ = store.save_run(cancelled);
        }
        return Err(SendPersistenceError {
            message: error.to_string(),
            promoted,
        });
    }
    Ok(AgentRunStartResult { run, turn })
}

fn prepare_agent_send(
    provider_root: &Path,
    store: &ProjectStore,
    node_id: WorkflowNodeId,
    session_id: &str,
    message: &str,
    file_ids: &[String],
    now: &str,
) -> Result<PreparedSend, String> {
    let session = store
        .session(node_id, session_id)
        .map_err(|error| error.to_string())?;
    let selection = match session.model_selection {
        Some(selection) => selection,
        None => provider_settings::default_selection(provider_root)?,
    };
    let resolved =
        provider_settings::resolve_model(provider_root, &selection.provider_id, &selection.model)?;
    let prepared = conversation_runtime::prepare_conversation(
        store,
        node_id,
        Some(session_id),
        message,
        file_ids,
        resolved.context_window_tokens,
        now,
    )?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    let user_message = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: ChatRole::User,
        content: message.to_string(),
        reasoning_content: None,
        sources: None,
        created_at: now.to_string(),
        turn_id: Some(turn_id.clone()),
        reasoning_duration_ms: None,
        usage: None,
        attachments: prepared.attachments.clone(),
        model_execution: None,
    };
    Ok(PreparedSend {
        resolved,
        selection,
        prompt: prepared.prompt,
        snapshot: prepared.snapshot,
        user_message,
        file_ids: file_ids.to_vec(),
        turn_id,
        session_id: session_id.to_string(),
    })
}

#[tauri::command]
fn agent_run_start(
    request: AgentRunStartRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<VersionedResponse<AgentRunStartOutcome>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = sion_root(&app)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(&project_root);
    let prepared = prepare_agent_send(
        &app_data_root,
        &store,
        request.node_id,
        &request.session_id,
        &request.message,
        &request.file_ids,
        &request.now,
    )
    .map_err(ApiError::CheckFailed)?;
    if prepared.snapshot.status == sion_core::ContextEstimateStatus::Blocked {
        let excess_tokens = prepared
            .snapshot
            .estimated_input_tokens
            .saturating_sub(prepared.snapshot.context_window_tokens);
        let largest_section = largest_context_section(&prepared.snapshot);
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: AgentRunStartOutcome::ContextBlocked {
                snapshot: prepared.snapshot,
                excess_tokens,
                largest_section,
            },
        });
    }
    if store
        .session(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?
        .model_selection
        .is_none()
    {
        store
            .update_session_model(
                request.node_id,
                &request.session_id,
                prepared.selection.clone(),
                request.now.clone(),
            )
            .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    }
    let run_request = prepared.run_request(
        request.project_id.clone(),
        request.node_id,
        request.now.clone(),
    );
    let mut scheduler = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?;
    let start_result = match persist_prepared_send(
        &store,
        &mut scheduler,
        run_request,
        request.node_id,
        &request.session_id,
        prepared.user_message.clone(),
        prepared.turn_id.clone(),
        request.expected_revision,
        request.delivery_write_allowed,
        request.now.clone(),
    ) {
        Ok(start_result) => start_result,
        Err(error) => {
            drop(scheduler);
            spawn_promoted_runs(app.clone(), state.inner().clone(), error.promoted);
            return Err(ApiError::CheckFailed(error.message));
        }
    };
    let job = AgentJob {
        project_root,
        project_id: request.project_id.clone(),
        node_id: request.node_id,
        session_id: request.session_id.clone(),
        prompt: prepared.prompt.clone(),
        model: prepared.resolved.clone(),
        reasoning_effort: prepared.selection.reasoning_effort,
        cancellation: CancellationToken::new(),
        turn_id: start_result.turn.id.clone(),
        expected_revision: request.expected_revision,
        delivery_write_allowed: request.delivery_write_allowed,
        started_instant: Instant::now(),
    };
    state
        .jobs
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent job lock is poisoned".to_string()))?
        .insert(start_result.run.id.clone(), job.clone());
    let should_spawn = start_result.run.status == sion_agent::AgentRunStatus::Running;
    drop(scheduler);
    if should_spawn {
        spawn_agent_run(app, state.inner().clone(), start_result.run.clone(), job);
    }
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: AgentRunStartOutcome::Started {
            run: Box::new(start_result.run),
            turn: Box::new(start_result.turn),
        },
    })
}

fn largest_context_section(snapshot: &ConversationContextSnapshot) -> String {
    let breakdown = &snapshot.breakdown;
    [
        ("protocol", breakdown.protocol_tokens),
        ("rules", breakdown.rules_tokens),
        ("node_markdown", breakdown.node_markdown_tokens),
        ("conversation", breakdown.conversation_tokens),
        ("attachment", breakdown.attachment_tokens),
    ]
    .into_iter()
    .max_by_key(|(_, tokens)| *tokens)
    .map(|(section, _)| section.to_string())
    .unwrap_or_else(|| "protocol".to_string())
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

fn load_run_detail(
    store: &ProjectStore,
    project_id: &str,
    run_id: &str,
) -> Result<run_detail::AgentRunDetail, String> {
    let run = store.run(run_id).map_err(|error| error.to_string())?;
    validate_run_project(&run, project_id).map_err(|error| error.to_string())?;
    run_detail::build_run_detail(store, run)
}

#[tauri::command]
fn agent_run_detail(
    request: AgentRunDetailRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<run_detail::AgentRunDetail>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let detail = load_run_detail(
        &ProjectStore::at(project_root),
        &request.project_id,
        &request.run_id,
    )
    .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: detail,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTurnListRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    now: String,
}

fn list_conversation_turns(
    store: &ProjectStore,
    scheduler: &sion_agent::RunScheduler,
    node_id: WorkflowNodeId,
    session_id: &str,
    now: &str,
) -> sion_storage::Result<Vec<ConversationTurn>> {
    let turns = store.turns(node_id, session_id)?;
    let live_run_ids = turns
        .iter()
        .filter_map(|turn| {
            scheduler.get(&turn.run_id).and_then(|run| {
                matches!(
                    run.status,
                    sion_agent::AgentRunStatus::Queued | sion_agent::AgentRunStatus::Running
                )
                .then(|| run.id.clone())
            })
        })
        .collect();
    store.recover_interrupted_turns_except(node_id, session_id, now.to_string(), &live_run_ids)
}

#[tauri::command]
fn conversation_turn_list(
    request: ConversationTurnListRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<VersionedResponse<ConversationTurnList>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(project_root);
    let scheduler = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?;
    let turns = list_conversation_turns(
        &store,
        &scheduler,
        request.node_id,
        &request.session_id,
        &request.now,
    )
    .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ConversationTurnList { turns },
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTurnRetryRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    turn_id: String,
    now: String,
}

#[tauri::command]
fn conversation_turn_retry_delivery(
    request: ConversationTurnRetryRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<VersionedResponse<AgentRunStartResult>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = sion_root(&app)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(&project_root);
    let turns = store
        .turns(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let mut turn = turns
        .into_iter()
        .find(|turn| turn.id == request.turn_id)
        .ok_or_else(|| ApiError::CheckFailed("会话轮次未找到".to_string()))?;
    if !matches!(
        turn.delivery_outcome,
        DeliveryOutcome::AwaitingManualDraftResolution { .. }
    ) {
        return Err(ApiError::CheckFailed(
            "该轮次未处于等待草稿处理状态".to_string(),
        ));
    }
    let assistant_message_id = turn
        .assistant_message_id
        .clone()
        .ok_or_else(|| ApiError::CheckFailed("轮次缺少助手回复".to_string()))?;
    let messages = store
        .messages(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let assistant_message = messages
        .iter()
        .find(|message| message.id == assistant_message_id)
        .ok_or_else(|| ApiError::CheckFailed("助手回复未找到".to_string()))?
        .clone();
    let session = store
        .session(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let selection = match session.model_selection {
        Some(selection) => selection,
        None => {
            provider_settings::default_selection(&app_data_root).map_err(ApiError::CheckFailed)?
        }
    };
    let resolved =
        provider_settings::resolve_model(&app_data_root, &selection.provider_id, &selection.model)
            .map_err(ApiError::CheckFailed)?;
    let node = store
        .node(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let override_markdown = store
        .agent_override(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let rules = compose_effective_agent_rules(request.node_id, override_markdown);
    let prompt = conversation_runtime::build_delivery_retry_prompt(
        &node,
        &messages,
        &assistant_message,
        &rules.effective_markdown,
    );
    let run_request = sion_agent::RunRequest {
        project_id: request.project_id.clone(),
        node_id: request.node_id,
        provider_id: selection.provider_id.clone(),
        model: selection.model.clone(),
        reasoning_effort: selection.reasoning_effort,
        file_ids: Vec::new(),
        kind: sion_agent::AgentRunKind::DeliveryRetry,
        created_at: request.now.clone(),
        session_id: Some(request.session_id.clone()),
        turn_id: Some(request.turn_id.clone()),
        context_snapshot: Some(conversation_runtime::snapshot_for_prompt(
            &prompt,
            resolved.context_window_tokens,
            store
                .session_usage(request.node_id, &request.session_id)
                .map_err(|error| ApiError::CheckFailed(error.to_string()))?,
            &request.now,
        )),
    };
    let mut scheduler = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?;
    scheduler
        .ensure_available(&run_request.project_id, request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let run = scheduler
        .enqueue(run_request)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    store
        .save_run(&run)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let retry_status = if run.status == sion_agent::AgentRunStatus::Running {
        TurnStatus::Running
    } else {
        TurnStatus::Queued
    };
    turn_runtime::prepare_retry_turn(&mut turn, &run.id, retry_status, &request.now);
    if let Err(error) = store.save_turn(request.node_id, &request.session_id, turn.clone()) {
        let promoted = scheduler
            .cancel(
                &run.id,
                request.now.clone(),
                Some("轮次状态保存失败".into()),
            )
            .unwrap_or_default();
        if let Some(cancelled) = scheduler.get(&run.id) {
            let _ = store.save_run(cancelled);
        }
        drop(scheduler);
        spawn_promoted_runs(app, state.inner().clone(), promoted);
        return Err(ApiError::CheckFailed(error.to_string()));
    }
    let job = AgentJob {
        project_root,
        project_id: request.project_id.clone(),
        node_id: request.node_id,
        session_id: request.session_id.clone(),
        prompt,
        model: resolved,
        reasoning_effort: selection.reasoning_effort,
        cancellation: CancellationToken::new(),
        turn_id: request.turn_id.clone(),
        expected_revision: node.revision,
        delivery_write_allowed: true,
        started_instant: Instant::now(),
    };
    state
        .jobs
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent job lock is poisoned".to_string()))?
        .insert(run.id.clone(), job.clone());
    let should_spawn = run.status == sion_agent::AgentRunStatus::Running;
    drop(scheduler);
    let _ = app.emit(
        "conversation-turn-updated",
        ConversationTurnEvent {
            turn: turn.clone(),
            saved_node: None,
        },
    );
    if should_spawn {
        spawn_agent_run(app, state.inner().clone(), run.clone(), job);
    }
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: AgentRunStartResult { run, turn },
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryRegenerationStartRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    generation_id: String,
    file_ids: Vec<String>,
    expected_revision: u64,
    now: String,
}

#[tauri::command]
fn delivery_regeneration_start(
    request: DeliveryRegenerationStartRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<VersionedResponse<DeliveryGeneration>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = sion_root(&app)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(&project_root);
    let session = store
        .session(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let selection = match session.model_selection {
        Some(selection) => selection,
        None => {
            provider_settings::default_selection(&app_data_root).map_err(ApiError::CheckFailed)?
        }
    };
    let resolved =
        provider_settings::resolve_model(&app_data_root, &selection.provider_id, &selection.model)
            .map_err(ApiError::CheckFailed)?;
    let node = store
        .node(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let messages = store
        .messages(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let attachments = conversation_runtime::load_selected_files(&store, &request.file_ids)
        .map_err(ApiError::CheckFailed)?;
    let override_markdown = store
        .agent_override(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let rules = compose_effective_agent_rules(request.node_id, override_markdown);
    let prompt = conversation_runtime::build_delivery_regeneration_prompt(
        &node,
        &messages,
        &attachments,
        &rules.effective_markdown,
    );
    let generation_id = request.generation_id.clone();
    let run_request = sion_agent::RunRequest {
        project_id: request.project_id.clone(),
        node_id: request.node_id,
        provider_id: selection.provider_id.clone(),
        model: selection.model.clone(),
        reasoning_effort: selection.reasoning_effort,
        file_ids: request.file_ids.clone(),
        kind: sion_agent::AgentRunKind::DeliveryRegeneration,
        created_at: request.now.clone(),
        session_id: Some(request.session_id.clone()),
        turn_id: None,
        context_snapshot: Some(conversation_runtime::snapshot_for_prompt(
            &prompt,
            resolved.context_window_tokens,
            store
                .session_usage(request.node_id, &request.session_id)
                .map_err(|error| ApiError::CheckFailed(error.to_string()))?,
            &request.now,
        )),
    };
    let mut scheduler = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?;
    scheduler
        .ensure_available(&run_request.project_id, request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let run = scheduler
        .enqueue(run_request)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    store
        .save_run(&run)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    let generation = DeliveryGeneration {
        id: generation_id.clone(),
        run_id: run.id.clone(),
        project_id: request.project_id.clone(),
        node_id: request.node_id,
        status: generation_status_for_run(run.status.clone()),
        expected_revision: request.expected_revision,
        error: None,
        started_at: request.now.clone(),
        finished_at: None,
    };
    let regen_job = RegenerationJob {
        generation: generation.clone(),
        project_root,
        node_id: request.node_id,
        expected_revision: request.expected_revision,
        prompt,
        model: resolved,
        reasoning_effort: selection.reasoning_effort,
        cancellation: CancellationToken::new(),
        candidate: Arc::new(Mutex::new(String::new())),
        started_instant: Instant::now(),
    };
    state
        .regenerations
        .lock()
        .map_err(|_| ApiError::CheckFailed("regeneration lock is poisoned".to_string()))?
        .insert(generation_id, regen_job.clone());
    let should_spawn = run.status == sion_agent::AgentRunStatus::Running;
    drop(scheduler);
    if should_spawn {
        spawn_regeneration_run(app, state.inner().clone(), run, regen_job);
    }
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: generation,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryRegenerationCancelRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
    generation_id: String,
    now: String,
}

#[tauri::command]
fn delivery_regeneration_cancel(
    request: DeliveryRegenerationCancelRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<VersionedResponse<DeliveryGeneration>, ApiError> {
    assert_api_version(&request.version)?;
    let job = state
        .regenerations
        .lock()
        .map_err(|_| ApiError::CheckFailed("regeneration lock is poisoned".to_string()))?
        .get(&request.generation_id)
        .cloned()
        .ok_or_else(|| ApiError::CheckFailed("重新生成任务未找到".to_string()))?;
    if job.generation.project_id != request.project_id {
        return Err(ApiError::CheckFailed(
            "重新生成任务不属于该项目".to_string(),
        ));
    }
    let run = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?
        .get(&job.generation.run_id)
        .cloned()
        .ok_or_else(|| ApiError::CheckFailed("重新生成运行记录未找到".to_string()))?;
    if run.status == sion_agent::AgentRunStatus::Queued {
        let (cancelled, promoted) = {
            let mut scheduler = state.scheduler.lock().map_err(|_| {
                ApiError::CheckFailed("agent scheduler lock is poisoned".to_string())
            })?;
            let promoted = scheduler
                .cancel(&run.id, request.now.clone(), Some("用户取消".into()))
                .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
            (scheduler.get(&run.id).cloned(), promoted)
        };
        if let Some(cancelled) = cancelled {
            ProjectStore::at(&job.project_root)
                .save_run(&cancelled)
                .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
        }
        state
            .regenerations
            .lock()
            .map_err(|_| ApiError::CheckFailed("regeneration lock is poisoned".to_string()))?
            .remove(&request.generation_id);
        let generation = DeliveryGeneration {
            status: DeliveryGenerationStatus::Cancelled,
            finished_at: Some(request.now),
            ..job.generation
        };
        let _ = app.emit(
            "delivery-generation-finished",
            DeliveryGenerationFinishedEvent {
                generation: generation.clone(),
                saved_node: None,
            },
        );
        spawn_promoted_runs(app, state.inner().clone(), promoted);
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: generation,
        });
    }
    job.cancellation.cancel();
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: job.generation.clone(),
    })
}

fn validate_run_project(run: &sion_agent::AgentRun, project_id: &str) -> Result<(), ApiError> {
    if run.project_id == project_id {
        Ok(())
    } else {
        Err(ApiError::CheckFailed(format!(
            "agent run {} does not belong to project {project_id}",
            run.id
        )))
    }
}

#[tauri::command]
fn agent_run_cancel(
    request: AgentRunCancelRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<VersionedResponse<sion_agent::AgentRun>, ApiError> {
    assert_api_version(&request.version)?;
    let run = state
        .scheduler
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?
        .get(&request.run_id)
        .cloned()
        .ok_or_else(|| ApiError::CheckFailed("agent run was not found".to_string()))?;
    validate_run_project(&run, &request.project_id)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let job = state
        .jobs
        .lock()
        .map_err(|_| ApiError::CheckFailed("agent job lock is poisoned".to_string()))?
        .get(&request.run_id)
        .cloned()
        .ok_or_else(|| ApiError::CheckFailed("agent run was not found".to_string()))?;
    let cancelled_at = request.now.clone();
    let store = ProjectStore::at(&project_root);
    let queued_cancellation = {
        let mut scheduler = state
            .scheduler
            .lock()
            .map_err(|_| ApiError::CheckFailed("agent scheduler lock is poisoned".to_string()))?;
        let current = scheduler
            .get(&request.run_id)
            .cloned()
            .ok_or_else(|| ApiError::CheckFailed("agent run was not found".to_string()))?;
        if current.status == sion_agent::AgentRunStatus::Queued {
            let original_turn = store
                .turns(job.node_id, &job.session_id)
                .map_err(|error| ApiError::CheckFailed(error.to_string()))?
                .into_iter()
                .find(|turn| turn.id == job.turn_id)
                .ok_or_else(|| ApiError::CheckFailed("会话轮次未找到".to_string()))?;
            let mut cancelled_turn = original_turn.clone();
            turn_runtime::mark_turn_cancelled(&mut cancelled_turn, &cancelled_at);
            store
                .save_turn(job.node_id, &job.session_id, cancelled_turn.clone())
                .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
            let durable_cancelled = sion_agent::AgentRun {
                status: sion_agent::AgentRunStatus::Cancelled,
                finished_at: Some(cancelled_at.clone()),
                summary: Some("用户取消".to_string()),
                ..current
            };
            if let Err(error) = store.save_run(&durable_cancelled) {
                let _ = store.save_turn(job.node_id, &job.session_id, original_turn);
                return Err(ApiError::CheckFailed(error.to_string()));
            }
            let promoted = scheduler
                .cancel(&request.run_id, cancelled_at, Some("用户取消".to_string()))
                .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
            let cancelled = scheduler
                .get(&request.run_id)
                .cloned()
                .ok_or_else(|| ApiError::CheckFailed("agent run was not found".to_string()))?;
            Some((cancelled, promoted, cancelled_turn))
        } else {
            None
        }
    };
    if let Some((cancelled, promoted, cancelled_turn)) = queued_cancellation {
        let _ = app.emit(
            "conversation-turn-updated",
            ConversationTurnEvent {
                turn: cancelled_turn,
                saved_node: None,
            },
        );
        state
            .jobs
            .lock()
            .map_err(|_| ApiError::CheckFailed("agent job lock is poisoned".to_string()))?
            .remove(&request.run_id);
        let _ = app.emit(
            "agent-run-finished",
            AgentFinishedEvent {
                run: cancelled.clone(),
            },
        );
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
fn settings_get(
    request: VersionedRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<SettingsSummary>, ApiError> {
    assert_api_version(&request)?;
    let global = sion_root(&app)?;
    let settings = app_settings::load(&global).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: settings_summary(&settings),
    })
}

#[tauri::command]
fn settings_save_ui(
    request: SettingsSaveUiRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
) -> Result<VersionedResponse<SettingsSummary>, ApiError> {
    assert_api_version(&request.version)?;
    let global = sion_root(&app)?;
    let _guard = state
        .mutation
        .lock()
        .map_err(|_| ApiError::CheckFailed("settings lock is poisoned".to_string()))?;
    let saved = app_settings::update_ui(&global, request.ui).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: settings_summary(&saved),
    })
}

#[tauri::command]
async fn settings_pick_projects_directory(
    request: VersionedRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
) -> Result<VersionedResponse<SettingsSummary>, ApiError> {
    assert_api_version(&request)?;
    let global = sion_root(&app)?;
    let settings = {
        let _guard = state
            .mutation
            .lock()
            .map_err(|_| ApiError::CheckFailed("settings lock is poisoned".to_string()))?;
        app_settings::load(&global).map_err(ApiError::CheckFailed)?
    };
    let Some(directory) = project_directory_dialog(&app, &settings).blocking_pick_folder() else {
        let _guard = state
            .mutation
            .lock()
            .map_err(|_| ApiError::CheckFailed("settings lock is poisoned".to_string()))?;
        let latest = app_settings::load(&global).map_err(ApiError::CheckFailed)?;
        return Ok(VersionedResponse {
            api_version: API_VERSION,
            payload: settings_summary(&latest),
        });
    };
    let directory = directory.into_path().map_err(|error| {
        ApiError::CheckFailed(format!("selected directory is not a local path: {error}"))
    })?;
    let _guard = state
        .mutation
        .lock()
        .map_err(|_| ApiError::CheckFailed("settings lock is poisoned".to_string()))?;
    let updated = app_settings::update_projects_directory(&global, Some(directory))
        .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: settings_summary(&updated),
    })
}

#[tauri::command]
fn settings_clear_projects_directory(
    request: VersionedRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
) -> Result<VersionedResponse<SettingsSummary>, ApiError> {
    assert_api_version(&request)?;
    let global = sion_root(&app)?;
    let _guard = state
        .mutation
        .lock()
        .map_err(|_| ApiError::CheckFailed("settings lock is poisoned".to_string()))?;
    let cleared =
        app_settings::update_projects_directory(&global, None).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: settings_summary(&cleared),
    })
}

#[tauri::command]
async fn project_create(
    request: ProjectCreateRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProjectCreateResult>, ApiError> {
    assert_api_version(&request.version)?;
    let global = sion_root(&app)?;
    let manifest = create_project_from_settings(&global, request)?;
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
    let global = sion_root(&app)?;
    let discovery = list_projects_from_settings(&global)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProjectList {
            projects: discovery.projects,
            warnings: discovery.warnings,
        },
    })
}

#[tauri::command]
fn project_reveal(
    request: ProjectRevealRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ProjectRevealResult>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let command = file_manager_command(&project_root)?;
    Command::new(command.program)
        .args(command.arguments)
        .spawn()
        .map_err(|error| ApiError::CheckFailed(format!("cannot reveal project: {error}")))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProjectRevealResult { revealed: true },
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
fn project_get_agent_rules(
    request: ProjectNodeRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<EffectiveAgentRules>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let custom_markdown = ProjectStore::at(project_root)
        .agent_override(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: compose_effective_agent_rules(request.node_id, custom_markdown),
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
    let markdown = nodes
        .iter()
        .map(|node| node.markdown.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let bytes = project_export::build_docx(&manifest, &markdown).map_err(ApiError::CheckFailed)?;
    std::fs::write(&target, bytes).map_err(|error| {
        ApiError::CheckFailed(format!("cannot write {}: {error}", target.display()))
    })?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: ProjectExportResult {
            exported: true,
            path: Some(target.to_string_lossy().into_owned()),
        },
    })
}

fn selection_for_new_session<F>(
    explicit: Option<ChatModelSelection>,
    load_default: F,
) -> Result<ChatModelSelection, String>
where
    F: FnOnce() -> Result<ChatModelSelection, String>,
{
    explicit.map(Ok).unwrap_or_else(load_default)
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
    let app_data_root = sion_root(&app)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let selection = selection_for_new_session(request.model_selection, || {
        provider_settings::default_selection(&app_data_root)
    })
    .map_err(ApiError::CheckFailed)?;
    provider_settings::resolve_model(&app_data_root, &selection.provider_id, &selection.model)
        .map_err(ApiError::CheckFailed)?;
    let session = ProjectStore::at(project_root)
        .create_session(request.node_id, request.name, Some(selection), request.now)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: session,
    })
}

#[tauri::command]
fn session_model_update(
    request: SessionModelUpdateRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ChatSession>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = sion_root(&app)?;
    provider_settings::resolve_model(
        &app_data_root,
        &request.model_selection.provider_id,
        &request.model_selection.model,
    )
    .map_err(ApiError::CheckFailed)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let session = ProjectStore::at(project_root)
        .update_session_model(
            request.node_id,
            &request.session_id,
            request.model_selection,
            request.now,
        )
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: session,
    })
}

#[tauri::command]
fn session_delete(
    request: SessionDeleteRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<()>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    ProjectStore::at(project_root)
        .delete_session(request.node_id, &request.session_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: (),
    })
}

#[tauri::command]
fn conversation_context_get(
    request: ConversationContextGetRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<ConversationContextSnapshot>, ApiError> {
    assert_api_version(&request.version)?;
    let app_data_root = sion_root(&app)?;
    let resolved = provider_settings::resolve_model(
        &app_data_root,
        &request.model_selection.provider_id,
        &request.model_selection.model,
    )
    .map_err(ApiError::CheckFailed)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let store = ProjectStore::at(&project_root);
    let prepared = conversation_runtime::prepare_conversation(
        &store,
        request.node_id,
        Some(&request.session_id),
        "",
        &request.file_ids,
        resolved.context_window_tokens,
        &request.now,
    )
    .map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: prepared.snapshot,
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

#[tauri::command]
fn file_preview(
    request: FilePreviewRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<FilePreview>, ApiError> {
    assert_api_version(&request.version)?;
    let root = resolve_registered_project_root(&app, &request.project_id)?;
    let preview = ProjectStore::at(root)
        .file_preview(&request.file_id, 24_000)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: preview,
    })
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
                    Err(sion_agent::model_stream::StreamFailure::UnsupportedProtocol),
                    turn_runtime::DeliveryStreamProjector::default(),
                );
                return;
            }
        };
        let event_app = app.clone();
        let event_run = run.clone();
        let event_session = job.session_id.clone();
        let projector = Arc::new(Mutex::new(turn_runtime::DeliveryStreamProjector::default()));
        let projector_for_delta = projector.clone();
        let stream = sion_agent::model_stream::stream_text_with(
            &state.client,
            &sion_agent::model_stream::StreamRequest {
                endpoint: job.model.endpoint.clone(),
                api_key: job.model.api_key.clone(),
                protocol,
                model: job.model.model.clone(),
                prompt: job.prompt.clone(),
                reasoning_effort: job.reasoning_effort,
                request_public_reasoning_summary: true,
            },
            job.cancellation.clone(),
            move |delta| match delta {
                sion_agent::model_stream::StreamDelta::OutputText(text) => {
                    let visible = projector_for_delta.lock().unwrap().push(text);
                    if !visible.is_empty() {
                        let _ = event_app.emit(
                            "agent-token",
                            AgentTokenEvent {
                                run_id: event_run.id.clone(),
                                project_id: event_run.project_id.clone(),
                                node_id: event_run.node_id,
                                session_id: event_session.clone(),
                                delta: visible,
                            },
                        );
                    }
                }
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
            },
        )
        .await;
        let projector = Arc::try_unwrap(projector)
            .map(|mutex| mutex.into_inner().unwrap())
            .unwrap_or_default();
        complete_agent_run(&app, &state, &run, &job, stream, projector);
    });
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum DeliveryGenerationStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Conflict,
}

fn generation_status_for_run(status: sion_agent::AgentRunStatus) -> DeliveryGenerationStatus {
    match status {
        sion_agent::AgentRunStatus::Queued => DeliveryGenerationStatus::Queued,
        sion_agent::AgentRunStatus::Running => DeliveryGenerationStatus::Running,
        sion_agent::AgentRunStatus::Completed => DeliveryGenerationStatus::Completed,
        sion_agent::AgentRunStatus::Failed => DeliveryGenerationStatus::Failed,
        sion_agent::AgentRunStatus::Cancelled => DeliveryGenerationStatus::Cancelled,
    }
}

fn finish_regeneration_scheduler(
    scheduler: &mut sion_agent::RunScheduler,
    run_id: &str,
    finished_at: &str,
    status: &DeliveryGenerationStatus,
    public_error: Option<&str>,
) -> (Option<sion_agent::AgentRun>, Vec<sion_agent::AgentRun>) {
    let promoted = match status {
        DeliveryGenerationStatus::Completed => scheduler.complete(run_id, finished_at.into(), None),
        DeliveryGenerationStatus::Cancelled => {
            scheduler.cancel(run_id, finished_at.into(), Some("已取消".into()))
        }
        _ => scheduler.fail(
            run_id,
            finished_at.into(),
            public_error.unwrap_or("重新生成失败").to_string(),
        ),
    }
    .unwrap_or_default();
    (scheduler.get(run_id).cloned(), promoted)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryGeneration {
    id: String,
    run_id: String,
    project_id: String,
    node_id: WorkflowNodeId,
    status: DeliveryGenerationStatus,
    expected_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeliveryGenerationTokenEvent {
    generation_id: String,
    project_id: String,
    node_id: WorkflowNodeId,
    delta: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeliveryGenerationFinishedEvent {
    generation: DeliveryGeneration,
    #[serde(skip_serializing_if = "Option::is_none")]
    saved_node: Option<WorkflowNode>,
}

enum RegenerationCommitResult {
    Saved(WorkflowNode),
    Conflict { latest: WorkflowNode },
    ValidationFailed { public_error: String },
}

fn commit_regenerated_markdown(
    store: &ProjectStore,
    node_id: WorkflowNodeId,
    expected_revision: u64,
    candidate: String,
    now: String,
) -> Result<RegenerationCommitResult, ApiError> {
    match sion_core::validate_delivery_markdown(candidate, node_id) {
        Err(_) => Ok(RegenerationCommitResult::ValidationFailed {
            public_error: "交付稿结构校验失败".to_string(),
        }),
        Ok(markdown) => match store.save_node_if_revision(
            node_id,
            expected_revision,
            markdown,
            NodeStatus::Generated,
            now,
        ) {
            Ok(SaveNodeResult::Saved(saved)) => Ok(RegenerationCommitResult::Saved(saved)),
            Ok(SaveNodeResult::Conflict { latest }) => {
                Ok(RegenerationCommitResult::Conflict { latest })
            }
            Err(error) => Err(ApiError::CheckFailed(error.to_string())),
        },
    }
}

struct DeliveryApplication {
    outcome: DeliveryOutcome,
    saved_node: Option<WorkflowNode>,
}

fn apply_delivery_outcome(
    store: &ProjectStore,
    delivery: AgentDelivery,
    node: Option<WorkflowNode>,
    job: &AgentJob,
    finished_at: &str,
) -> DeliveryApplication {
    let Some(node) = node else {
        return DeliveryApplication {
            outcome: turn_runtime::safe_delivery_error(DeliveryStage::Validation, ""),
            saved_node: None,
        };
    };
    match turn_runtime::plan_delivery_completion(
        delivery,
        &node.markdown,
        job.node_id,
        job.expected_revision,
        job.delivery_write_allowed,
    ) {
        Ok(turn_runtime::DeliveryCompletionPlan::Unchanged) => DeliveryApplication {
            outcome: DeliveryOutcome::Unchanged,
            saved_node: None,
        },
        Ok(turn_runtime::DeliveryCompletionPlan::Apply {
            markdown,
            expected_revision,
            section_titles,
        }) => {
            let previous_revision = node.revision;
            match store.save_node_if_revision(
                job.node_id,
                expected_revision,
                markdown,
                NodeStatus::Generated,
                finished_at.to_string(),
            ) {
                Ok(SaveNodeResult::Saved(saved)) => DeliveryApplication {
                    outcome: DeliveryOutcome::PatchApplied {
                        previous_revision,
                        revision: saved.revision,
                        section_titles,
                    },
                    saved_node: Some(saved),
                },
                Ok(SaveNodeResult::Conflict { latest }) => DeliveryApplication {
                    outcome: DeliveryOutcome::Conflict {
                        expected_revision,
                        actual_revision: latest.revision,
                    },
                    saved_node: None,
                },
                Err(_) => DeliveryApplication {
                    outcome: turn_runtime::safe_delivery_error(DeliveryStage::Save, ""),
                    saved_node: None,
                },
            }
        }
        Ok(turn_runtime::DeliveryCompletionPlan::AwaitingManualDraftResolution {
            expected_revision,
        }) => DeliveryApplication {
            outcome: DeliveryOutcome::AwaitingManualDraftResolution { expected_revision },
            saved_node: None,
        },
        Err(_) => DeliveryApplication {
            outcome: turn_runtime::safe_delivery_error(DeliveryStage::Validation, ""),
            saved_node: None,
        },
    }
}

fn spawn_regeneration_run(
    app: tauri::AppHandle,
    state: Arc<AgentState>,
    run: sion_agent::AgentRun,
    job: RegenerationJob,
) {
    tauri::async_runtime::spawn(async move {
        let protocol = match job.model.protocol.as_str() {
            "chat_completions" => sion_agent::model_stream::ProviderProtocol::ChatCompletions,
            "openai_responses" => sion_agent::model_stream::ProviderProtocol::OpenaiResponses,
            _ => {
                complete_regeneration_run(
                    &app,
                    &state,
                    &run,
                    &job,
                    Err(sion_agent::model_stream::StreamFailure::UnsupportedProtocol),
                );
                return;
            }
        };
        let event_app = app.clone();
        let event_generation_id = job.generation.id.clone();
        let event_project_id = job.generation.project_id.clone();
        let event_node_id = job.generation.node_id;
        let candidate = job.candidate.clone();
        let stream = sion_agent::model_stream::stream_text_with(
            &state.client,
            &sion_agent::model_stream::StreamRequest {
                endpoint: job.model.endpoint.clone(),
                api_key: job.model.api_key.clone(),
                protocol,
                model: job.model.model.clone(),
                prompt: job.prompt.clone(),
                reasoning_effort: job.reasoning_effort,
                request_public_reasoning_summary: false,
            },
            job.cancellation.clone(),
            move |delta| match delta {
                sion_agent::model_stream::StreamDelta::OutputText(text) => {
                    candidate.lock().unwrap().push_str(text);
                    let _ = event_app.emit(
                        "delivery-generation-token",
                        DeliveryGenerationTokenEvent {
                            generation_id: event_generation_id.clone(),
                            project_id: event_project_id.clone(),
                            node_id: event_node_id,
                            delta: text.to_string(),
                        },
                    );
                }
                sion_agent::model_stream::StreamDelta::ReasoningSummary(_) => {}
            },
        )
        .await;
        complete_regeneration_run(&app, &state, &run, &job, stream);
    });
}

fn complete_regeneration_run(
    app: &tauri::AppHandle,
    state: &Arc<AgentState>,
    run: &sion_agent::AgentRun,
    job: &RegenerationJob,
    outcome: Result<
        sion_agent::model_stream::StreamOutcome,
        sion_agent::model_stream::StreamFailure,
    >,
) {
    let finished_at = utc_now();
    let duration_ms = elapsed_ms(job.started_instant);
    let store = ProjectStore::at(&job.project_root);
    let candidate = job.candidate.lock().unwrap().clone();
    let usage = match &outcome {
        Ok(sion_agent::model_stream::StreamOutcome::Completed(content)) => regeneration_usage(
            run,
            job,
            sion_core::ModelCallStatus::Completed,
            Some(content),
        ),
        Ok(sion_agent::model_stream::StreamOutcome::Cancelled(content)) => regeneration_usage(
            run,
            job,
            sion_core::ModelCallStatus::Interrupted,
            Some(content),
        ),
        Err(_) => regeneration_usage(run, job, sion_core::ModelCallStatus::Failed, None),
    };
    let (status, saved_node, error) = match outcome {
        Ok(sion_agent::model_stream::StreamOutcome::Completed(_)) => {
            match commit_regenerated_markdown(
                &store,
                job.node_id,
                job.expected_revision,
                candidate,
                finished_at.clone(),
            ) {
                Ok(RegenerationCommitResult::Saved(saved)) => {
                    (DeliveryGenerationStatus::Completed, Some(saved), None)
                }
                Ok(RegenerationCommitResult::Conflict { latest }) => {
                    let _actual_revision = latest.revision;
                    (DeliveryGenerationStatus::Conflict, None, None)
                }
                Ok(RegenerationCommitResult::ValidationFailed { public_error }) => {
                    (DeliveryGenerationStatus::Failed, None, Some(public_error))
                }
                Err(_) => (
                    DeliveryGenerationStatus::Failed,
                    None,
                    Some("保存重新生成的交付稿失败".to_string()),
                ),
            }
        }
        Ok(sion_agent::model_stream::StreamOutcome::Cancelled(_)) => {
            (DeliveryGenerationStatus::Cancelled, None, None)
        }
        Err(error) => (
            DeliveryGenerationStatus::Failed,
            None,
            Some(turn_runtime::public_model_failure(&error)),
        ),
    };
    let promoted = {
        let Ok(mut scheduler) = state.scheduler.lock() else {
            return;
        };
        let _ = scheduler.attach_usage(&run.id, usage, duration_ms);
        let (final_run, promoted) = finish_regeneration_scheduler(
            &mut scheduler,
            &run.id,
            &finished_at,
            &status,
            error.as_deref(),
        );
        if let Some(final_run) = final_run {
            let _ = store.save_run(&final_run);
        }
        promoted
    };
    if let Ok(mut regenerations) = state.regenerations.lock() {
        regenerations.remove(&job.generation.id);
    }
    let generation = DeliveryGeneration {
        status,
        error,
        finished_at: Some(finished_at),
        ..job.generation.clone()
    };
    let _ = app.emit(
        "delivery-generation-finished",
        DeliveryGenerationFinishedEvent {
            generation,
            saved_node,
        },
    );
    spawn_promoted_runs(app.clone(), state.clone(), promoted);
}

fn regeneration_usage(
    run: &sion_agent::AgentRun,
    job: &RegenerationJob,
    status: sion_core::ModelCallStatus,
    content: Option<&sion_agent::model_stream::StreamContent>,
) -> sion_core::TurnTokenUsage {
    sion_core::build_turn_usage(
        &job.generation.id,
        &format!("{}:document-update", run.id),
        &job.model.provider_id,
        &job.model.model,
        sion_core::ModelCallCategory::DocumentUpdate,
        status,
        content.and_then(|content| content.usage),
        &job.prompt,
        &content
            .map(|content| content.output.join(""))
            .unwrap_or_default(),
    )
}

fn completed_turn_usage(
    run: &sion_agent::AgentRun,
    job: &AgentJob,
    content: &sion_agent::model_stream::StreamContent,
) -> sion_core::TurnTokenUsage {
    agent_turn_usage(
        run,
        job,
        sion_core::ModelCallStatus::Completed,
        Some(content),
    )
}

fn agent_turn_usage(
    run: &sion_agent::AgentRun,
    job: &AgentJob,
    status: sion_core::ModelCallStatus,
    content: Option<&sion_agent::model_stream::StreamContent>,
) -> sion_core::TurnTokenUsage {
    sion_core::build_turn_usage(
        &job.turn_id,
        &format!("{}:answer", run.id),
        &job.model.provider_id,
        &job.model.model,
        sion_core::ModelCallCategory::Answer,
        status,
        content.and_then(|content| content.usage),
        &job.prompt,
        &content
            .map(|content| content.output.join(""))
            .unwrap_or_default(),
    )
}

fn complete_agent_run(
    app: &tauri::AppHandle,
    state: &Arc<AgentState>,
    run: &sion_agent::AgentRun,
    job: &AgentJob,
    outcome: Result<
        sion_agent::model_stream::StreamOutcome,
        sion_agent::model_stream::StreamFailure,
    >,
    projector: turn_runtime::DeliveryStreamProjector,
) {
    let finished_at = utc_now();
    let duration_ms = elapsed_ms(job.started_instant);
    let store = ProjectStore::at(&job.project_root);
    let base_turn = store
        .turns(job.node_id, &job.session_id)
        .ok()
        .and_then(|turns| turns.into_iter().find(|turn| turn.id == job.turn_id))
        .unwrap_or_else(|| ConversationTurn {
            id: job.turn_id.clone(),
            project_id: run.project_id.clone(),
            node_id: job.node_id,
            session_id: job.session_id.clone(),
            run_id: run.id.clone(),
            user_message_id: String::new(),
            assistant_message_id: None,
            status: TurnStatus::Running,
            activities: Vec::new(),
            reasoning_summary: None,
            delivery_outcome: DeliveryOutcome::Pending,
            started_at: finished_at.clone(),
            finished_at: None,
        });
    let (final_run, promoted, terminal_turn) = {
        let Ok(mut scheduler) = state.scheduler.lock() else {
            return;
        };
        match outcome {
            Ok(sion_agent::model_stream::StreamOutcome::Completed(content)) => {
                let usage = completed_turn_usage(run, job, &content);
                let _ = scheduler.attach_usage(&run.id, usage.clone(), duration_ms);
                let projected = projector.finish();
                let application = match projected.delivery {
                    Ok(delivery) => apply_delivery_outcome(
                        &store,
                        delivery,
                        store.node(job.node_id).ok(),
                        job,
                        &finished_at,
                    ),
                    Err(_) => DeliveryApplication {
                        outcome: turn_runtime::safe_delivery_error(DeliveryStage::Decision, ""),
                        saved_node: None,
                    },
                };
                let delivery_outcome = application.outcome;
                let assistant_message_id = match run.kind {
                    sion_agent::AgentRunKind::DeliveryRetry => {
                        base_turn.assistant_message_id.clone()
                    }
                    _ => Some(uuid::Uuid::new_v4().to_string()),
                };
                let turn = ConversationTurn {
                    run_id: run.id.clone(),
                    status: TurnStatus::Completed,
                    activities: turn_runtime::completed_activities(&delivery_outcome, &finished_at),
                    reasoning_summary: turn_runtime::public_reasoning_summary(
                        &content.reasoning_summary,
                    )
                    .or(base_turn.reasoning_summary.clone()),
                    delivery_outcome,
                    assistant_message_id: assistant_message_id.clone(),
                    finished_at: Some(finished_at.clone()),
                    ..base_turn.clone()
                };
                let persisted = match run.kind {
                    sion_agent::AgentRunKind::DeliveryRetry => {
                        store.save_turn(job.node_id, &job.session_id, turn.clone())
                    }
                    _ => {
                        let assistant_id = assistant_message_id
                            .expect("conversation completion creates an assistant id");
                        store.complete_turn(
                            job.node_id,
                            &job.session_id,
                            ChatMessage {
                                id: assistant_id,
                                role: ChatRole::Assistant,
                                content: projected.visible_content,
                                reasoning_content: None,
                                sources: None,
                                created_at: finished_at.clone(),
                                turn_id: Some(job.turn_id.clone()),
                                reasoning_duration_ms: None,
                                usage: Some(usage),
                                attachments: Vec::new(),
                                model_execution: Some(sion_core::ModelExecution {
                                    provider_id: run
                                        .provider_id
                                        .clone()
                                        .expect("new runs freeze provider"),
                                    model: run.model.clone().expect("new runs freeze model"),
                                    reasoning_effort: run
                                        .reasoning_effort
                                        .expect("new runs freeze effort"),
                                }),
                            },
                            turn.clone(),
                        )
                    }
                };
                let (promoted, terminal_turn) = if persisted.is_ok() {
                    (
                        scheduler
                            .complete(
                                &run.id,
                                finished_at.clone(),
                                Some(format!(
                                    "已使用 {} 的模型回复并保存到本地会话",
                                    job.model.provider_id
                                )),
                            )
                            .unwrap_or_default(),
                        Some((turn, application.saved_node)),
                    )
                } else {
                    (
                        scheduler
                            .fail(&run.id, finished_at.clone(), "本地会话保存失败".to_string())
                            .unwrap_or_default(),
                        None,
                    )
                };
                let final_run = scheduler.get(&run.id).cloned();
                (final_run, promoted, terminal_turn)
            }
            Ok(sion_agent::model_stream::StreamOutcome::Cancelled(content)) => {
                let usage = agent_turn_usage(
                    run,
                    job,
                    sion_core::ModelCallStatus::Interrupted,
                    Some(&content),
                );
                let _ = scheduler.attach_usage(&run.id, usage, duration_ms);
                let turn = ConversationTurn {
                    status: TurnStatus::Cancelled,
                    activities: turn_runtime::completed_activities(
                        &DeliveryOutcome::Cancelled,
                        &finished_at,
                    ),
                    delivery_outcome: DeliveryOutcome::Cancelled,
                    assistant_message_id: None,
                    finished_at: Some(finished_at.clone()),
                    ..base_turn.clone()
                };
                let persisted = store
                    .save_turn(job.node_id, &job.session_id, turn.clone())
                    .is_ok();
                let promoted = if persisted {
                    scheduler
                        .cancel(
                            &run.id,
                            finished_at.clone(),
                            Some("已取消；部分输出不会自动写入节点".to_string()),
                        )
                        .unwrap_or_default()
                } else {
                    scheduler
                        .fail(&run.id, finished_at.clone(), "本地会话保存失败".into())
                        .unwrap_or_default()
                };
                let final_run = scheduler.get(&run.id).cloned();
                (final_run, promoted, persisted.then_some((turn, None)))
            }
            Err(error) => {
                let usage = agent_turn_usage(run, job, sion_core::ModelCallStatus::Failed, None);
                let _ = scheduler.attach_usage(&run.id, usage, duration_ms);
                let public_error = turn_runtime::public_model_failure(&error);
                let delivery_outcome = turn_runtime::response_failure(&error);
                let turn = ConversationTurn {
                    status: TurnStatus::Failed,
                    activities: turn_runtime::completed_activities(&delivery_outcome, &finished_at),
                    delivery_outcome,
                    assistant_message_id: None,
                    finished_at: Some(finished_at.clone()),
                    ..base_turn
                };
                let persisted = store
                    .save_turn(job.node_id, &job.session_id, turn.clone())
                    .is_ok();
                let promoted = scheduler
                    .fail(&run.id, finished_at.clone(), public_error)
                    .unwrap_or_default();
                let final_run = scheduler.get(&run.id).cloned();
                (final_run, promoted, persisted.then_some((turn, None)))
            }
        }
    };
    let Some(final_run) = final_run else {
        return;
    };
    let _ = store.save_run(&final_run);
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.remove(&run.id);
    }
    if let Some((turn, saved_node)) = terminal_turn {
        let _ = app.emit(
            "conversation-turn-updated",
            ConversationTurnEvent { turn, saved_node },
        );
    }
    let _ = app.emit("agent-run-finished", AgentFinishedEvent { run: final_run });
    spawn_promoted_runs(app.clone(), state.clone(), promoted);
}

/// A cancelled stream may be shown transiently in the UI, but is never an
/// assistant message on disk. This makes a retry unambiguous and prevents a
/// user from mistaking a truncated draft for a completed answer.
#[allow(dead_code)]
fn completion_from_stream(
    outcome: Result<
        sion_agent::model_stream::StreamOutcome,
        sion_agent::model_stream::StreamFailure,
    >,
) -> Result<(bool, Option<String>), sion_agent::model_stream::StreamFailure> {
    match outcome {
        Ok(sion_agent::model_stream::StreamOutcome::Completed(content)) => {
            Ok((false, Some(content.output.join(""))))
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
        if run.kind == sion_agent::AgentRunKind::DeliveryRegeneration {
            let job = state.regenerations.lock().ok().and_then(|mut jobs| {
                let job = jobs
                    .values_mut()
                    .find(|job| job.generation.run_id == run.id)?;
                job.generation.status = DeliveryGenerationStatus::Running;
                Some(job.clone())
            });
            if let Some(job) = job {
                if ProjectStore::at(&job.project_root).save_run(&run).is_ok() {
                    let _ = app.emit("delivery-generation-running", job.generation.clone());
                    spawn_regeneration_run(app.clone(), state.clone(), run, job);
                } else {
                    fail_promoted_run(&app, &state, &run, "保存晋升后的运行状态失败");
                }
            } else {
                fail_promoted_run(&app, &state, &run, "晋升后的重新生成任务不存在");
            }
        } else {
            let job = state
                .jobs
                .lock()
                .ok()
                .and_then(|jobs| jobs.get(&run.id).cloned());
            if let Some(job) = job {
                let store = ProjectStore::at(&job.project_root);
                let promoted_turn = store
                    .turns(job.node_id, &job.session_id)
                    .ok()
                    .and_then(|turns| turns.into_iter().find(|turn| turn.id == job.turn_id))
                    .map(|mut turn| {
                        turn_runtime::mark_turn_running(&mut turn, &run.created_at);
                        turn
                    });
                let persisted = store.save_run(&run).is_ok()
                    && promoted_turn.as_ref().is_some_and(|turn| {
                        store
                            .save_turn(job.node_id, &job.session_id, turn.clone())
                            .is_ok()
                    });
                if !persisted {
                    fail_promoted_run(&app, &state, &run, "保存晋升后的会话状态失败");
                    continue;
                }
                if let Some(turn) = promoted_turn {
                    let _ = app.emit(
                        "conversation-turn-updated",
                        ConversationTurnEvent {
                            turn,
                            saved_node: None,
                        },
                    );
                }
                spawn_agent_run(app.clone(), state.clone(), run, job);
            } else {
                fail_promoted_run(&app, &state, &run, "晋升后的会话任务不存在");
            }
        }
    }
}

fn fail_promoted_run(
    app: &tauri::AppHandle,
    state: &Arc<AgentState>,
    run: &sion_agent::AgentRun,
    error: &str,
) {
    let failed_at = utc_now();
    let (failed, promoted) = {
        let Ok(mut scheduler) = state.scheduler.lock() else {
            return;
        };
        let promoted = scheduler
            .fail(&run.id, failed_at.clone(), error.to_string())
            .unwrap_or_default();
        (scheduler.get(&run.id).cloned(), promoted)
    };
    let project_root = if run.kind == sion_agent::AgentRunKind::DeliveryRegeneration {
        let job = state.regenerations.lock().ok().and_then(|mut jobs| {
            let generation_id = jobs
                .iter()
                .find_map(|(id, job)| (job.generation.run_id == run.id).then(|| id.clone()))?;
            jobs.remove(&generation_id)
        });
        if let Some(job) = job {
            let project_root = job.project_root.clone();
            let generation = DeliveryGeneration {
                status: DeliveryGenerationStatus::Failed,
                error: Some("启动重新生成任务失败".to_string()),
                finished_at: Some(failed_at.clone()),
                ..job.generation
            };
            let _ = app.emit(
                "delivery-generation-finished",
                DeliveryGenerationFinishedEvent {
                    generation,
                    saved_node: None,
                },
            );
            Some(project_root)
        } else {
            None
        }
    } else {
        let job = state
            .jobs
            .lock()
            .ok()
            .and_then(|mut jobs| jobs.remove(&run.id));
        if let Some(job) = job {
            let store = ProjectStore::at(&job.project_root);
            let failed_turn = store
                .turns(job.node_id, &job.session_id)
                .ok()
                .and_then(|turns| turns.into_iter().find(|turn| turn.id == job.turn_id))
                .map(|mut turn| {
                    turn_runtime::mark_turn_start_failed(&mut turn, &failed_at);
                    turn
                });
            if let Some(turn) = failed_turn
                && store
                    .save_turn(job.node_id, &job.session_id, turn.clone())
                    .is_ok()
            {
                let _ = app.emit(
                    "conversation-turn-updated",
                    ConversationTurnEvent {
                        turn,
                        saved_node: None,
                    },
                );
            }
            Some(job.project_root)
        } else {
            None
        }
    };
    if let Some(failed) = failed {
        if let Some(project_root) = project_root {
            let _ = ProjectStore::at(project_root).save_run(&failed);
        }
        let _ = app.emit("agent-run-finished", AgentFinishedEvent { run: failed });
    }
    spawn_promoted_runs(app.clone(), state.clone(), promoted);
}

fn resolve_registered_project_root(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<std::path::PathBuf, ApiError> {
    let global = sion_root(app)?;
    let settings = app_settings::load(&global).map_err(ApiError::CheckFailed)?;
    let directory = configured_projects_directory(&settings)?;
    ProjectRegistry::at(&global)
        .resolve(directory, project_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AgentState::default()))
        .manage(SettingsState::default())
        .invoke_handler(tauri::generate_handler![
            app_get_version,
            spike_docx_check,
            settings_get,
            settings_save_ui,
            settings_pick_projects_directory,
            settings_clear_projects_directory,
            provider_list,
            provider_save,
            provider_set_default,
            provider_delete,
            agent_run_start,
            agent_run_list,
            agent_run_detail,
            agent_run_cancel,
            conversation_turn_list,
            conversation_turn_retry_delivery,
            delivery_regeneration_start,
            delivery_regeneration_cancel,
            project_create,
            project_list,
            project_reveal,
            project_get_node,
            project_get_agent_rules,
            project_get_agent_override,
            project_save_agent_override,
            project_save_node,
            project_export_docx,
            export_runtime::export_workspace_get,
            export_runtime::export_model_selection_save,
            export_runtime::export_artifact_get,
            export_runtime::export_artifact_save,
            export_runtime::export_artifact_approve,
            export_runtime::export_candidate_apply,
            export_runtime::export_candidate_discard,
            export_runtime::export_review_apply,
            export_runtime::export_docx_save_as,
            session_list,
            session_create,
            session_model_update,
            session_delete,
            conversation_context_get,
            message_list,
            message_append,
            file_list,
            file_import,
            file_preview
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Sion desktop spike");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_selection_prefers_explicit_then_default() {
        let explicit = ChatModelSelection {
            provider_id: "p".into(),
            model: "m".into(),
            reasoning_effort: ReasoningEffort::Off,
        };
        assert_eq!(
            selection_for_new_session(Some(explicit.clone()), || panic!()).unwrap(),
            explicit
        );
        assert_eq!(
            selection_for_new_session(None, || {
                Ok(ChatModelSelection {
                    provider_id: "default".into(),
                    model: "m".into(),
                    reasoning_effort: ReasoningEffort::Medium,
                })
            })
            .unwrap()
            .provider_id,
            "default"
        );
    }

    #[test]
    fn conversation_context_request_uses_an_existing_session_without_a_message() {
        let request: ConversationContextGetRequest = serde_json::from_value(serde_json::json!({
            "apiVersion": API_VERSION,
            "projectId": "project-1",
            "nodeId": "goals",
            "sessionId": "session-1",
            "modelSelection": { "providerId": "p", "model": "m", "reasoningEffort": "medium" },
            "fileIds": [],
            "now": "2026-07-18T00:00:00Z"
        }))
        .unwrap();
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.model_selection.model, "m");
        assert!(
            serde_json::to_value(request)
                .unwrap()
                .get("message")
                .is_none()
        );
    }

    fn temp_command_root() -> PathBuf {
        std::env::temp_dir().join(format!("sion-cmd-{}", uuid::Uuid::new_v4()))
    }

    fn project_request(id: &str) -> ProjectCreateRequest {
        ProjectCreateRequest {
            version: VersionedRequest {
                api_version: API_VERSION,
            },
            id: id.to_string(),
            name: "项目".to_string(),
            customer_name: "客户".to_string(),
            author_name: "作者".to_string(),
            now: "2026-07-15T00:00:00.000Z".to_string(),
        }
    }

    fn create_input(id: &str) -> CreateProjectInput {
        CreateProjectInput {
            id: id.to_string(),
            name: "项目".to_string(),
            customer_name: "客户".to_string(),
            author_name: "作者".to_string(),
            now: "2026-07-15T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn creates_multiple_projects_from_one_saved_container() {
        let root = temp_command_root();
        let global = root.join("global");
        let projects = root.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        app_settings::save(
            &global,
            app_settings::AppSettings::with_projects_directory(Some(projects.clone())),
        )
        .unwrap();
        create_project_from_settings(&global, project_request("project-1")).unwrap();
        create_project_from_settings(&global, project_request("project-2")).unwrap();
        assert!(projects.join("project-1/project.json").is_file());
        assert!(projects.join("project-2/project.json").is_file());
        assert!(!projects.join(".sion").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lists_disk_projects_without_registry_json() {
        let root = temp_command_root();
        let global = root.join("global");
        let projects = root.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        app_settings::save(
            &global,
            app_settings::AppSettings::with_projects_directory(Some(projects.clone())),
        )
        .unwrap();
        ProjectStore::create_in(&projects, create_input("project-1")).unwrap();
        assert_eq!(
            list_projects_from_settings(&global).unwrap().projects.len(),
            1
        );
        let _ = std::fs::remove_dir_all(root);
    }

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
    fn settings_summary_includes_ui_state() {
        let mut settings = app_settings::AppSettings::with_projects_directory(None);
        settings.ui.sidebar_collapsed = true;
        assert!(settings_summary(&settings).ui.sidebar_collapsed);
    }

    #[test]
    fn file_manager_command_targets_project_directory() {
        let path = Path::new("/tmp/sion-project");
        let command = file_manager_command(path).unwrap();
        assert!(
            command
                .arguments
                .iter()
                .any(|argument| argument == path.as_os_str())
        );
    }

    #[test]
    fn cancelled_streams_never_produce_a_persistable_assistant_message() {
        let completion =
            completion_from_stream(Ok(sion_agent::model_stream::StreamOutcome::Cancelled(
                sion_agent::model_stream::StreamContent {
                    output: vec!["partial".to_string()],
                    reasoning_summary: Vec::new(),
                    usage: None,
                },
            )))
            .unwrap();
        assert_eq!(completion, (true, None));
    }

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

    #[test]
    fn completed_stream_usage_accepts_exact_values_and_estimates_when_missing() {
        let fixture = send_fixture(128_000);
        let job = test_delivery_job(&fixture, 0, true);
        let mut scheduler = sion_agent::RunScheduler::default();
        let run = scheduler
            .enqueue(sion_agent::RunRequest {
                project_id: "project-1".into(),
                node_id: WorkflowNodeId::Goals,
                provider_id: "provider-a".into(),
                model: "model-a".into(),
                reasoning_effort: ReasoningEffort::Medium,
                file_ids: vec![],
                kind: sion_agent::AgentRunKind::Conversation,
                created_at: "now".into(),
                session_id: None,
                turn_id: None,
                context_snapshot: None,
            })
            .unwrap();
        let exact = completed_turn_usage(
            &run,
            &job,
            &sion_agent::model_stream::StreamContent {
                output: vec!["answer".into()],
                reasoning_summary: vec![],
                usage: Some(sion_core::ProviderTokenUsage {
                    input_tokens: 12,
                    output_tokens: 3,
                    total_tokens: 15,
                }),
            },
        );
        assert_eq!(exact.source, sion_core::TokenUsageSource::Exact);
        assert_eq!(exact.total_tokens, 15);

        let estimated = completed_turn_usage(
            &run,
            &job,
            &sion_agent::model_stream::StreamContent {
                output: vec!["answer".into()],
                reasoning_summary: vec![],
                usage: None,
            },
        );
        assert_eq!(estimated.source, sion_core::TokenUsageSource::Estimated);
        assert!(estimated.total_tokens > 0);
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn agent_run_project_validation_rejects_cross_project_cancellation() {
        let run = sion_agent::AgentRun {
            id: "run-1".to_string(),
            project_id: "project-a".to_string(),
            node_id: WorkflowNodeId::Goals,
            status: sion_agent::AgentRunStatus::Running,
            created_at: "now".to_string(),
            started_at: Some("now".to_string()),
            finished_at: None,
            summary: None,
            provider_id: None,
            model: None,
            reasoning_effort: None,
            file_ids: Vec::new(),
            kind: sion_agent::AgentRunKind::Conversation,
            session_id: None,
            turn_id: None,
            context_snapshot: None,
            usage: None,
            duration_ms: None,
        };
        assert!(validate_run_project(&run, "project-a").is_ok());
        let error = validate_run_project(&run, "project-b").unwrap_err();
        assert!(error.to_string().contains("does not belong"));
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
        let prompt =
            conversation_runtime::build_agent_prompt(conversation_runtime::ConversationParts {
                node: &node,
                messages: &[],
                project_override: Some("只写确认事实"),
                attachments: &[conversation_runtime::SelectedFileContext {
                    file_id: "file-1".to_string(),
                    original_name: "资料.txt".to_string(),
                    text: "资料正文".to_string(),
                }],
                draft: "",
            });
        assert!(prompt.contains("你只负责项目基本信息"));
        assert!(prompt.contains("只写确认事实"));
        assert!(prompt.contains("资料正文"));
        assert!(prompt.contains("不要浏览网页"));
        assert!(prompt.contains("```delivery"));
    }

    #[test]
    fn effective_agent_rules_match_the_runtime_prompt_order() {
        let rules = conversation_runtime::compose_effective_agent_rules(
            WorkflowNodeId::Goals,
            Some("只使用已确认目标。".to_string()),
        );
        assert_eq!(
            rules.built_in_markdown,
            sion_core::agent_rule(WorkflowNodeId::Goals)
        );
        assert_eq!(rules.custom_markdown.as_deref(), Some("只使用已确认目标。"));
        assert_eq!(
            rules.effective_markdown,
            format!(
                "{}\n\n# 项目覆盖规则\n只使用已确认目标。",
                sion_core::agent_rule(WorkflowNodeId::Goals)
            )
        );
    }

    #[test]
    fn empty_agent_override_is_not_part_of_effective_rules() {
        let rules = conversation_runtime::compose_effective_agent_rules(
            WorkflowNodeId::BasicInfo,
            Some(" \n ".to_string()),
        );
        assert_eq!(rules.custom_markdown, None);
        assert_eq!(rules.effective_markdown, rules.built_in_markdown);
    }

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
        provider_settings::save(
            &provider_root,
            provider_settings::ProviderInput {
                id: "provider-a".into(),
                name: "Provider A".into(),
                api_base_url: "https://example.invalid/v1".into(),
                api_url_mode: "base".into(),
                protocol: "chat_completions".into(),
                is_default: true,
                api_key: Some("secret".into()),
                now: "now".into(),
                models: vec![provider_settings::ProviderModel {
                    name: "model-a".into(),
                    is_default: true,
                    tool_calling: false,
                    context_window_tokens: Some(window),
                }],
            },
        )
        .unwrap();
        let selection = ChatModelSelection {
            provider_id: "provider-a".into(),
            model: "model-a".into(),
            reasoning_effort: ReasoningEffort::High,
        };
        let session = store
            .create_session(
                WorkflowNodeId::Goals,
                "会话".into(),
                Some(selection),
                "now".into(),
            )
            .unwrap();
        let source = root.join("brief.md");
        std::fs::write(&source, "brief content").unwrap();
        let file = store.import_file(&source, "now".into()).unwrap();
        SendFixture {
            root,
            provider_root,
            store,
            session,
            file,
        }
    }

    #[test]
    fn blocked_context_does_not_append_a_message_or_run() {
        let fixture = send_fixture(8);
        let before_messages = fixture
            .store
            .messages(WorkflowNodeId::Goals, &fixture.session.id)
            .unwrap();
        let before_turns = fixture
            .store
            .turns(WorkflowNodeId::Goals, &fixture.session.id)
            .unwrap();
        let before_runs = fixture.store.list_runs().unwrap();
        let prepared = prepare_agent_send(
            &fixture.provider_root,
            &fixture.store,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            "this input is intentionally too large",
            &[],
            "now",
        )
        .unwrap();
        assert_eq!(
            prepared.snapshot.status,
            sion_core::ContextEstimateStatus::Blocked
        );
        assert!(prepared.snapshot.estimated_input_tokens > 8);
        assert!(!largest_context_section(&prepared.snapshot).is_empty());
        assert_eq!(
            fixture
                .store
                .messages(WorkflowNodeId::Goals, &fixture.session.id)
                .unwrap(),
            before_messages
        );
        assert_eq!(
            fixture
                .store
                .turns(WorkflowNodeId::Goals, &fixture.session.id)
                .unwrap(),
            before_turns
        );
        assert_eq!(fixture.store.list_runs().unwrap(), before_runs);
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn successful_send_snapshots_files_and_freezes_run_values() {
        let fixture = send_fixture(128_000);
        let prepared = prepare_agent_send(
            &fixture.provider_root,
            &fixture.store,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            "use the brief",
            std::slice::from_ref(&fixture.file.id),
            "now",
        )
        .unwrap();
        assert_eq!(
            prepared.user_message.attachments[0].original_name,
            fixture.file.original_name
        );
        let mut scheduler = sion_agent::RunScheduler::default();
        let run = scheduler
            .enqueue(prepared.run_request("project-1".into(), WorkflowNodeId::Goals, "now".into()))
            .unwrap();
        assert_eq!(run.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(run.file_ids, vec![fixture.file.id.clone()]);
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn run_persistence_failure_does_not_commit_the_user_message() {
        let fixture = send_fixture(128_000);
        let prepared = prepare_agent_send(
            &fixture.provider_root,
            &fixture.store,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            "use the brief",
            &[],
            "now",
        )
        .unwrap();
        let runs_path = fixture.root.join("projects/project-1/runs");
        std::fs::remove_dir_all(&runs_path).unwrap();
        std::fs::write(&runs_path, "not a directory").unwrap();
        let mut scheduler = sion_agent::RunScheduler::default();
        let run_request =
            prepared.run_request("project-1".into(), WorkflowNodeId::Goals, "now".into());
        let result = persist_prepared_send(
            &fixture.store,
            &mut scheduler,
            run_request,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            prepared.user_message,
            prepared.turn_id,
            7,
            true,
            "now".into(),
        );
        assert!(result.is_err());
        assert!(
            fixture
                .store
                .messages(WorkflowNodeId::Goals, &fixture.session.id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(scheduler.active_count(), 0);
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn prepared_send_persists_user_message_and_turn_with_one_turn_id() {
        let fixture = send_fixture(128_000);
        let prepared = prepare_agent_send(
            &fixture.provider_root,
            &fixture.store,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            "补充目标",
            &[],
            "now",
        )
        .unwrap();
        let run_request =
            prepared.run_request("project-1".into(), WorkflowNodeId::Goals, "now".into());
        let mut scheduler = sion_agent::RunScheduler::default();
        let result = persist_prepared_send(
            &fixture.store,
            &mut scheduler,
            run_request,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            prepared.user_message,
            prepared.turn_id,
            4,
            true,
            "now".into(),
        )
        .unwrap();
        let turns = fixture
            .store
            .turns(WorkflowNodeId::Goals, &fixture.session.id)
            .unwrap();
        assert_eq!(turns, vec![result.turn.clone()]);
        assert_eq!(result.turn.status, TurnStatus::Running);
        assert_eq!(result.turn.activities.len(), 4);
        assert_eq!(
            result.turn.activities[0].status,
            sion_core::TurnActivityStatus::Running
        );
        assert_eq!(
            fixture
                .store
                .messages(WorkflowNodeId::Goals, &fixture.session.id)
                .unwrap()[0]
                .turn_id,
            Some(result.turn.id),
        );
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn run_detail_loads_linked_turn_and_assistant_without_prompt_data() {
        let fixture = send_fixture(128_000);
        let prepared = prepare_agent_send(
            &fixture.provider_root,
            &fixture.store,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            "补充目标",
            &[],
            "now",
        )
        .unwrap();
        let mut scheduler = sion_agent::RunScheduler::default();
        let started = persist_prepared_send(
            &fixture.store,
            &mut scheduler,
            prepared.run_request("project-1".into(), WorkflowNodeId::Goals, "now".into()),
            WorkflowNodeId::Goals,
            &fixture.session.id,
            prepared.user_message,
            prepared.turn_id,
            0,
            true,
            "now".into(),
        )
        .unwrap();
        let mut turn = started.turn.clone();
        turn.assistant_message_id = Some("assistant-detail".into());
        turn.status = TurnStatus::Completed;
        fixture
            .store
            .complete_turn(
                WorkflowNodeId::Goals,
                &fixture.session.id,
                ChatMessage {
                    id: "assistant-detail".into(),
                    role: ChatRole::Assistant,
                    content: "可见回复".into(),
                    reasoning_content: None,
                    sources: None,
                    created_at: "later".into(),
                    turn_id: Some(turn.id.clone()),
                    reasoning_duration_ms: None,
                    usage: None,
                    attachments: vec![],
                    model_execution: None,
                },
                turn.clone(),
            )
            .unwrap();

        let detail = load_run_detail(&fixture.store, "project-1", &started.run.id).unwrap();
        assert_eq!(detail.turn.unwrap().id, turn.id);
        assert_eq!(detail.assistant_message.unwrap().content, "可见回复");
        let serialized = serde_json::to_value(&detail.run).unwrap();
        assert!(serialized.get("prompt").is_none());
        assert!(load_run_detail(&fixture.store, "other-project", &started.run.id).is_err());
        assert!(load_run_detail(&fixture.store, "project-1", "missing-run").is_err());
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn listing_turns_does_not_recover_a_live_turn() {
        let fixture = send_fixture(128_000);
        let prepared = prepare_agent_send(
            &fixture.provider_root,
            &fixture.store,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            "补充目标",
            &[],
            "now",
        )
        .unwrap();
        let mut scheduler = sion_agent::RunScheduler::default();
        let result = persist_prepared_send(
            &fixture.store,
            &mut scheduler,
            prepared.run_request("project-1".into(), WorkflowNodeId::Goals, "now".into()),
            WorkflowNodeId::Goals,
            &fixture.session.id,
            prepared.user_message,
            prepared.turn_id,
            0,
            true,
            "now".into(),
        )
        .unwrap();

        let turns = list_conversation_turns(
            &fixture.store,
            &scheduler,
            WorkflowNodeId::Goals,
            &fixture.session.id,
            "listed",
        )
        .unwrap();
        assert_eq!(turns[0].id, result.turn.id);
        assert_eq!(turns[0].status, TurnStatus::Running);
        assert_eq!(
            fixture
                .store
                .turns(WorkflowNodeId::Goals, &fixture.session.id)
                .unwrap()[0]
                .status,
            TurnStatus::Running
        );
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn agent_run_start_request_requires_expected_revision_and_delivery_write_allowed() {
        let request: AgentRunStartRequest = serde_json::from_value(serde_json::json!({
            "apiVersion": 1,
            "projectId": "p",
            "nodeId": "goals",
            "sessionId": "s",
            "message": "m",
            "fileIds": [],
            "expectedRevision": 7,
            "deliveryWriteAllowed": true,
            "now": "now"
        }))
        .unwrap();
        assert_eq!(request.expected_revision, 7);
        assert!(request.delivery_write_allowed);
        assert!(
            serde_json::from_value::<AgentRunStartRequest>(serde_json::json!({
                "apiVersion": 1,
                "projectId": "p",
                "nodeId": "goals",
                "sessionId": "s",
                "message": "m",
                "fileIds": [],
                "deliveryWriteAllowed": true,
                "now": "now"
            }))
            .is_err()
        );
    }

    fn test_delivery_job(
        fixture: &SendFixture,
        expected_revision: u64,
        delivery_write_allowed: bool,
    ) -> AgentJob {
        let resolved =
            provider_settings::resolve_model(&fixture.provider_root, "provider-a", "model-a")
                .unwrap();
        AgentJob {
            project_root: fixture.root.join("projects").join("project-1"),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: fixture.session.id.clone(),
            prompt: "prompt".into(),
            model: resolved,
            reasoning_effort: ReasoningEffort::Medium,
            cancellation: CancellationToken::new(),
            turn_id: "turn-1".into(),
            expected_revision,
            delivery_write_allowed,
            started_instant: Instant::now(),
        }
    }

    #[test]
    fn apply_delivery_outcome_handles_unchanged_patch_and_conflict() {
        let fixture = send_fixture(128_000);
        let node = fixture.store.node(WorkflowNodeId::Goals).unwrap();
        let saved = fixture
            .store
            .save_node_if_revision(
                WorkflowNodeId::Goals,
                node.revision,
                "# 需求背景与建设目标\n\n## 需求背景\n已有\n\n## 建设目标\n已有\n\n## 范围边界\n已有"
                    .into(),
                NodeStatus::Draft,
                "now".into(),
            )
            .unwrap();
        let SaveNodeResult::Saved(saved) = saved else {
            unreachable!()
        };
        let base_revision = saved.revision;

        let job = test_delivery_job(&fixture, base_revision, true);
        let application = apply_delivery_outcome(
            &fixture.store,
            AgentDelivery::Unchanged,
            fixture.store.node(WorkflowNodeId::Goals).ok(),
            &job,
            "now",
        );
        assert_eq!(application.outcome, DeliveryOutcome::Unchanged);
        assert!(application.saved_node.is_none());
        assert_eq!(
            fixture.store.node(WorkflowNodeId::Goals).unwrap().revision,
            base_revision
        );

        let patch = AgentDelivery::Patch {
            sections: vec![sion_core::AgentDeliverySection {
                title: "建设目标".into(),
                content: "补充后的目标".into(),
            }],
        };
        let application = apply_delivery_outcome(
            &fixture.store,
            patch,
            fixture.store.node(WorkflowNodeId::Goals).ok(),
            &job,
            "now",
        );
        assert!(matches!(
            application.outcome,
            DeliveryOutcome::PatchApplied { revision, .. } if revision == base_revision + 1
        ));
        assert_eq!(
            application.saved_node.as_ref().map(|node| node.revision),
            Some(base_revision + 1)
        );

        let latest_revision = fixture.store.node(WorkflowNodeId::Goals).unwrap().revision;
        let stale_job = test_delivery_job(&fixture, base_revision, true);
        let patch2 = AgentDelivery::Patch {
            sections: vec![sion_core::AgentDeliverySection {
                title: "建设目标".into(),
                content: "再次补充".into(),
            }],
        };
        let application = apply_delivery_outcome(
            &fixture.store,
            patch2,
            fixture.store.node(WorkflowNodeId::Goals).ok(),
            &stale_job,
            "now",
        );
        assert!(matches!(
            application.outcome,
            DeliveryOutcome::Conflict { expected_revision, actual_revision }
                if expected_revision == base_revision && actual_revision == latest_revision
        ));
        assert!(application.saved_node.is_none());
        assert_eq!(
            fixture.store.node(WorkflowNodeId::Goals).unwrap().revision,
            latest_revision
        );
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn invalid_or_stale_regeneration_never_replaces_the_node() {
        let fixture = send_fixture(128_000);
        let valid_markdown =
            "# 需求背景与建设目标\n\n## 需求背景\n已有\n\n## 建设目标\n已有\n\n## 范围边界\n已有";
        let before = fixture.store.node(WorkflowNodeId::Goals).unwrap();
        let saved = fixture
            .store
            .save_node_if_revision(
                WorkflowNodeId::Goals,
                before.revision,
                valid_markdown.to_string(),
                NodeStatus::Draft,
                "initial".into(),
            )
            .unwrap();
        let SaveNodeResult::Saved(initial) = saved else {
            unreachable!()
        };
        let newer = fixture
            .store
            .save_node_if_revision(
                WorkflowNodeId::Goals,
                initial.revision,
                initial.markdown.clone(),
                NodeStatus::Draft,
                "newer".into(),
            )
            .unwrap();
        let SaveNodeResult::Saved(newer_node) = newer else {
            unreachable!()
        };
        let result = commit_regenerated_markdown(
            &fixture.store,
            WorkflowNodeId::Goals,
            initial.revision,
            initial.markdown.clone(),
            "finished".into(),
        )
        .unwrap();
        assert!(matches!(
            result,
            RegenerationCommitResult::Conflict { ref latest } if latest.revision == newer_node.revision
        ));
        assert_eq!(
            fixture.store.node(WorkflowNodeId::Goals).unwrap().revision,
            newer_node.revision
        );
        std::fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn regeneration_status_tracks_the_scheduler_run_status() {
        assert!(matches!(
            generation_status_for_run(sion_agent::AgentRunStatus::Queued),
            DeliveryGenerationStatus::Queued
        ));
        assert!(matches!(
            generation_status_for_run(sion_agent::AgentRunStatus::Running),
            DeliveryGenerationStatus::Running
        ));
    }

    #[test]
    fn finishing_regeneration_returns_the_run_promoted_by_the_scheduler() {
        let mut scheduler = sion_agent::RunScheduler::new(1);
        let regeneration = scheduler
            .enqueue(sion_agent::RunRequest {
                project_id: "project-1".into(),
                node_id: WorkflowNodeId::Goals,
                provider_id: "provider".into(),
                model: "model".into(),
                reasoning_effort: ReasoningEffort::Medium,
                file_ids: Vec::new(),
                kind: sion_agent::AgentRunKind::DeliveryRegeneration,
                created_at: "started".into(),
                session_id: None,
                turn_id: None,
                context_snapshot: None,
            })
            .unwrap();
        let queued = scheduler
            .enqueue(sion_agent::RunRequest {
                project_id: "project-1".into(),
                node_id: WorkflowNodeId::BasicInfo,
                provider_id: "provider".into(),
                model: "model".into(),
                reasoning_effort: ReasoningEffort::Medium,
                file_ids: Vec::new(),
                kind: sion_agent::AgentRunKind::Conversation,
                created_at: "queued".into(),
                session_id: None,
                turn_id: None,
                context_snapshot: None,
            })
            .unwrap();
        assert_eq!(queued.status, sion_agent::AgentRunStatus::Queued);

        let (_, promoted) = finish_regeneration_scheduler(
            &mut scheduler,
            &regeneration.id,
            "finished",
            &DeliveryGenerationStatus::Completed,
            None,
        );
        assert_eq!(promoted.len(), 1);
        assert_eq!(promoted[0].id, queued.id);
        assert_eq!(promoted[0].status, sion_agent::AgentRunStatus::Running);
    }
}
