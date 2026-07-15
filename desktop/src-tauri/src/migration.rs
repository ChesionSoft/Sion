use std::{fs, path::Path};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[cfg(test)]
use std::path::PathBuf;

pub const SION_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
pub struct MigrationReport {
    pub source_project_id: String,
    pub schema_version: u32,
    pub migrated_nodes: usize,
    pub migrated_sessions: usize,
    pub migrated_files: usize,
    pub verified_file_hashes: usize,
    pub removed_legacy_fields: Vec<String>,
    pub compatibility_transforms: Vec<String>,
    pub skipped_features: Vec<String>,
}

pub fn inspect_legacy_workspace(legacy_root: &Path) -> Result<Vec<String>, String> {
    let projects_dir = legacy_root.join("projects");
    let mut ids = Vec::new();
    for entry in read_dir(&projects_dir)? {
        let entry = entry.map_err(io_error)?;
        if entry.file_type().map_err(io_error)?.is_dir()
            && entry.path().join("project.json").is_file()
            && is_safe_project_id(&entry.file_name().to_string_lossy())
        {
            ids.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    ids.sort();
    Ok(ids)
}

/// Copies one legacy project into `<target_project_root>/.sion`.
///
/// The source is never modified. A sibling temporary directory is populated and
/// validated before it is atomically renamed, so a failed import cannot leave a
/// visible partial `.sion` project behind.
pub fn migrate_legacy_project(
    legacy_root: &Path,
    project_id: &str,
    target_project_root: &Path,
) -> Result<MigrationReport, String> {
    if !is_safe_project_id(project_id) {
        return Err("legacy project id is unsafe".to_string());
    }
    let source = legacy_root.join("projects").join(project_id);
    if !source.join("project.json").is_file() {
        return Err(format!("legacy project {project_id} does not exist"));
    }

    fs::create_dir_all(target_project_root).map_err(io_error)?;
    let destination = target_project_root.join(".sion");
    if destination.exists() {
        return Err("target project already contains .sion; refusing to overwrite it".to_string());
    }
    let staging = target_project_root.join(format!(".sion.migrating-{}", Uuid::new_v4()));
    if staging.exists() {
        return Err("migration staging directory already exists".to_string());
    }

    let result = migrate_to_staging(&source, project_id, &staging);
    match result {
        Ok(report) => {
            fs::rename(&staging, &destination).map_err(io_error)?;
            Ok(report)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

fn migrate_to_staging(
    source: &Path,
    project_id: &str,
    staging: &Path,
) -> Result<MigrationReport, String> {
    fs::create_dir_all(staging).map_err(io_error)?;
    let manifest = migrate_manifest(&source.join("project.json"))?;
    write_json(&staging.join("manifest.json"), &manifest)?;

    let (migrated_nodes, mut removed_legacy_fields) =
        migrate_nodes(&source.join("nodes"), &staging.join("nodes"))?;
    let chat = migrate_chat(&source.join("chat"), &staging.join("chat"))?;
    removed_legacy_fields.extend(chat.removed_legacy_fields);
    let (migrated_files, verified_file_hashes) =
        migrate_files(&source.join("files"), &staging.join("files"))?;
    copy_tree(
        &source.join("agent-overrides"),
        &staging.join("agent-overrides"),
    )?;
    copy_tree(&source.join("exports"), &staging.join("exports"))?;

    let report = MigrationReport {
        source_project_id: project_id.to_string(),
        schema_version: SION_SCHEMA_VERSION,
        migrated_nodes,
        migrated_sessions: chat.migrated_sessions,
        migrated_files,
        verified_file_hashes,
        removed_legacy_fields,
        compatibility_transforms: chat.compatibility_transforms,
        skipped_features: vec![
            "browser-search settings and browser profile/cache".to_string(),
            "web_search, web_fetch, and automatic URL reading".to_string(),
        ],
    };
    write_json(&staging.join("migration-report.json"), &report)?;
    validate_staging(staging, project_id)?;
    Ok(report)
}

fn migrate_manifest(source: &Path) -> Result<Value, String> {
    let mut manifest = read_json(source)?;
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| "legacy project.json must be a JSON object".to_string())?;
    object.insert(
        "schema_version".to_string(),
        Value::from(SION_SCHEMA_VERSION),
    );
    Ok(manifest)
}

fn migrate_nodes(source: &Path, destination: &Path) -> Result<(usize, Vec<String>), String> {
    if !source.exists() {
        return Ok((0, Vec::new()));
    }
    fs::create_dir_all(destination).map_err(io_error)?;
    let mut migrated_nodes = 0;
    let mut removed = Vec::new();

    for entry in read_dir(source)? {
        let entry = entry.map_err(io_error)?;
        if !entry.file_type().map_err(io_error)?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let source_node = entry.path();
        if source_node
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("json")
        {
            fs::copy(&source_node, destination.join(name)).map_err(io_error)?;
            continue;
        }

        let (node, removed_fields) = sanitize_node(&source_node)?;
        let node_name = name.to_string_lossy();
        for field in removed_fields {
            removed.push(format!("nodes/{node_name}:{field}"));
        }
        write_json(&destination.join(name), &node)?;
        migrated_nodes += 1;
    }
    Ok((migrated_nodes, removed))
}

fn migrate_files(source: &Path, destination: &Path) -> Result<(usize, usize), String> {
    let migrated_files = copy_tree(source, destination)?;
    let verified_file_hashes = validate_copied_tree(source, destination)?;
    validate_file_index(destination)?;
    Ok((migrated_files, verified_file_hashes))
}

fn validate_file_index(files_dir: &Path) -> Result<(), String> {
    let index = files_dir.join("index.json");
    if !index.exists() {
        return Ok(());
    }
    let records = read_json(&index)?;
    let records = records
        .as_array()
        .ok_or_else(|| "files/index.json must contain an array".to_string())?;
    for record in records {
        let record = record
            .as_object()
            .ok_or_else(|| "files/index.json contains a non-object record".to_string())?;
        validate_indexed_file(files_dir, record, "storedName", "byteSize", false)?;
        validate_indexed_file(files_dir, record, "textPath", "characterCount", true)?;
    }
    Ok(())
}

fn validate_indexed_file(
    files_dir: &Path,
    record: &serde_json::Map<String, Value>,
    path_field: &str,
    size_field: &str,
    text: bool,
) -> Result<(), String> {
    let Some(name) = record.get(path_field).and_then(Value::as_str) else {
        return Ok(());
    };
    if !is_safe_file_name(name) {
        return Err(format!("files/index.json contains an unsafe {path_field}"));
    }
    let path = files_dir.join(name);
    if !path.is_file() {
        return Err(format!("files/index.json references missing file {name}"));
    }
    let Some(expected) = record.get(size_field).and_then(Value::as_u64) else {
        return Ok(());
    };
    let actual = if text {
        fs::read_to_string(&path)
            .map_err(io_error)?
            .encode_utf16()
            .count() as u64
    } else {
        fs::metadata(&path).map_err(io_error)?.len()
    };
    if actual != expected {
        return Err(format!(
            "files/index.json {size_field} for {name} is {expected}, but copied file is {actual}"
        ));
    }
    Ok(())
}

fn sanitize_node(path: &Path) -> Result<(Value, Vec<&'static str>), String> {
    let mut node = read_json(path)?;
    let object = node
        .as_object_mut()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))?;

    let assumptions = string_list(object.get("assumptions"));
    let open_questions = string_list(object.get("openQuestions"));
    let mut removed = Vec::new();
    if assumptions.is_some() {
        object.remove("assumptions");
        removed.push("assumptions");
    }
    if open_questions.is_some() {
        object.remove("openQuestions");
        removed.push("openQuestions");
    }

    let markdown = object
        .get("markdown")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let markdown =
        merge_legacy_node_lists(markdown, assumptions.as_deref(), open_questions.as_deref());
    object.insert("markdown".to_string(), Value::String(markdown));
    Ok((node, removed))
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    value?
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn merge_legacy_node_lists(
    markdown: &str,
    assumptions: Option<&[String]>,
    open_questions: Option<&[String]>,
) -> String {
    let with_assumptions =
        merge_list_into_section(markdown, "设计假设", assumptions.unwrap_or_default());
    merge_list_into_section(
        &with_assumptions,
        "待确认问题",
        open_questions.unwrap_or_default(),
    )
}

fn merge_list_into_section(markdown: &str, heading: &str, items: &[String]) -> String {
    let items: Vec<_> = items
        .iter()
        .filter(|item| !item.trim().is_empty())
        .collect();
    if items.is_empty() {
        return markdown.to_string();
    }

    let mut lines: Vec<String> = markdown.lines().map(str::to_owned).collect();
    let target = format!("## {heading}");
    if let Some(start) = lines.iter().position(|line| line == &target) {
        let end = lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find_map(|(index, line)| line.starts_with('#').then_some(index))
            .unwrap_or(lines.len());
        let existing: Vec<_> = lines[start + 1..end]
            .iter()
            .filter_map(|line| line.strip_prefix("- "))
            .collect();
        let additions: Vec<_> = items
            .into_iter()
            .filter(|item| !existing.contains(&item.as_str()))
            .map(|item| format!("- {item}"))
            .collect();
        lines.splice(end..end, additions);
    } else {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push(target);
        lines.push(String::new());
        lines.extend(items.into_iter().map(|item| format!("- {item}")));
    }
    lines.join("\n")
}

struct ChatMigration {
    migrated_sessions: usize,
    removed_legacy_fields: Vec<String>,
    compatibility_transforms: Vec<String>,
}

fn migrate_chat(source: &Path, destination: &Path) -> Result<ChatMigration, String> {
    if !source.exists() {
        return Ok(ChatMigration {
            migrated_sessions: 0,
            removed_legacy_fields: Vec::new(),
            compatibility_transforms: Vec::new(),
        });
    }
    fs::create_dir_all(destination).map_err(io_error)?;
    let mut session_count = 0;
    let mut removed = Vec::new();
    let mut compatibility_transforms = Vec::new();

    for entry in read_dir(source)? {
        let entry = entry.map_err(io_error)?;
        let file_type = entry.file_type().map_err(io_error)?;
        if file_type.is_dir() {
            let node_id = entry.file_name().to_string_lossy().into_owned();
            let source_node = entry.path();
            let destination_node = destination.join(&node_id);
            fs::create_dir_all(&destination_node).map_err(io_error)?;

            for child in read_dir(&source_node)? {
                let child = child.map_err(io_error)?;
                let name = child.file_name().to_string_lossy().into_owned();
                let source_child = child.path();
                if name == ".append-journal.json" {
                    return Err(format!(
                        "legacy append journal {} must be recovered before migration",
                        source_child.display()
                    ));
                }
                if name == "index.json" {
                    let (sessions, removed_count) = sanitize_sessions(&source_child)?;
                    session_count += sessions.len();
                    if removed_count > 0 {
                        removed.push(format!("chat/{node_id}/index.json:webSearchEnabled"));
                    }
                    write_json(&destination_node.join("sessions.json"), &sessions)?;
                } else if child.file_type().map_err(io_error)?.is_file() {
                    fs::copy(&source_child, destination_node.join(name)).map_err(io_error)?;
                }
            }
        } else if file_type.is_file() {
            let legacy_file = entry.path();
            if legacy_file
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("json")
            {
                continue;
            }
            let node_id = legacy_file
                .file_stem()
                .and_then(|stem| stem.to_str())
                .ok_or_else(|| "legacy flat chat has an invalid filename".to_string())?;
            if is_safe_project_id(node_id) {
                migrate_flat_chat(&legacy_file, node_id, destination)?;
                session_count += 1;
                compatibility_transforms.push(format!(
                    "chat/{node_id}.json: converted single historical chat to a named session"
                ));
            }
        }
    }
    Ok(ChatMigration {
        migrated_sessions: session_count,
        removed_legacy_fields: removed,
        compatibility_transforms,
    })
}

fn migrate_flat_chat(source: &Path, node_id: &str, destination: &Path) -> Result<(), String> {
    let messages = read_json(source)?;
    let messages = messages
        .as_array()
        .ok_or_else(|| format!("{} must contain an array", source.display()))?;
    let destination_node = destination.join(node_id);
    if destination_node.exists() {
        return Err(format!(
            "legacy chat has both directory and flat formats for node {node_id}; refusing ambiguous import"
        ));
    }
    fs::create_dir_all(&destination_node).map_err(io_error)?;

    let created_at = message_timestamp(messages.first()).unwrap_or("1970-01-01T00:00:00.000Z");
    let updated_at = message_timestamp(messages.last()).unwrap_or(created_at);
    let session = serde_json::json!([{
        "id": "legacy-import",
        "nodeId": node_id,
        "name": "历史会话（迁移）",
        "messageCount": messages.len(),
        "createdAt": created_at,
        "updatedAt": updated_at,
    }]);
    write_json(&destination_node.join("sessions.json"), &session)?;
    write_json(&destination_node.join("legacy-import.json"), messages)?;
    Ok(())
}

fn message_timestamp(message: Option<&Value>) -> Option<&str> {
    message
        .and_then(Value::as_object)
        .and_then(|message| message.get("createdAt"))
        .and_then(Value::as_str)
}

fn sanitize_sessions(path: &Path) -> Result<(Vec<Value>, usize), String> {
    let sessions = read_json(path)?;
    let array = sessions
        .as_array()
        .ok_or_else(|| format!("{} must contain an array", path.display()))?;
    let mut removed_count = 0;
    let sanitized = array
        .iter()
        .cloned()
        .map(|mut session| {
            if let Some(object) = session.as_object_mut()
                && object.remove("webSearchEnabled").is_some()
            {
                removed_count += 1;
            }
            session
        })
        .collect();
    Ok((sanitized, removed_count))
}

fn validate_staging(staging: &Path, expected_project_id: &str) -> Result<(), String> {
    let manifest = read_json(&staging.join("manifest.json"))?;
    if manifest.get("id").and_then(Value::as_str) != Some(expected_project_id) {
        return Err("staged manifest does not preserve the project id".to_string());
    }
    if manifest.get("schema_version").and_then(Value::as_u64) != Some(SION_SCHEMA_VERSION.into()) {
        return Err("staged manifest is missing its schema version".to_string());
    }
    if !staging.join("migration-report.json").is_file() {
        return Err("staged migration report is missing".to_string());
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<usize, String> {
    if !source.exists() {
        return Ok(0);
    }
    fs::create_dir_all(destination).map_err(io_error)?;
    let mut copied_files = 0;
    for entry in read_dir(source)? {
        let entry = entry.map_err(io_error)?;
        let file_type = entry.file_type().map_err(io_error)?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copied_files += copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(io_error)?;
            copied_files += 1;
        }
    }
    Ok(copied_files)
}

fn validate_copied_tree(source: &Path, destination: &Path) -> Result<usize, String> {
    if !source.exists() {
        return Ok(0);
    }
    let mut verified_files = 0;
    for entry in read_dir(source)? {
        let entry = entry.map_err(io_error)?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(io_error)?;
        if file_type.is_dir() {
            verified_files += validate_copied_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            if !destination_path.is_file() {
                return Err(format!(
                    "copied file is missing from destination: {}",
                    source_path.display()
                ));
            }
            if sha256(&source_path)? != sha256(&destination_path)? {
                return Err(format!(
                    "copied file hash differs from source: {}",
                    source_path.display()
                ));
            }
            verified_files += 1;
        }
    }
    Ok(verified_files)
}

fn sha256(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(io_error)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(io_error)?;
    serde_json::from_str(&raw).map_err(|error| format!("invalid JSON {}: {error}", path.display()))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, format!("{raw}\n")).map_err(io_error)
}

fn read_dir(path: &Path) -> Result<fs::ReadDir, String> {
    fs::read_dir(path).map_err(io_error)
}

fn is_safe_project_id(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && Path::new(value).is_relative()
}

fn is_safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/legacy-projects/minimal")
    }

    fn temp_target() -> PathBuf {
        std::env::temp_dir().join(format!("sion-migration-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn discovers_the_sanitized_legacy_project() {
        let projects = inspect_legacy_workspace(&fixture_root()).unwrap();
        assert_eq!(projects, vec!["6a6b57e7-cbb6-4c0a-b630-000000000001"]);
    }

    #[test]
    fn copies_a_legacy_project_without_preserving_browser_runtime_state() {
        let legacy_root = fixture_root();
        let source_session = legacy_root
            .join("projects/6a6b57e7-cbb6-4c0a-b630-000000000001/chat/basic-info/index.json");
        let source_before = fs::read_to_string(&source_session).unwrap();
        let target = temp_target();

        let report = migrate_legacy_project(
            &legacy_root,
            "6a6b57e7-cbb6-4c0a-b630-000000000001",
            &target,
        )
        .unwrap();

        let destination = target.join(".sion");
        let manifest = read_json(&destination.join("manifest.json")).unwrap();
        assert_eq!(manifest["schema_version"], SION_SCHEMA_VERSION);
        let sessions = read_json(&destination.join("chat/basic-info/sessions.json")).unwrap();
        assert!(sessions[0].get("webSearchEnabled").is_none());
        let messages = read_json(
            &destination.join("chat/basic-info/11111111-2222-4333-8444-555555555555.json"),
        )
        .unwrap();
        assert_eq!(messages[1]["sources"][0]["kind"], "web_search");
        assert_eq!(fs::read_to_string(source_session).unwrap(), source_before);
        assert_eq!(report.migrated_nodes, 12);
        assert_eq!(report.migrated_sessions, 1);
        assert_eq!(report.migrated_files, 3);
        assert_eq!(report.verified_file_hashes, 3);
        assert!(!destination.join("browser-search.json").exists());

        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_an_existing_desktop_project() {
        let target = temp_target();
        fs::create_dir_all(target.join(".sion")).unwrap();
        let error = migrate_legacy_project(
            &fixture_root(),
            "6a6b57e7-cbb6-4c0a-b630-000000000001",
            &target,
        )
        .unwrap_err();
        assert!(error.contains("refusing to overwrite"));
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn rejects_unsafe_project_ids() {
        assert!(!is_safe_project_id("../escape"));
        assert!(!is_safe_project_id("nested/project"));
        assert!(is_safe_project_id("project-123"));
    }

    #[test]
    fn converts_a_flat_legacy_chat_to_a_deterministic_session() {
        let root = temp_target();
        let legacy = root.join("legacy");
        let project = legacy.join("projects/flat-project");
        fs::create_dir_all(project.join("chat")).unwrap();
        fs::write(project.join("project.json"), r#"{"id":"flat-project"}"#).unwrap();
        fs::write(
            project.join("chat/basic-info.json"),
            r#"[{"id":"one","createdAt":"2025-01-02T03:04:05.000Z"}]"#,
        )
        .unwrap();

        let report = migrate_legacy_project(&legacy, "flat-project", &root.join("new")).unwrap();
        let destination = root.join("new/.sion/chat/basic-info");
        let sessions = read_json(&destination.join("sessions.json")).unwrap();
        assert_eq!(sessions[0]["id"], "legacy-import");
        assert_eq!(sessions[0]["createdAt"], "2025-01-02T03:04:05.000Z");
        assert!(destination.join("legacy-import.json").is_file());
        assert_eq!(report.compatibility_transforms.len(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_an_unrecovered_append_journal_instead_of_silently_dropping_it() {
        let root = temp_target();
        let legacy = root.join("legacy");
        let project = legacy.join("projects/journal-project");
        fs::create_dir_all(project.join("chat/basic-info")).unwrap();
        fs::write(project.join("project.json"), r#"{"id":"journal-project"}"#).unwrap();
        fs::write(
            project.join("chat/basic-info/.append-journal.json"),
            r#"{"sessionId":"pending"}"#,
        )
        .unwrap();

        let error =
            migrate_legacy_project(&legacy, "journal-project", &root.join("new")).unwrap_err();
        assert!(error.contains("append journal"));
        assert!(!root.join("new/.sion").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folds_legacy_node_lists_into_markdown_and_removes_the_old_fields() {
        let root = temp_target();
        let path = root.join("node.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r##"{"markdown":"# 节点","assumptions":["已有假设"],"openQuestions":["待确认项"]}"##,
        )
        .unwrap();

        let (node, removed) = sanitize_node(&path).unwrap();
        assert_eq!(removed, vec!["assumptions", "openQuestions"]);
        assert!(node.get("assumptions").is_none());
        assert!(
            node["markdown"]
                .as_str()
                .unwrap()
                .contains("## 设计假设\n\n- 已有假设")
        );
        assert!(
            node["markdown"]
                .as_str()
                .unwrap()
                .contains("## 待确认问题\n\n- 待确认项")
        );

        fs::remove_dir_all(root).unwrap();
    }
}
