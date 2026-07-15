mod docx_check;
mod keyring_check;
mod migration;
mod provider_migration;
#[allow(dead_code)]
mod streaming;

use serde::{Deserialize, Serialize};
use sion_core::{
    ChatMessage, ChatSession, NodeStatus, ProjectManifest, WorkflowNode, WorkflowNodeId,
};
use sion_storage::{
    CreateProjectInput, ProjectRegistry, ProjectStore, RecentProject, SaveNodeResult,
};
use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const API_VERSION: u16 = 1;

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
fn project_create(
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
        .invoke_handler(tauri::generate_handler![
            app_get_version,
            spike_docx_check,
            spike_keyring_check,
            migration_inspect,
            migration_run,
            provider_migration_inspect,
            provider_migration_run,
            project_create,
            project_list,
            project_get_node,
            project_save_node,
            session_list,
            session_create,
            message_list,
            message_append
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
}
