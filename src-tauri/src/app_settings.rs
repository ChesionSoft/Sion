//! Atomic application-level settings storage. Today this only remembers the
//! optional projects directory: the single container where Sion creates and
//! discovers project directories. Writes follow the same staging-and-rename
//! pattern as provider metadata: a unique temp file is written, then renamed
//! onto `settings.json`, so a crashed write never leaves a half-written file.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u32,
    pub projects_directory: Option<PathBuf>,
}

impl AppSettings {
    pub fn with_projects_directory(projects_directory: Option<PathBuf>) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            projects_directory,
        }
    }
}

pub fn load(app_data_root: &Path) -> Result<AppSettings, String> {
    let target = app_data_root.join("settings.json");
    if !target.exists() {
        return Ok(AppSettings::with_projects_directory(None));
    }
    let raw = fs::read_to_string(&target)
        .map_err(|error| format!("cannot read {}: {error}", target.display()))?;
    let settings: AppSettings = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid JSON {}: {error}", target.display()))?;
    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err(format!(
            "settings schema {} is unsupported",
            settings.schema_version
        ));
    }
    Ok(settings)
}

pub fn save(app_data_root: &Path, settings: AppSettings) -> Result<AppSettings, String> {
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
