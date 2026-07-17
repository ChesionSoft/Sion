//! Atomic application-level settings storage. Today this only remembers the
//! optional projects directory: the single container where Sion creates and
//! discovers project directories. Writes follow the same staging-and-rename
//! pattern as provider metadata: a unique temp file is written, then renamed
//! onto `settings.json`, so a crashed write never leaves a half-written file.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSettings {
    pub sidebar_collapsed: bool,
    pub last_destination: String,
    pub projects: BTreeMap<String, ProjectUiSettings>,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            sidebar_collapsed: false,
            last_destination: "projects".to_string(),
            projects: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectUiSettings {
    pub initialized: bool,
    pub opened_node_ids: Vec<String>,
    pub active_node_id: Option<String>,
    pub tabs_initialized: bool,
    pub right_tab_ids: Vec<String>,
    pub active_right_tab_id: Option<String>,
    pub right_pane_width: u16,
}

impl Default for ProjectUiSettings {
    fn default() -> Self {
        Self {
            initialized: false,
            opened_node_ids: Vec::new(),
            active_node_id: None,
            tabs_initialized: false,
            right_tab_ids: Vec::new(),
            active_right_tab_id: None,
            right_pane_width: 440,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u32,
    pub projects_directory: Option<PathBuf>,
    #[serde(default)]
    pub ui: UiSettings,
}

impl AppSettings {
    pub fn with_projects_directory(projects_directory: Option<PathBuf>) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            projects_directory,
            ui: UiSettings::default(),
        }
    }

    pub fn with_updated_projects_directory(mut self, projects_directory: Option<PathBuf>) -> Self {
        self.projects_directory = projects_directory;
        self
    }
}

fn normalize_ui(mut ui: UiSettings) -> UiSettings {
    if !matches!(ui.last_destination.as_str(), "projects" | "exports") {
        ui.last_destination = "projects".to_string();
    }
    ui.projects = ui
        .projects
        .into_iter()
        .filter(|(id, _)| id.len() <= 128)
        .take(256)
        .map(|(id, mut project)| {
            project.opened_node_ids.retain(|id| id.len() <= 64);
            project.opened_node_ids.truncate(12);
            project.right_tab_ids.retain(|id| id.len() <= 512);
            project.right_tab_ids.truncate(32);
            project.right_pane_width = project.right_pane_width.clamp(320, 720);
            (id, project)
        })
        .collect();
    ui
}

pub fn load(app_data_root: &Path) -> Result<AppSettings, String> {
    let target = app_data_root.join("settings.json");
    if !target.exists() {
        return Ok(AppSettings::with_projects_directory(None));
    }
    let raw = fs::read_to_string(&target)
        .map_err(|error| format!("cannot read {}: {error}", target.display()))?;
    let mut settings: AppSettings = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid JSON {}: {error}", target.display()))?;
    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err(format!(
            "settings schema {} is unsupported",
            settings.schema_version
        ));
    }
    settings.ui = normalize_ui(settings.ui);
    Ok(settings)
}

pub fn save(app_data_root: &Path, mut settings: AppSettings) -> Result<AppSettings, String> {
    settings.ui = normalize_ui(settings.ui);
    fs::create_dir_all(app_data_root).map_err(|error| error.to_string())?;
    let staging = app_data_root.join(format!(".settings.{}.tmp", Uuid::new_v4()));
    let target = app_data_root.join("settings.json");
    let raw = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    let result = (|| {
        fs::write(&staging, [raw.as_slice(), b"\n"].concat()).map_err(|error| error.to_string())?;
        fs::rename(&staging, &target).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result.map(|()| settings)
}

/// Returns the configured projects directory only when it still exists on disk.
/// A stale path (deleted between sessions) must not be treated as a usable
/// container, so callers can detect the missing directory and ask the user to
/// choose one again.
pub fn usable_projects_directory(settings: &AppSettings) -> Option<&Path> {
    settings
        .projects_directory
        .as_deref()
        .filter(|path| path.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("sion-app-settings-{}", Uuid::new_v4()))
    }

    #[test]
    fn loads_empty_settings_when_the_file_is_absent() {
        let root = temp_root();
        assert_eq!(load(&root).unwrap().projects_directory, None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn old_settings_json_defaults_ui_state() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("settings.json"),
            r#"{"schemaVersion":1,"projectsDirectory":null}"#,
        )
        .unwrap();
        let loaded = load(&root).unwrap();
        assert_eq!(loaded.ui, UiSettings::default());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saves_and_reloads_bounded_ui_state() {
        let root = temp_root();
        let mut settings = AppSettings::with_projects_directory(None);
        settings.ui.sidebar_collapsed = true;
        settings.ui.last_destination = "exports".to_string();
        settings.ui.projects.insert(
            "project-1".to_string(),
            ProjectUiSettings {
                initialized: true,
                opened_node_ids: vec!["basic-info".to_string()],
                active_node_id: Some("basic-info".to_string()),
                tabs_initialized: true,
                right_tab_ids: vec!["delivery".to_string()],
                active_right_tab_id: Some("delivery".to_string()),
                right_pane_width: 460,
            },
        );
        save(&root, settings.clone()).unwrap();
        assert_eq!(load(&root).unwrap().ui, settings.ui);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changing_projects_directory_preserves_ui_state() {
        let mut settings = AppSettings::with_projects_directory(None);
        settings.ui.sidebar_collapsed = true;
        let changed =
            settings.with_updated_projects_directory(Some(PathBuf::from("/tmp/projects")));
        assert_eq!(
            changed.projects_directory,
            Some(PathBuf::from("/tmp/projects"))
        );
        assert!(changed.ui.sidebar_collapsed);
    }

    #[test]
    fn saves_and_reloads_the_projects_directory() {
        let root = temp_root();
        let directory = PathBuf::from("/Users/test/Documents/Sion/projects");
        save(
            &root,
            AppSettings::with_projects_directory(Some(directory.clone())),
        )
        .unwrap();
        assert_eq!(load(&root).unwrap().projects_directory, Some(directory));
        assert!(
            fs::read_to_string(root.join("settings.json"))
                .unwrap()
                .contains("projectsDirectory")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_a_projects_directory_that_no_longer_exists() {
        let root = temp_root();
        let settings = AppSettings::with_projects_directory(Some(root.join("missing")));
        assert_eq!(usable_projects_directory(&settings), None);
        let _ = fs::remove_dir_all(root);
    }
}
