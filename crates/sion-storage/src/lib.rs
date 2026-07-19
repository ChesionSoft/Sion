//! Filesystem-backed direct project storage.

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use calamine::{Reader, open_workbook_auto};
use serde::Serialize;
use sion_agent::AgentRun;
use sion_core::{
    ChatMessage, ChatModelSelection, ChatSession, ConversationTurn, CumulativeTokenUsage,
    FileExtractionStatus, NodeStatus, PROJECT_SCHEMA_VERSION, ProjectFile, ProjectFileKind,
    ProjectManifest, TurnActivityStatus, TurnStatus, WorkflowNode, WorkflowNodeId,
    aggregate_message_usage, aggregate_usages, default_nodes,
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("project destination already exists")]
    AlreadyInitialized,
    #[error("project is not initialized")]
    NotInitialized,
    #[error("project {0} is not registered")]
    NotRegistered(String),
    #[error("project id is unsafe: {0}")]
    UnsafeProjectId(String),
    #[error("chat session id is unsafe: {0}")]
    UnsafeSessionId(String),
    #[error("chat session {0} does not exist")]
    SessionNotFound(String),
    #[error("chat message count exceeds the supported range")]
    MessageCountOverflow,
    #[error("turn {turn_id} does not belong to session {session_id}")]
    TurnPathMismatch { turn_id: String, session_id: String },
    #[error("file path has no usable filename: {0}")]
    InvalidFileName(PathBuf),
    #[error("project file {0} does not exist")]
    ProjectFileNotFound(String),
    #[error("agent run id is unsafe: {0}")]
    UnsafeRunId(String),
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

/// Maximum conversation records (chat sessions) retained per workflow node.
/// Creating a new session beyond this cap deletes the oldest sessions, both
/// the index entry and its message file, so 对话记录最多保留这么多条。
const MAX_SESSIONS_PER_NODE: usize = 10;

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

