//! Filesystem-backed `.sion` project storage.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;
use sion_core::{
    ChatMessage, ChatSession, NodeStatus, PROJECT_SCHEMA_VERSION, ProjectManifest, WorkflowNode,
    WorkflowNodeId, default_nodes,
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("project already contains .sion")]
    AlreadyInitialized,
    #[error("project does not contain .sion")]
    NotInitialized,
    #[error("project {0} is not registered")]
    NotRegistered(String),
    #[error("chat session id is unsafe: {0}")]
    UnsafeSessionId(String),
    #[error("chat session {0} does not exist")]
    SessionNotFound(String),
    #[error("chat message count exceeds the supported range")]
    MessageCountOverflow,
    #[error("project uses schema {found}, but this app supports up to {supported}")]
    UnsupportedSchema { found: u32, supported: u32 },
    #[error("project JSON is invalid at {path}: {source}")]
    InvalidJson {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("filesystem operation failed at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

pub type Result<T> = std::result::Result<T, StorageError>;

#[derive(Debug, Clone)]
pub struct CreateProjectInput {
    pub id: String,
    pub name: String,
    pub customer_name: String,
    pub author_name: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveNodeResult {
    Saved(WorkflowNode),
    Conflict { latest: WorkflowNode },
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingMessageAppend {
    session_id: String,
    message: ChatMessage,
    updated_at: String,
}

#[derive(Debug, Clone)]
pub struct ProjectStore {
    project_root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub name: String,
    pub root_path: PathBuf,
    pub opened_at: String,
}

#[derive(Debug, Clone)]
pub struct ProjectRegistry {
    app_data_root: PathBuf,
}

impl ProjectRegistry {
    pub fn at(app_data_root: impl Into<PathBuf>) -> Self {
        Self {
            app_data_root: app_data_root.into(),
        }
    }

    pub fn list(&self) -> Result<Vec<RecentProject>> {
        let path = self.file_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        read_json(&path)
    }

    pub fn register(
        &self,
        manifest: &ProjectManifest,
        root_path: PathBuf,
        opened_at: String,
    ) -> Result<()> {
        let mut projects = self.list()?;
        projects.retain(|project| project.id != manifest.id);
        projects.push(RecentProject {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            root_path,
            opened_at,
        });
        projects.sort_by(|left, right| right.opened_at.cmp(&left.opened_at));
        projects.truncate(20);
        atomic_write_json(&self.file_path(), &projects)
    }

    pub fn resolve(&self, project_id: &str) -> Result<PathBuf> {
        self.list()?
            .into_iter()
            .find(|project| project.id == project_id)
            .map(|project| project.root_path)
            .ok_or_else(|| StorageError::NotRegistered(project_id.to_string()))
    }

    fn file_path(&self) -> PathBuf {
        self.app_data_root.join("registry.json")
    }
}

impl ProjectStore {
    pub fn at(project_root: impl Into<PathBuf>) -> Self {
        Self {
            project_root: project_root.into(),
        }
    }

    pub fn create(&self, input: CreateProjectInput) -> Result<ProjectManifest> {
        let destination = self.sion_dir();
        if destination.exists() {
            return Err(StorageError::AlreadyInitialized);
        }
        let staging = self
            .project_root
            .join(format!(".sion.creating-{}", Uuid::new_v4()));
        create_dir_all(&staging)?;
        let result = (|| {
            let manifest = ProjectManifest {
                schema_version: PROJECT_SCHEMA_VERSION,
                id: input.id,
                name: input.name,
                customer_name: input.customer_name,
                author_name: input.author_name,
                version: "V1.0".to_string(),
                created_at: input.now.clone(),
                updated_at: input.now.clone(),
            };
            atomic_write_json(&staging.join("manifest.json"), &manifest)?;
            for node in default_nodes(input.now) {
                atomic_write_json(
                    &staging
                        .join("nodes")
                        .join(format!("{}.json", node.id.as_str())),
                    &node,
                )?;
            }
            for directory in ["chat", "files", "agent-overrides", "exports", "runs"] {
                create_dir_all(&staging.join(directory))?;
            }
            for node_id in WorkflowNodeId::ALL {
                atomic_write_json(
                    &staging
                        .join("chat")
                        .join(node_id.as_str())
                        .join("sessions.json"),
                    &Vec::<ChatSession>::new(),
                )?;
            }
            atomic_write_json(
                &staging.join("files/index.json"),
                &Vec::<serde_json::Value>::new(),
            )?;
            sync_directory(&staging)?;
            fs::rename(&staging, &destination).map_err(|source| StorageError::Io {
                path: destination.clone(),
                source,
            })?;
            sync_directory(&self.project_root)?;
            Ok(manifest)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub fn manifest(&self) -> Result<ProjectManifest> {
        let manifest: ProjectManifest = read_json(&self.sion_dir().join("manifest.json"))?;
        if manifest.schema_version > PROJECT_SCHEMA_VERSION {
            return Err(StorageError::UnsupportedSchema {
                found: manifest.schema_version,
                supported: PROJECT_SCHEMA_VERSION,
            });
        }
        Ok(manifest)
    }

    pub fn list_nodes(&self) -> Result<Vec<WorkflowNode>> {
        self.manifest()?;
        WorkflowNodeId::ALL
            .into_iter()
            .map(|id| self.node(id))
            .collect()
    }

    pub fn node(&self, id: WorkflowNodeId) -> Result<WorkflowNode> {
        self.manifest()?;
        read_json(&self.node_path(id))
    }

    pub fn save_node_if_revision(
        &self,
        id: WorkflowNodeId,
        expected_revision: u64,
        markdown: String,
        status: NodeStatus,
        now: String,
    ) -> Result<SaveNodeResult> {
        let latest = self.node(id)?;
        if latest.revision != expected_revision {
            return Ok(SaveNodeResult::Conflict { latest });
        }
        let saved = WorkflowNode {
            id,
            status,
            markdown,
            revision: latest.revision + 1,
            updated_at: now,
        };
        atomic_write_json(&self.node_path(id), &saved)?;
        Ok(SaveNodeResult::Saved(saved))
    }

    pub fn list_sessions(&self, node_id: WorkflowNodeId) -> Result<Vec<ChatSession>> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        let path = self.sessions_path(node_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let mut sessions: Vec<ChatSession> = read_json(&path)?;
        sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(sessions)
    }

    pub fn create_session(
        &self,
        node_id: WorkflowNodeId,
        name: String,
        now: String,
    ) -> Result<ChatSession> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        let session = ChatSession {
            id: Uuid::new_v4().to_string(),
            node_id,
            name,
            message_count: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        atomic_write_json(
            &self.messages_path(node_id, &session.id)?,
            &Vec::<ChatMessage>::new(),
        )?;
        let mut sessions = self.list_sessions(node_id)?;
        sessions.push(session.clone());
        sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        atomic_write_json(&self.sessions_path(node_id), &sessions)?;
        Ok(session)
    }

    pub fn messages(&self, node_id: WorkflowNodeId, session_id: &str) -> Result<Vec<ChatMessage>> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        self.require_session(node_id, session_id)?;
        read_json(&self.messages_path(node_id, session_id)?)
    }

    /// Appends a fully formed message with a small write-ahead journal so an
    /// interruption cannot silently lose a message or leave the session count stale.
    pub fn append_message(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        message: ChatMessage,
        updated_at: String,
    ) -> Result<ChatSession> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        self.require_session(node_id, session_id)?;
        let journal = PendingMessageAppend {
            session_id: session_id.to_string(),
            message: message.clone(),
            updated_at: updated_at.clone(),
        };
        atomic_write_json(&self.append_journal_path(node_id), &journal)?;

        let mut messages: Vec<ChatMessage> = read_json(&self.messages_path(node_id, session_id)?)?;
        if !messages.iter().any(|item| item.id == message.id) {
            messages.push(message);
            atomic_write_json(&self.messages_path(node_id, session_id)?, &messages)?;
        }
        let session =
            self.update_session_metadata(node_id, session_id, messages.len(), updated_at)?;
        fs::remove_file(self.append_journal_path(node_id)).map_err(|source| StorageError::Io {
            path: self.append_journal_path(node_id),
            source,
        })?;
        Ok(session)
    }

    fn recover_pending_append(&self, node_id: WorkflowNodeId) -> Result<()> {
        let journal_path = self.append_journal_path(node_id);
        if !journal_path.exists() {
            return Ok(());
        }
        let pending: PendingMessageAppend = read_json(&journal_path)?;
        self.require_session(node_id, &pending.session_id)?;
        let message_path = self.messages_path(node_id, &pending.session_id)?;
        let mut messages: Vec<ChatMessage> = read_json(&message_path)?;
        if !messages
            .iter()
            .any(|message| message.id == pending.message.id)
        {
            messages.push(pending.message);
            atomic_write_json(&message_path, &messages)?;
        }
        self.update_session_metadata(
            node_id,
            &pending.session_id,
            messages.len(),
            pending.updated_at,
        )?;
        fs::remove_file(&journal_path).map_err(|source| StorageError::Io {
            path: journal_path,
            source,
        })
    }

    fn update_session_metadata(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        message_count: usize,
        updated_at: String,
    ) -> Result<ChatSession> {
        let count = u32::try_from(message_count).map_err(|_| StorageError::MessageCountOverflow)?;
        let mut sessions = self.read_sessions(node_id)?;
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))?;
        session.message_count = count;
        session.updated_at = updated_at;
        let updated = session.clone();
        atomic_write_json(&self.sessions_path(node_id), &sessions)?;
        Ok(updated)
    }

    fn require_session(&self, node_id: WorkflowNodeId, session_id: &str) -> Result<()> {
        self.messages_path(node_id, session_id)?;
        if self
            .read_sessions(node_id)?
            .iter()
            .any(|session| session.id == session_id)
        {
            Ok(())
        } else {
            Err(StorageError::SessionNotFound(session_id.to_string()))
        }
    }

    fn read_sessions(&self, node_id: WorkflowNodeId) -> Result<Vec<ChatSession>> {
        let path = self.sessions_path(node_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        read_json(&path)
    }

    fn sion_dir(&self) -> PathBuf {
        self.project_root.join(".sion")
    }
    fn node_path(&self, id: WorkflowNodeId) -> PathBuf {
        self.sion_dir()
            .join("nodes")
            .join(format!("{}.json", id.as_str()))
    }
    fn chat_node_dir(&self, id: WorkflowNodeId) -> PathBuf {
        self.sion_dir().join("chat").join(id.as_str())
    }
    fn sessions_path(&self, id: WorkflowNodeId) -> PathBuf {
        self.chat_node_dir(id).join("sessions.json")
    }
    fn messages_path(&self, id: WorkflowNodeId, session_id: &str) -> Result<PathBuf> {
        if !is_safe_file_component(session_id) {
            return Err(StorageError::UnsafeSessionId(session_id.to_string()));
        }
        Ok(self.chat_node_dir(id).join(format!("{session_id}.json")))
    }
    fn append_journal_path(&self, id: WorkflowNodeId) -> PathBuf {
        self.chat_node_dir(id).join(".append-journal.json")
    }
}

fn is_safe_file_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains('\0')
}

fn create_dir_all(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|source| StorageError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let raw = fs::read_to_string(path).map_err(|source| StorageError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str(&raw).map_err(|source| StorageError::InvalidJson {
        path: path.to_path_buf(),
        source,
    })
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .expect("project state paths always have a parent");
    create_dir_all(parent)?;
    let staging = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(value).expect("serializable project domain types");
    let result = (|| {
        let mut file = fs::File::create(&staging).map_err(|source| StorageError::Io {
            path: staging.clone(),
            source,
        })?;
        file.write_all(&bytes).map_err(|source| StorageError::Io {
            path: staging.clone(),
            source,
        })?;
        file.write_all(b"\n").map_err(|source| StorageError::Io {
            path: staging.clone(),
            source,
        })?;
        file.sync_all().map_err(|source| StorageError::Io {
            path: staging.clone(),
            source,
        })?;
        fs::rename(&staging, path).map_err(|source| StorageError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| StorageError::Io {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        std::env::temp_dir().join(format!("sion-storage-test-{}", Uuid::new_v4()))
    }
    fn input() -> CreateProjectInput {
        CreateProjectInput {
            id: "project-1".to_string(),
            name: "项目".to_string(),
            customer_name: "客户".to_string(),
            author_name: "作者".to_string(),
            now: "2026-07-15T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn creates_full_sion_layout_and_reopens_it() {
        let root = temp_project();
        let store = ProjectStore::at(&root);
        let manifest = store.create(input()).unwrap();
        assert_eq!(manifest.schema_version, PROJECT_SCHEMA_VERSION);
        assert!(root.join(".sion/runs").is_dir());
        assert_eq!(store.list_nodes().unwrap().len(), 12);
        assert!(
            store
                .list_sessions(WorkflowNodeId::Goals)
                .unwrap()
                .is_empty()
        );
        assert_eq!(ProjectStore::at(&root).manifest().unwrap().name, "项目");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_revision_returns_latest_without_overwriting_it() {
        let root = temp_project();
        let store = ProjectStore::at(&root);
        store.create(input()).unwrap();
        let first = store
            .save_node_if_revision(
                WorkflowNodeId::Goals,
                0,
                "# 新内容".to_string(),
                NodeStatus::Draft,
                "2026-07-15T00:01:00.000Z".to_string(),
            )
            .unwrap();
        assert!(matches!(first, SaveNodeResult::Saved(_)));
        let stale = store
            .save_node_if_revision(
                WorkflowNodeId::Goals,
                0,
                "# 旧内容".to_string(),
                NodeStatus::Generated,
                "2026-07-15T00:02:00.000Z".to_string(),
            )
            .unwrap();
        assert!(
            matches!(stale, SaveNodeResult::Conflict { ref latest } if latest.markdown == "# 新内容" && latest.revision == 1)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_write_a_project_with_a_future_schema() {
        let root = temp_project();
        let store = ProjectStore::at(&root);
        store.create(input()).unwrap();
        let manifest = root.join(".sion/manifest.json");
        let mut raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest).unwrap()).unwrap();
        raw["schema_version"] = serde_json::json!(PROJECT_SCHEMA_VERSION + 1);
        fs::write(&manifest, serde_json::to_vec(&raw).unwrap()).unwrap();
        assert!(matches!(
            store.node(WorkflowNodeId::Goals),
            Err(StorageError::UnsupportedSchema { .. })
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_persists_recent_projects_without_storing_project_contents() {
        let root = temp_project();
        let registry = ProjectRegistry::at(&root);
        let manifest = ProjectManifest {
            schema_version: PROJECT_SCHEMA_VERSION,
            id: "project-1".to_string(),
            name: "项目一".to_string(),
            customer_name: "客户".to_string(),
            author_name: "作者".to_string(),
            version: "V1.0".to_string(),
            created_at: "2026-07-15T00:00:00.000Z".to_string(),
            updated_at: "2026-07-15T00:00:00.000Z".to_string(),
        };
        let project_root = PathBuf::from("/Users/test/Documents/Sion/项目一");
        registry
            .register(
                &manifest,
                project_root.clone(),
                "2026-07-15T00:02:00.000Z".to_string(),
            )
            .unwrap();

        assert_eq!(registry.resolve("project-1").unwrap(), project_root);
        let raw = fs::read_to_string(root.join("registry.json")).unwrap();
        assert!(!raw.contains("customerName"));
        assert!(!raw.contains("authorName"));
        fs::remove_dir_all(root).unwrap();
    }

    fn chat_message(id: &str, role: sion_core::ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: id.to_string(),
            role,
            content: content.to_string(),
            reasoning_content: None,
            sources: None,
            created_at: "2026-07-15T00:03:00.000Z".to_string(),
            turn_id: None,
            reasoning_duration_ms: None,
            usage: None,
        }
    }

    #[test]
    fn persists_sessions_and_messages_inside_the_project_state() {
        let root = temp_project();
        let store = ProjectStore::at(&root);
        store.create(input()).unwrap();
        let session = store
            .create_session(
                WorkflowNodeId::Goals,
                "需求讨论".to_string(),
                "2026-07-15T00:02:00.000Z".to_string(),
            )
            .unwrap();
        let updated = store
            .append_message(
                WorkflowNodeId::Goals,
                &session.id,
                chat_message("user-1", sion_core::ChatRole::User, "请整理目标"),
                "2026-07-15T00:03:00.000Z".to_string(),
            )
            .unwrap();

        assert_eq!(updated.message_count, 1);
        assert_eq!(
            store
                .messages(WorkflowNodeId::Goals, &session.id)
                .unwrap()
                .len(),
            1
        );
        assert!(
            root.join(format!(".sion/chat/goals/{}.json", session.id))
                .is_file()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovers_an_interrupted_message_append_without_duplication() {
        let root = temp_project();
        let store = ProjectStore::at(&root);
        store.create(input()).unwrap();
        let session = store
            .create_session(
                WorkflowNodeId::Goals,
                "恢复测试".to_string(),
                "2026-07-15T00:02:00.000Z".to_string(),
            )
            .unwrap();
        let message = chat_message("assistant-1", sion_core::ChatRole::Assistant, "已完成");
        atomic_write_json(
            &store
                .messages_path(WorkflowNodeId::Goals, &session.id)
                .unwrap(),
            &vec![message.clone()],
        )
        .unwrap();
        atomic_write_json(
            &store.append_journal_path(WorkflowNodeId::Goals),
            &PendingMessageAppend {
                session_id: session.id.clone(),
                message,
                updated_at: "2026-07-15T00:04:00.000Z".to_string(),
            },
        )
        .unwrap();

        let sessions = store.list_sessions(WorkflowNodeId::Goals).unwrap();
        assert_eq!(sessions[0].message_count, 1);
        assert_eq!(
            store
                .messages(WorkflowNodeId::Goals, &session.id)
                .unwrap()
                .len(),
            1
        );
        assert!(!store.append_journal_path(WorkflowNodeId::Goals).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
