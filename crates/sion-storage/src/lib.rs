//! Filesystem-backed `.sion` project storage.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;
use sion_core::{
    NodeStatus, PROJECT_SCHEMA_VERSION, ProjectManifest, WorkflowNode, WorkflowNodeId,
    default_nodes,
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("project already contains .sion")]
    AlreadyInitialized,
    #[error("project does not contain .sion")]
    NotInitialized,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveNodeResult {
    Saved(WorkflowNode),
    Conflict { latest: WorkflowNode },
}

#[derive(Debug, Clone)]
pub struct ProjectStore {
    project_root: PathBuf,
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

    fn sion_dir(&self) -> PathBuf {
        self.project_root.join(".sion")
    }
    fn node_path(&self, id: WorkflowNodeId) -> PathBuf {
        self.sion_dir()
            .join("nodes")
            .join(format!("{}.json", id.as_str()))
    }
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
}