/// A bounded, metadata-preserving preview of a project attachment's extracted
/// text. `text` is `None` when the file had no extractor; `truncated` is true
/// when the preview was cut short of the full extracted text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub file: ProjectFile,
    pub text: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationDocument {
    #[serde(default)]
    messages: Vec<ChatMessage>,
    #[serde(default)]
    turns: Vec<ConversationTurn>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum StoredConversationDocument {
    Legacy(Vec<ChatMessage>),
    Current(ConversationDocument),
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingConversationWrite {
    session_id: String,
    document: ConversationDocument,
    updated_at: String,
}

fn read_conversation_document(path: &Path) -> Result<ConversationDocument> {
    if !path.exists() {
        return Ok(ConversationDocument {
            messages: Vec::new(),
            turns: Vec::new(),
        });
    }
    match read_json::<StoredConversationDocument>(path)? {
        StoredConversationDocument::Legacy(messages) => Ok(ConversationDocument {
            messages,
            turns: Vec::new(),
        }),
        StoredConversationDocument::Current(document) => Ok(document),
    }
}

fn write_conversation_document(path: &Path, document: &ConversationDocument) -> Result<()> {
    atomic_write_json(path, document)
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

/// Disk-first discovery result. `projects` are the readable project directories
/// found inside the configured container; `warnings` lists unreadable or
/// inconsistent entries without aborting the whole listing. The registry only
/// contributes recent-open timestamps; it never hides an unregistered project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiscovery {
    pub projects: Vec<RecentProject>,
    pub warnings: Vec<String>,
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

    pub fn discover(&self, projects_directory: &Path) -> Result<ProjectDiscovery> {
        let recent: std::collections::HashMap<_, _> = self
            .list()?
            .into_iter()
            .map(|item| (item.id, item.opened_at))
            .collect();
        let entries = fs::read_dir(projects_directory).map_err(|source| StorageError::Io {
            path: projects_directory.to_path_buf(),
            source,
        })?;
        let mut projects = Vec::new();
        let mut warnings = Vec::new();
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) || !is_safe_file_component(&id) {
                continue;
            }
            if !entry.path().join("project.json").is_file() {
                continue;
            }
            let Ok(manifest) = ProjectStore::at(entry.path()).manifest() else {
                if warnings.len() < 20 {
                    warnings.push(format!("无法读取项目：{id}"));
                }
                continue;
            };
            if manifest.id != id {
                if warnings.len() < 20 {
                    warnings.push(format!("项目 ID 与目录不一致：{id}"));
                }
                continue;
            }
            projects.push(RecentProject {
                id: manifest.id.clone(),
                name: manifest.name,
                root_path: entry.path(),
                opened_at: recent
                    .get(&manifest.id)
                    .cloned()
                    .unwrap_or(manifest.updated_at),
            });
        }
        projects.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));
        Ok(ProjectDiscovery { projects, warnings })
    }

    pub fn resolve(&self, projects_directory: &Path, project_id: &str) -> Result<PathBuf> {
        if !is_safe_file_component(project_id) {
            return Err(StorageError::NotRegistered(project_id.to_string()));
        }
        let root = projects_directory.join(project_id);
        let manifest = ProjectStore::at(&root).manifest()?;
        if manifest.id != project_id {
            return Err(StorageError::NotRegistered(project_id.to_string()));
        }
        Ok(root)
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

    pub fn create_in(
        projects_directory: &Path,
        input: CreateProjectInput,
    ) -> Result<ProjectManifest> {
        if !is_safe_file_component(&input.id) {
            return Err(StorageError::UnsafeProjectId(input.id));
        }
        create_dir_all(projects_directory)?;
        let destination = projects_directory.join(&input.id);
        if destination.exists() {
            return Err(StorageError::AlreadyInitialized);
        }
        let staging = projects_directory.join(format!(".{}.creating-{}", input.id, Uuid::new_v4()));
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
            atomic_write_json(&staging.join("project.json"), &manifest)?;
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
                        .join("index.json"),
                    &Vec::<ChatSession>::new(),
                )?;
            }
            atomic_write_json(
                &staging.join("files/index.json"),
                &Vec::<serde_json::Value>::new(),
            )?;
            sync_directory(&staging)?;
            ProjectStore::at(&staging).manifest()?;
            ProjectStore::at(&staging).list_nodes()?;
            fs::rename(&staging, &destination).map_err(|source| StorageError::Io {
                path: destination.clone(),
                source,
            })?;
            sync_directory(projects_directory)?;
            Ok(manifest)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub fn manifest(&self) -> Result<ProjectManifest> {
        let manifest: ProjectManifest = read_json(&self.project_root.join("project.json"))?;
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
        model_selection: Option<ChatModelSelection>,
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
            model_selection,
        };
        write_conversation_document(
            &self.messages_path(node_id, &session.id)?,
            &ConversationDocument {
                messages: Vec::new(),
                turns: Vec::new(),
            },
        )?;
        let mut sessions = self.list_sessions(node_id)?;
        sessions.push(session.clone());
        sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        let sessions = self.prune_excess_sessions(node_id, sessions)?;
        atomic_write_json(&self.sessions_path(node_id), &sessions)?;
        Ok(session)
    }

    /// Deletes a single conversation record: removes its index entry and its
    /// message file. Returns `SessionNotFound` if the session is not listed.
    pub fn delete_session(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
    ) -> Result<()> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        let message_path = self.messages_path(node_id, session_id)?;
        let mut sessions = self.read_sessions(node_id)?;
        let before = sessions.len();
        sessions.retain(|session| session.id != session_id);
        if sessions.len() == before {
            return Err(StorageError::SessionNotFound(session_id.to_string()));
        }
        if message_path.exists() {
            fs::remove_file(&message_path).map_err(|source| StorageError::Io {
                path: message_path.clone(),
                source,
            })?;
        }
        atomic_write_json(&self.sessions_path(node_id), &sessions)
    }

    pub fn session(&self, node_id: WorkflowNodeId, session_id: &str) -> Result<ChatSession> {
        self.read_sessions(node_id)?
            .into_iter()
            .find(|session| session.id == session_id)
            .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))
    }

    pub fn update_session_model(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        model_selection: ChatModelSelection,
        updated_at: String,
    ) -> Result<ChatSession> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        let mut sessions = self.read_sessions(node_id)?;
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))?;
        session.model_selection = Some(model_selection);
        session.updated_at = updated_at;
        let updated = session.clone();
        atomic_write_json(&self.sessions_path(node_id), &sessions)?;
        Ok(updated)
    }

    pub fn messages(&self, node_id: WorkflowNodeId, session_id: &str) -> Result<Vec<ChatMessage>> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        self.require_session(node_id, session_id)?;
        Ok(read_conversation_document(&self.messages_path(node_id, session_id)?)?.messages)
    }

    pub fn turns(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
    ) -> Result<Vec<ConversationTurn>> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        self.require_session(node_id, session_id)?;
        Ok(read_conversation_document(&self.messages_path(node_id, session_id)?)?.turns)
    }

    pub fn session_usage(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
    ) -> Result<CumulativeTokenUsage> {
        self.require_session(node_id, session_id)?;
        let runs = self.list_runs()?;
        let linked_usage = runs
            .iter()
            .filter(|run| run.node_id == node_id && run.session_id.as_deref() == Some(session_id))
            .filter_map(|run| run.usage.as_ref())
            .collect::<Vec<_>>();
        if !linked_usage.is_empty() {
            return Ok(aggregate_usages(linked_usage));
        }
        let messages = self.messages(node_id, session_id)?;
        Ok(aggregate_message_usage(&messages))
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
        let path = self.messages_path(node_id, session_id)?;
        let mut document = read_conversation_document(&path)?;
        if !document.messages.iter().any(|item| item.id == message.id) {
            document.messages.push(message);
        }
        self.persist_conversation(node_id, session_id, &document, updated_at)
    }

    /// Begins a turn by atomically appending the user message and the queued
    /// turn record to the same conversation document.
    pub fn begin_turn(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        user_message: ChatMessage,
        turn: ConversationTurn,
        now: String,
    ) -> Result<ChatSession> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        self.require_session(node_id, session_id)?;
        if turn.node_id != node_id || turn.session_id != session_id {
            return Err(StorageError::TurnPathMismatch {
                turn_id: turn.id,
                session_id: session_id.to_string(),
            });
        }
        let path = self.messages_path(node_id, session_id)?;
        let mut document = read_conversation_document(&path)?;
        if !document
            .messages
            .iter()
            .any(|item| item.id == user_message.id)
        {
            document.messages.push(user_message);
        }
        if !document.turns.iter().any(|item| item.id == turn.id) {
            document.turns.push(turn);
        }
        self.persist_conversation(node_id, session_id, &document, now)
    }

    /// Replaces a single turn by id inside the conversation document.
    pub fn save_turn(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        turn: ConversationTurn,
    ) -> Result<()> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        self.require_session(node_id, session_id)?;
        if turn.node_id != node_id || turn.session_id != session_id {
            return Err(StorageError::TurnPathMismatch {
                turn_id: turn.id,
                session_id: session_id.to_string(),
            });
        }
        let path = self.messages_path(node_id, session_id)?;
        let mut document = read_conversation_document(&path)?;
        match document.turns.iter_mut().find(|item| item.id == turn.id) {
            Some(existing) => *existing = turn.clone(),
            None => document.turns.push(turn.clone()),
        }
        let updated_at = turn
            .finished_at
            .clone()
            .unwrap_or_else(|| turn.started_at.clone());
        self.persist_conversation(node_id, session_id, &document, updated_at)?;
        Ok(())
    }

    /// Atomically appends the completed assistant message and replaces the
    /// corresponding turn snapshot in one conversation-document write.
    pub fn complete_turn(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        assistant_message: ChatMessage,
        turn: ConversationTurn,
    ) -> Result<()> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        self.require_session(node_id, session_id)?;
        if turn.node_id != node_id || turn.session_id != session_id {
            return Err(StorageError::TurnPathMismatch {
                turn_id: turn.id,
                session_id: session_id.to_string(),
            });
        }
        let path = self.messages_path(node_id, session_id)?;
        let mut document = read_conversation_document(&path)?;
        if !document
            .messages
            .iter()
            .any(|item| item.id == assistant_message.id)
        {
            document.messages.push(assistant_message);
        }
        match document.turns.iter_mut().find(|item| item.id == turn.id) {
            Some(existing) => *existing = turn.clone(),
            None => document.turns.push(turn.clone()),
        }
        let updated_at = turn
            .finished_at
            .clone()
            .unwrap_or_else(|| turn.started_at.clone());
        self.persist_conversation(node_id, session_id, &document, updated_at)?;
        Ok(())
    }

    fn persist_conversation(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        document: &ConversationDocument,
        updated_at: String,
    ) -> Result<ChatSession> {
        let journal = PendingConversationWrite {
            session_id: session_id.to_string(),
            document: document.clone(),
            updated_at: updated_at.clone(),
        };
        atomic_write_json(&self.append_journal_path(node_id), &journal)?;
        write_conversation_document(&self.messages_path(node_id, session_id)?, document)?;
        let session =
            self.update_session_metadata(node_id, session_id, document.messages.len(), updated_at)?;
        fs::remove_file(self.append_journal_path(node_id)).map_err(|source| StorageError::Io {
            path: self.append_journal_path(node_id),
            source,
        })?;
        Ok(session)
    }

    pub fn list_files(&self) -> Result<Vec<ProjectFile>> {
        self.manifest()?;
        let index = self.files_index_path();
        if !index.exists() {
            return Ok(Vec::new());
        }
        read_json(&index)
    }

    /// Copies an import source into the project and stores a separately
    /// extracted UTF-8 companion when its format has a supported extractor.
    pub fn import_file(&self, source: &Path, now: String) -> Result<ProjectFile> {
        self.manifest()?;
        let original_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| StorageError::InvalidFileName(source.to_path_buf()))?
            .to_string();
        let extension = source
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
            .unwrap_or_default();
        let metadata = fs::metadata(source).map_err(|source_error| StorageError::Io {
            path: source.to_path_buf(),
            source: source_error,
        })?;
        if !metadata.is_file() {
            return Err(StorageError::InvalidFileName(source.to_path_buf()));
        }

        let id = Uuid::new_v4().to_string();
        let stored_name = format!("{id}{extension}");
        let stored_path = self.files_dir().join(&stored_name);
        copy_file_atomic(source, &stored_path)?;
        let result = (|| {
            let (kind, mime_type) = classify_file(&extension);
            let mut file = ProjectFile {
                id: id.clone(),
                original_name,
                stored_name,
                extension,
                mime_type: mime_type.to_string(),
                byte_size: metadata.len(),
                uploaded_at: now,
                status: "unsupported".to_string(),
                text_path: None,
                character_count: None,
                kind: Some(kind.clone()),
                extraction_status: Some(FileExtractionStatus::Unsupported),
                extraction_error: None,
                page_count: None,
                sheet_count: None,
                truncated: Some(false),
            };
            if is_extractable_kind(&kind) {
                match extract_text(&stored_path, &kind) {
                    Ok((text, sheet_count)) => {
                        let text_name = format!("{id}.txt");
                        atomic_write_bytes(&self.files_dir().join(&text_name), text.as_bytes())?;
                        file.status = "available".to_string();
                        file.text_path = Some(text_name);
                        file.character_count = Some(text.encode_utf16().count() as u64);
                        file.sheet_count = sheet_count;
                        file.extraction_status = Some(FileExtractionStatus::Available);
                    }
                    Err(error) => {
                        file.status = "extraction_failed".to_string();
                        file.extraction_status = Some(FileExtractionStatus::Failed);
                        file.extraction_error = Some(error);
                    }
                }
            }
            let mut files = self.list_files()?;
            files.push(file.clone());
            atomic_write_json(&self.files_index_path(), &files)?;
            Ok(file)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&stored_path);
            let _ = fs::remove_file(self.files_dir().join(format!("{id}.txt")));
        }
        result
    }

    pub fn read_file_text(&self, file_id: &str) -> Result<Option<String>> {
        let file = self
            .list_files()?
            .into_iter()
            .find(|file| file.id == file_id)
            .ok_or_else(|| StorageError::ProjectFileNotFound(file_id.to_string()))?;
        let Some(text_path) = file.text_path else {
            return Ok(None);
        };
        if !is_safe_file_component(&text_path) {
            return Err(StorageError::InvalidFileName(
                self.files_dir().join(text_path),
            ));
        }
        fs::read_to_string(self.files_dir().join(text_path))
            .map(Some)
            .map_err(|source| StorageError::Io {
                path: self.files_dir().join(file.id),
                source,
            })
    }

    /// Returns a bounded preview of an attachment's extracted text. The caller
    /// supplies `max_chars` (the IPC layer caps this for the UI); the store
    /// resolves the file by id only, so a path-traversal id cannot escape the
    /// project's file index.
    pub fn file_preview(&self, file_id: &str, max_chars: usize) -> Result<FilePreview> {
        let file = self
            .list_files()?
            .into_iter()
            .find(|file| file.id == file_id)
            .ok_or_else(|| StorageError::ProjectFileNotFound(file_id.to_string()))?;
        let text = self.read_file_text(file_id)?;
        let (text, truncated) = match text {
            Some(value) => {
                let preview = value.chars().take(max_chars).collect::<String>();
                let truncated = preview.chars().count() < value.chars().count();
                (Some(preview), truncated)
            }
            None => (None, false),
        };
        Ok(FilePreview {
            file,
            text,
            truncated,
        })
    }

    /// Returns a project-specific Agent rule only when one exists. The caller
    /// still supplies the bundled rule as the base policy; an override is an
    /// additive project instruction, never an arbitrary path from IPC.
    pub fn agent_override(&self, node_id: WorkflowNodeId) -> Result<Option<String>> {
        self.manifest()?;
        let path = self.agent_override_path(node_id);
        if !path.exists() {
            return Ok(None);
        }
        fs::read_to_string(&path)
            .map(Some)
            .map_err(|source| StorageError::Io { path, source })
    }

    /// Saves the project-specific additive instruction for a workflow node.
    /// Whitespace-only input deliberately removes the override, returning the
    /// Agent to its bundled default rule without leaving an empty source file.
    pub fn save_agent_override(
        &self,
        node_id: WorkflowNodeId,
        markdown: String,
    ) -> Result<Option<String>> {
        self.manifest()?;
        let path = self.agent_override_path(node_id);
        if markdown.trim().is_empty() {
            match fs::remove_file(&path) {
                Ok(()) => sync_directory(path.parent().expect("override path has a parent"))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => return Err(StorageError::Io { path, source }),
            }
            return Ok(None);
        }
        atomic_write_bytes(&path, markdown.as_bytes())?;
        Ok(Some(markdown))
    }

    /// Persists diagnostic-only run state. Token counts and public summaries may
    /// be retained, but prompt text, raw provider frames, and partial assistant
    /// content never enter this record.
    pub fn save_run(&self, run: &AgentRun) -> Result<()> {
        self.manifest()?;
        atomic_write_json(&self.run_path(&run.id)?, run)
    }

    pub fn run(&self, run_id: &str) -> Result<AgentRun> {
        self.manifest()?;
        read_json(&self.run_path(run_id)?)
    }

    pub fn list_runs(&self) -> Result<Vec<AgentRun>> {
        self.manifest()?;
        let directory = self.runs_dir();
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut runs: Vec<AgentRun> = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|source| StorageError::Io {
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
                runs.push(read_json(&entry.path())?);
            }
        }
        runs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(runs)
    }

    fn recover_pending_append(&self, node_id: WorkflowNodeId) -> Result<()> {
        let journal_path = self.append_journal_path(node_id);
        if !journal_path.exists() {
            return Ok(());
        }
        let pending: PendingConversationWrite = read_json(&journal_path)?;
        self.require_session(node_id, &pending.session_id)?;
        let message_path = self.messages_path(node_id, &pending.session_id)?;
        write_conversation_document(&message_path, &pending.document)?;
        self.update_session_metadata(
            node_id,
            &pending.session_id,
            pending.document.messages.len(),
            pending.updated_at,
        )?;
        fs::remove_file(&journal_path).map_err(|source| StorageError::Io {
            path: journal_path,
            source,
        })
    }

    /// Marks queued/running turns interrupted after an unclean shutdown so stale
    /// in-flight records never survive a restart. Returns every turn snapshot.
    pub fn recover_interrupted_turns(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        now: String,
    ) -> Result<Vec<ConversationTurn>> {
        self.recover_interrupted_turns_except(
            node_id,
            session_id,
            now,
            &std::collections::HashSet::new(),
        )
    }

    pub fn recover_interrupted_turns_except(
        &self,
        node_id: WorkflowNodeId,
        session_id: &str,
        now: String,
        live_run_ids: &std::collections::HashSet<String>,
    ) -> Result<Vec<ConversationTurn>> {
        self.manifest()?;
        self.recover_pending_append(node_id)?;
        self.require_session(node_id, session_id)?;
        let path = self.messages_path(node_id, session_id)?;
        let mut document = read_conversation_document(&path)?;
        let mut changed = false;
        for turn in &mut document.turns {
            if matches!(turn.status, TurnStatus::Queued | TurnStatus::Running)
                && !live_run_ids.contains(&turn.run_id)
            {
                for activity in &mut turn.activities {
                    if matches!(activity.status, TurnActivityStatus::Running) {
                        activity.status = TurnActivityStatus::Failed;
                        activity.public_summary = Some("应用退出前运行未完成".into());
                        activity.finished_at = Some(now.clone());
                    }
                }
                turn.status = TurnStatus::Interrupted;
                turn.finished_at = Some(now.clone());
                changed = true;
            }
        }
        let recovered = document.turns.clone();
        if changed {
            self.persist_conversation(node_id, session_id, &document, now)?;
        }
        Ok(recovered)
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

    /// Drops the oldest sessions beyond [`MAX_SESSIONS_PER_NODE`]. `sessions`
    /// must already be sorted newest-first; the trimmed head is returned and
    /// each dropped session's message file is removed from disk.
    fn prune_excess_sessions(
        &self,
        node_id: WorkflowNodeId,
        mut sessions: Vec<ChatSession>,
    ) -> Result<Vec<ChatSession>> {
        if sessions.len() <= MAX_SESSIONS_PER_NODE {
            return Ok(sessions);
        }
        let dropped = sessions.split_off(MAX_SESSIONS_PER_NODE);
        for session in &dropped {
            let path = self.messages_path(node_id, &session.id)?;
            if path.exists() {
                fs::remove_file(&path).map_err(|source| StorageError::Io {
                    path: path.clone(),
                    source,
                })?;
            }
        }
        Ok(sessions)
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

    fn node_path(&self, id: WorkflowNodeId) -> PathBuf {
        self.project_root
            .join("nodes")
            .join(format!("{}.json", id.as_str()))
    }
    fn agent_override_path(&self, id: WorkflowNodeId) -> PathBuf {
        self.project_root
            .join("agent-overrides")
            .join(format!("{}.md", id.as_str()))
    }
    fn chat_node_dir(&self, id: WorkflowNodeId) -> PathBuf {
        self.project_root.join("chat").join(id.as_str())
    }
    fn sessions_path(&self, id: WorkflowNodeId) -> PathBuf {
        self.chat_node_dir(id).join("index.json")
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
    fn files_dir(&self) -> PathBuf {
        self.project_root.join("files")
    }
    fn files_index_path(&self) -> PathBuf {
        self.files_dir().join("index.json")
    }
    fn runs_dir(&self) -> PathBuf {
        self.project_root.join("runs")
    }
    fn run_path(&self, run_id: &str) -> Result<PathBuf> {
        if !is_safe_file_component(run_id) {
            return Err(StorageError::UnsafeRunId(run_id.to_string()));
        }
        Ok(self.runs_dir().join(format!("{run_id}.json")))
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

fn classify_file(extension: &str) -> (ProjectFileKind, &'static str) {
    match extension {
        ".md" | ".markdown" => (ProjectFileKind::Markdown, "text/markdown"),
        ".txt" => (ProjectFileKind::Text, "text/plain"),
        ".json" => (ProjectFileKind::Json, "application/json"),
        ".csv" => (ProjectFileKind::Csv, "text/csv"),
        ".pdf" => (ProjectFileKind::Pdf, "application/pdf"),
        ".doc" | ".docx" => (
            ProjectFileKind::Word,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        ".xls" | ".xlsx" => (
            ProjectFileKind::Excel,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        _ => (ProjectFileKind::Unsupported, "application/octet-stream"),
    }
}

fn is_extractable_kind(kind: &ProjectFileKind) -> bool {
    matches!(
        kind,
        ProjectFileKind::Markdown
            | ProjectFileKind::Text
            | ProjectFileKind::Json
            | ProjectFileKind::Csv
            | ProjectFileKind::Pdf
            | ProjectFileKind::Word
            | ProjectFileKind::Excel
    )
}

fn extract_text(
    path: &Path,
    kind: &ProjectFileKind,
) -> std::result::Result<(String, Option<u32>), String> {
    match kind {
        ProjectFileKind::Markdown
        | ProjectFileKind::Text
        | ProjectFileKind::Json
        | ProjectFileKind::Csv => fs::read_to_string(path)
            .map(|text| (text, None))
            .map_err(|error| error.to_string()),
        ProjectFileKind::Pdf => pdf_extract::extract_text(path)
            .map(|text| (text, None))
            .map_err(|error| format!("PDF text extraction failed: {error}")),
        ProjectFileKind::Word => extract_docx_text(path).map(|text| (text, None)),
        ProjectFileKind::Excel => extract_workbook_text(path),
        ProjectFileKind::Unsupported => Err("this file type has no text extractor".to_string()),
    }
}

fn extract_docx_text(path: &Path) -> std::result::Result<String, String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("doc"))
    {
        return Err("legacy .doc files are not supported; convert to .docx first".to_string());
    }
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("DOCX ZIP cannot be read: {error}"))?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|error| format!("DOCX document.xml is missing: {error}"))?;
    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|error| format!("DOCX document.xml cannot be read: {error}"))?;
    Ok(extract_word_xml_text(&xml))
}

fn extract_word_xml_text(xml: &str) -> String {
    let mut remaining = xml;
    let mut text = String::new();
    while let Some(start) = remaining.find("<w:t") {
        let after_start = &remaining[start..];
        let Some(content_start) = after_start.find('>') else {
            break;
        };
        let after_tag = &after_start[content_start + 1..];
        let Some(end) = after_tag.find("</w:t>") else {
            break;
        };
        text.push_str(&unescape_xml_text(&after_tag[..end]));
        remaining = &after_tag[end + "</w:t>".len()..];
        if remaining.starts_with("</w:r></w:p>") || remaining.starts_with("</w:p>") {
            text.push('\n');
        }
    }
    text.trim().to_string()
}

fn unescape_xml_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn extract_workbook_text(path: &Path) -> std::result::Result<(String, Option<u32>), String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|error| format!("workbook cannot be opened: {error}"))?;
    let sheets = workbook.sheet_names().to_vec();
    let mut output = Vec::new();
    for sheet in &sheets {
        let range = workbook
            .worksheet_range(sheet)
            .map_err(|error| format!("sheet {sheet} cannot be read: {error}"))?;
        output.push(format!("# {sheet}"));
        for row in range.rows() {
            output.push(
                row.iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\t"),
            );
        }
    }
    Ok((output.join("\n"), Some(sheets.len() as u32)))
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

fn copy_file_atomic(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .expect("project file destinations always have a parent");
    create_dir_all(parent)?;
    let staging = parent.join(format!(".{}.{}.tmp", Uuid::new_v4(), Uuid::new_v4()));
    let result = (|| {
        let mut input = fs::File::open(source).map_err(|source_error| StorageError::Io {
            path: source.to_path_buf(),
            source: source_error,
        })?;
        let mut output = fs::File::create(&staging).map_err(|source_error| StorageError::Io {
            path: staging.clone(),
            source: source_error,
        })?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|source_error| StorageError::Io {
                    path: source.to_path_buf(),
                    source: source_error,
                })?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|source_error| StorageError::Io {
                    path: staging.clone(),
                    source: source_error,
                })?;
        }
        output.sync_all().map_err(|source_error| StorageError::Io {
            path: staging.clone(),
            source: source_error,
        })?;
        fs::rename(&staging, destination).map_err(|source_error| StorageError::Io {
            path: destination.to_path_buf(),
            source: source_error,
        })?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .expect("project state paths always have a parent");
    create_dir_all(parent)?;
    let staging = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = fs::File::create(&staging).map_err(|source| StorageError::Io {
            path: staging.clone(),
            source,
        })?;
        file.write_all(bytes).map_err(|source| StorageError::Io {
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
    fn creates_two_direct_projects_inside_one_container() {
        let container = temp_project();
        fs::create_dir_all(&container).unwrap();
        let first = ProjectStore::create_in(&container, input()).unwrap();
        let mut second_input = input();
        second_input.id = "project-2".to_string();
        let second = ProjectStore::create_in(&container, second_input).unwrap();
        assert!(container.join(&first.id).join("project.json").is_file());
        assert!(container.join(&second.id).join("project.json").is_file());
        assert!(container.join(&first.id).join("runs").is_dir());
        assert_eq!(
            ProjectStore::at(container.join(&first.id))
                .list_nodes()
                .unwrap()
                .len(),
            12
        );
        fs::remove_dir_all(container).unwrap();
    }

    #[test]
    fn discovers_legacy_projects_without_registry_entries() {
        let root = temp_project();
        let projects = root.join("projects");
        let id = "427dcaeb-54c8-4b66-8c14-ac80d7560630";
        fs::create_dir_all(projects.join(id)).unwrap();
        fs::write(
            projects.join(id).join("project.json"),
            r#"{
          "id":"427dcaeb-54c8-4b66-8c14-ac80d7560630",
          "name":"浏览器验证项目","customerName":"验证客户","authorName":"验证团队",
          "version":"V1.0","createdAt":"2026-06-14T13:44:32.616Z","updatedAt":"2026-06-14T13:44:32.616Z"
        }"#,
        )
        .unwrap();
        let found = ProjectRegistry::at(root.join("global"))
            .discover(&projects)
            .unwrap();
        assert_eq!(found.projects.len(), 1);
        assert_eq!(found.projects[0].name, "浏览器验证项目");
        assert_eq!(found.projects[0].root_path, projects.join(id));
        assert!(found.warnings.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_legacy_session_indexes_in_place() {
        let container = temp_project();
        fs::create_dir_all(&container).unwrap();
        ProjectStore::create_in(&container, input()).unwrap();
        let root = container.join("project-1");
        fs::write(
            root.join("chat/goals/index.json"),
            r#"[{
          "id":"session-1","nodeId":"goals","name":"旧会话","messageCount":1,
          "webSearchEnabled":false,"createdAt":"2026-06-14T00:00:00Z","updatedAt":"2026-06-14T00:01:00Z"
        }]"#,
        )
        .unwrap();
        fs::write(
            root.join("chat/goals/session-1.json"),
            r#"[{
          "id":"message-1","role":"user","content":"旧消息","createdAt":"2026-06-14T00:00:00Z"
        }]"#,
        )
        .unwrap();
        let store = ProjectStore::at(&root);
        let sessions = store.list_sessions(WorkflowNodeId::Goals).unwrap();
        assert_eq!(sessions[0].name, "旧会话");
        assert_eq!(sessions[0].model_selection, None);
        assert_eq!(
            store.messages(WorkflowNodeId::Goals, "session-1").unwrap()[0].content,
            "旧消息"
        );
        fs::remove_dir_all(container).unwrap();
    }

    #[test]
    fn persists_and_updates_session_model_selection() {
        let root = temp_project();
        std::fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let first = ChatModelSelection {
            provider_id: "openai".into(),
            model: "gpt-a".into(),
            reasoning_effort: sion_core::ReasoningEffort::Medium,
        };
        let session = store
            .create_session(
                WorkflowNodeId::Goals,
                "讨论".into(),
                Some(first),
                "2026-07-17T00:00:00Z".into(),
            )
            .unwrap();
        let second = ChatModelSelection {
            provider_id: "openai".into(),
            model: "gpt-b".into(),
            reasoning_effort: sion_core::ReasoningEffort::Off,
        };
        let updated = store
            .update_session_model(
                WorkflowNodeId::Goals,
                &session.id,
                second.clone(),
                "2026-07-17T00:01:00Z".into(),
            )
            .unwrap();
        assert_eq!(updated.model_selection, Some(second.clone()));
        assert_eq!(
            store
                .session(WorkflowNodeId::Goals, &session.id)
                .unwrap()
                .model_selection,
            Some(second)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_revision_returns_latest_without_overwriting_it() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
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
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let manifest = root.join("project-1/project.json");
        let mut raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest).unwrap()).unwrap();
        raw["schemaVersion"] = serde_json::json!(PROJECT_SCHEMA_VERSION + 1);
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
        let container = root.join("projects");
        fs::create_dir_all(&container).unwrap();
        let manifest = ProjectStore::create_in(&container, input()).unwrap();
        let registry = ProjectRegistry::at(root.join("global"));
        registry
            .register(
                &manifest,
                container.join(&manifest.id),
                "2026-07-15T00:02:00.000Z".to_string(),
            )
            .unwrap();

        let recent = registry.list().unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "project-1");
        assert_eq!(
            registry.resolve(&container, "project-1").unwrap(),
            container.join("project-1")
        );
        let raw = fs::read_to_string(root.join("global/registry.json")).unwrap();
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
            attachments: Vec::new(),
            model_execution: None,
        }
    }

    #[test]
    fn persists_sessions_and_messages_inside_the_project_state() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let session = store
            .create_session(
                WorkflowNodeId::Goals,
                "需求讨论".to_string(),
                None,
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
            root.join(format!("project-1/chat/goals/{}.json", session.id))
                .is_file()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_at_most_ten_sessions_deleting_the_oldest() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));

        let mut oldest_id = String::new();
        for index in 0..MAX_SESSIONS_PER_NODE {
            let now = format!("2026-07-15T00:{:02}:00.000Z", index);
            let session = store
                .create_session(
                    WorkflowNodeId::Goals,
                    format!("会话 {index}"),
                    None,
                    now,
                )
                .unwrap();
            if index == 0 {
                oldest_id = session.id;
            }
        }
        assert!(store
            .messages_path(WorkflowNodeId::Goals, &oldest_id)
            .unwrap()
            .is_file());
        assert_eq!(
            store.list_sessions(WorkflowNodeId::Goals).unwrap().len(),
            MAX_SESSIONS_PER_NODE
        );

        // An eleventh session evicts the oldest record and its message file.
        store
            .create_session(
                WorkflowNodeId::Goals,
                "第十一会话".into(),
                None,
                "2026-07-15T01:00:00.000Z".into(),
            )
            .unwrap();

        let sessions = store.list_sessions(WorkflowNodeId::Goals).unwrap();
        assert_eq!(sessions.len(), MAX_SESSIONS_PER_NODE);
        assert!(sessions.iter().all(|session| session.id != oldest_id));
        assert!(!store
            .messages_path(WorkflowNodeId::Goals, &oldest_id)
            .unwrap()
            .is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_session_removes_the_record_and_its_message_file() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let session = store
            .create_session(
                WorkflowNodeId::Goals,
                "待删除".into(),
                None,
                "2026-07-15T00:02:00.000Z".into(),
            )
            .unwrap();
        store
            .append_message(
                WorkflowNodeId::Goals,
                &session.id,
                chat_message("user-1", sion_core::ChatRole::User, "你好"),
                "2026-07-15T00:03:00.000Z".into(),
            )
            .unwrap();
        assert!(store
            .messages_path(WorkflowNodeId::Goals, &session.id)
            .unwrap()
            .is_file());

        store
            .delete_session(WorkflowNodeId::Goals, &session.id)
            .unwrap();

        assert!(store
            .list_sessions(WorkflowNodeId::Goals)
            .unwrap()
            .is_empty());
        assert!(!store
            .messages_path(WorkflowNodeId::Goals, &session.id)
            .unwrap()
            .is_file());
        assert!(matches!(
            store.delete_session(WorkflowNodeId::Goals, &session.id),
            Err(StorageError::SessionNotFound(_))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovers_an_interrupted_message_append_without_duplication() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let session = store
            .create_session(
                WorkflowNodeId::Goals,
                "恢复测试".to_string(),
                None,
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
            &PendingConversationWrite {
                session_id: session.id.clone(),
                document: ConversationDocument {
                    messages: vec![message],
                    turns: Vec::new(),
                },
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

    fn conversation_fixture() -> (PathBuf, ProjectStore, ChatSession) {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let session = store
            .create_session(
                WorkflowNodeId::Goals,
                "需求讨论".into(),
                None,
                "2026-07-18T00:00:00Z".into(),
            )
            .unwrap();
        (root, store, session)
    }

    fn turn_with_status(session_id: &str, id: &str, status: TurnStatus) -> ConversationTurn {
        ConversationTurn {
            id: id.into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: session_id.into(),
            run_id: format!("run-{id}"),
            user_message_id: format!("user-{id}"),
            assistant_message_id: None,
            status,
            activities: Vec::new(),
            reasoning_summary: None,
            delivery_outcome: sion_core::DeliveryOutcome::Pending,
            started_at: "2026-07-18T00:00:00Z".into(),
            finished_at: None,
        }
    }

    #[test]
    fn legacy_message_array_reads_with_no_turns_and_upgrades_on_write() {
        let (root, store, session) = conversation_fixture();
        let path = store
            .messages_path(WorkflowNodeId::Goals, &session.id)
            .unwrap();
        atomic_write_json(
            &path,
            &vec![chat_message("legacy", sion_core::ChatRole::User, "旧消息")],
        )
        .unwrap();
        assert_eq!(
            store
                .messages(WorkflowNodeId::Goals, &session.id)
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .turns(WorkflowNodeId::Goals, &session.id)
                .unwrap()
                .is_empty()
        );

        let turn = turn_with_status(&session.id, "queued", TurnStatus::Queued);
        store
            .begin_turn(
                WorkflowNodeId::Goals,
                &session.id,
                chat_message("user-2", sion_core::ChatRole::User, "新消息"),
                turn,
                "later".into(),
            )
            .unwrap();
        let value: serde_json::Value = read_json(&path).unwrap();
        assert!(value["messages"].is_array());
        assert!(value["turns"].is_array());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_marks_only_running_turns_interrupted() {
        let (_, store, session) = conversation_fixture();
        let running = turn_with_status(&session.id, "running", TurnStatus::Running);
        let live = turn_with_status(&session.id, "live", TurnStatus::Running);
        let mut completed = turn_with_status(&session.id, "completed", TurnStatus::Completed);
        completed.finished_at = Some("2026-07-18T00:00:01Z".into());
        store
            .save_turn(WorkflowNodeId::Goals, &session.id, running)
            .unwrap();
        store
            .save_turn(WorkflowNodeId::Goals, &session.id, completed)
            .unwrap();
        store
            .save_turn(WorkflowNodeId::Goals, &session.id, live)
            .unwrap();
        let recovered = store
            .recover_interrupted_turns_except(
                WorkflowNodeId::Goals,
                &session.id,
                "recovered-at".into(),
                &std::collections::HashSet::from(["run-live".to_string()]),
            )
            .unwrap();
        assert_eq!(
            recovered
                .iter()
                .find(|turn| turn.id == "running")
                .unwrap()
                .status,
            TurnStatus::Interrupted
        );
        assert_eq!(
            recovered
                .iter()
                .find(|turn| turn.id == "completed")
                .unwrap()
                .status,
            TurnStatus::Completed
        );
        assert_eq!(
            recovered
                .iter()
                .find(|turn| turn.id == "live")
                .unwrap()
                .status,
            TurnStatus::Running
        );
    }

    #[test]
    fn completing_a_turn_persists_the_assistant_and_terminal_snapshot_together() {
        let (root, store, session) = conversation_fixture();
        let queued = turn_with_status(&session.id, "turn-1", TurnStatus::Queued);
        store
            .begin_turn(
                WorkflowNodeId::Goals,
                &session.id,
                chat_message("user-turn-1", sion_core::ChatRole::User, "请补充目标"),
                queued.clone(),
                "started".into(),
            )
            .unwrap();
        let mut completed = queued;
        completed.status = TurnStatus::Completed;
        completed.assistant_message_id = Some("assistant-turn-1".into());
        completed.delivery_outcome = sion_core::DeliveryOutcome::Unchanged;
        completed.finished_at = Some("finished".into());
        store
            .complete_turn(
                WorkflowNodeId::Goals,
                &session.id,
                chat_message(
                    "assistant-turn-1",
                    sion_core::ChatRole::Assistant,
                    "已补充目标",
                ),
                completed.clone(),
            )
            .unwrap();

        let messages = store.messages(WorkflowNodeId::Goals, &session.id).unwrap();
        assert!(
            messages
                .iter()
                .any(|message| message.id == "assistant-turn-1")
        );
        assert_eq!(
            store.turns(WorkflowNodeId::Goals, &session.id).unwrap(),
            vec![completed]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_text_files_with_a_durable_extracted_copy() {
        let root = temp_project();
        let source = root.join("brief.md");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source, "# 需求\n\n你好，Sion。\n").unwrap();
        let container = root.join("projects");
        ProjectStore::create_in(&container, input()).unwrap();
        let store = ProjectStore::at(container.join("project-1"));

        let file = store
            .import_file(&source, "2026-07-15T00:05:00.000Z".to_string())
            .unwrap();
        assert_eq!(file.kind, Some(ProjectFileKind::Markdown));
        assert_eq!(file.status, "available");
        assert_eq!(store.list_files().unwrap(), vec![file.clone()]);
        assert_eq!(
            store.read_file_text(&file.id).unwrap().unwrap(),
            "# 需求\n\n你好，Sion。\n"
        );
        assert!(
            container
                .join("project-1/files")
                .join(file.stored_name)
                .is_file()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_docx_files_with_a_separate_text_companion() {
        let root = temp_project();
        let source = root.join("brief.docx");
        fs::create_dir_all(&root).unwrap();
        let file = fs::File::create(&source).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("word/document.xml", zip::write::FileOptions::default())
            .unwrap();
        archive
            .write_all(b"<w:document><w:body><w:p><w:r><w:t>Sion &amp; DOCX</w:t></w:r></w:p></w:body></w:document>")
            .unwrap();
        archive.finish().unwrap();
        let container = root.join("projects");
        ProjectStore::create_in(&container, input()).unwrap();
        let store = ProjectStore::at(container.join("project-1"));

        let imported = store
            .import_file(&source, "2026-07-15T00:05:00.000Z".to_string())
            .unwrap();
        assert_eq!(imported.kind, Some(ProjectFileKind::Word));
        assert_eq!(
            imported.extraction_status,
            Some(FileExtractionStatus::Available)
        );
        assert_eq!(
            store.read_file_text(&imported.id).unwrap(),
            Some("Sion & DOCX".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_xlsx_files_with_sheet_text() {
        let root = temp_project();
        let source = root.join("brief.xlsx");
        fs::create_dir_all(&root).unwrap();
        let file = fs::File::create(&source).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        for (name, xml) in [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="概览" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>"#,
            ),
            (
                "xl/sharedStrings.xml",
                r#"<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>字段</t></si><si><t>值</t></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
        ] {
            archive.start_file(name, options).unwrap();
            archive.write_all(xml.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
        let container = root.join("projects");
        ProjectStore::create_in(&container, input()).unwrap();
        let store = ProjectStore::at(container.join("project-1"));

        let imported = store
            .import_file(&source, "2026-07-15T00:05:00.000Z".to_string())
            .unwrap();
        assert_eq!(imported.kind, Some(ProjectFileKind::Excel));
        assert_eq!(
            imported.extraction_status,
            Some(FileExtractionStatus::Available)
        );
        assert_eq!(imported.sheet_count, Some(1));
        assert_eq!(
            store.read_file_text(&imported.id).unwrap(),
            Some("# 概览\n字段\t值".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_unreadable_pdf_files_without_claiming_text_extraction() {
        let root = temp_project();
        let source = root.join("reference.pdf");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source, b"%PDF-not-a-real-document").unwrap();
        let container = root.join("projects");
        ProjectStore::create_in(&container, input()).unwrap();
        let store = ProjectStore::at(container.join("project-1"));

        let file = store
            .import_file(&source, "2026-07-15T00:05:00.000Z".to_string())
            .unwrap();
        assert_eq!(file.kind, Some(ProjectFileKind::Pdf));
        assert_eq!(file.status, "extraction_failed");
        assert_eq!(file.extraction_status, Some(FileExtractionStatus::Failed));
        assert!(file.extraction_error.is_some());
        assert_eq!(store.read_file_text(&file.id).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn previews_extracted_text_without_exposing_other_project_files() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let source = root.join("source.md");
        fs::write(&source, "甲".repeat(40)).unwrap();
        let file = store
            .import_file(&source, "2026-07-16T00:00:00.000Z".to_string())
            .unwrap();
        let preview = store.file_preview(&file.id, 16).unwrap();
        assert_eq!(preview.file.id, file.id);
        assert_eq!(preview.text.unwrap().chars().count(), 16);
        assert!(preview.truncated);
        assert!(matches!(
            store.file_preview("../outside", 16),
            Err(StorageError::ProjectFileNotFound(_))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_run_summaries_without_assistant_message_contents() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let run = AgentRun {
            id: "run-1".to_string(),
            project_id: "project-1".to_string(),
            node_id: WorkflowNodeId::Goals,
            status: sion_agent::AgentRunStatus::Cancelled,
            created_at: "2026-07-15T00:00:00.000Z".to_string(),
            started_at: Some("2026-07-15T00:00:01.000Z".to_string()),
            finished_at: Some("2026-07-15T00:00:02.000Z".to_string()),
            summary: Some("用户取消，未保存任何部分助手内容".to_string()),
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
        store.save_run(&run).unwrap();

        assert_eq!(store.run("run-1").unwrap(), run);
        assert_eq!(store.list_runs().unwrap(), vec![run]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_usage_prefers_linked_runs_without_double_counting_messages() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let session = store
            .create_session(WorkflowNodeId::Goals, "需求讨论".into(), None, "now".into())
            .unwrap();
        let legacy_usage = sion_core::build_turn_usage(
            "turn-legacy",
            "call-legacy",
            "provider",
            "model",
            sion_core::ModelCallCategory::Answer,
            sion_core::ModelCallStatus::Completed,
            None,
            "legacy input",
            "legacy output",
        );
        let mut assistant = chat_message("assistant-1", sion_core::ChatRole::Assistant, "answer");
        assistant.usage = Some(legacy_usage.clone());
        store
            .append_message(WorkflowNodeId::Goals, &session.id, assistant, "now".into())
            .unwrap();
        assert_eq!(
            store
                .session_usage(WorkflowNodeId::Goals, &session.id)
                .unwrap()
                .total_tokens,
            legacy_usage.total_tokens
        );

        let run_usage = sion_core::build_turn_usage(
            "turn-new",
            "call-new",
            "provider",
            "model",
            sion_core::ModelCallCategory::Answer,
            sion_core::ModelCallStatus::Completed,
            None,
            "new input",
            "new output",
        );
        store
            .save_run(&AgentRun {
                id: "run-new".into(),
                project_id: "project-1".into(),
                node_id: WorkflowNodeId::Goals,
                status: sion_agent::AgentRunStatus::Completed,
                created_at: "now".into(),
                started_at: Some("now".into()),
                finished_at: Some("later".into()),
                summary: None,
                provider_id: Some("provider".into()),
                model: Some("model".into()),
                reasoning_effort: None,
                file_ids: vec![],
                kind: sion_agent::AgentRunKind::Conversation,
                session_id: Some(session.id.clone()),
                turn_id: Some("turn-new".into()),
                context_snapshot: None,
                usage: Some(run_usage.clone()),
                duration_ms: Some(10),
            })
            .unwrap();
        let aggregate = store
            .session_usage(WorkflowNodeId::Goals, &session.id)
            .unwrap();
        assert_eq!(aggregate.total_tokens, run_usage.total_tokens);
        assert_eq!(aggregate.call_count, run_usage.call_count);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_only_the_current_nodes_project_override() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let overrides = root.join("project-1").join("agent-overrides");
        fs::write(overrides.join("basic-info.md"), "仅写确认信息").unwrap();
        assert_eq!(
            store.agent_override(WorkflowNodeId::BasicInfo).unwrap(),
            Some("仅写确认信息".to_string())
        );
        assert_eq!(store.agent_override(WorkflowNodeId::Goals).unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saves_and_clears_a_project_agent_override_atomically() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        ProjectStore::create_in(&root, input()).unwrap();
        let store = ProjectStore::at(root.join("project-1"));
        let saved = store
            .save_agent_override(WorkflowNodeId::Goals, "只使用确认的目标。".to_string())
            .unwrap();
        assert_eq!(saved.as_deref(), Some("只使用确认的目标。"));
        assert_eq!(
            store.agent_override(WorkflowNodeId::Goals).unwrap(),
            Some("只使用确认的目标。".to_string())
        );
        assert_eq!(
            store
                .save_agent_override(WorkflowNodeId::Goals, " \n ".to_string())
                .unwrap(),
            None
        );
        assert_eq!(store.agent_override(WorkflowNodeId::Goals).unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }
}
