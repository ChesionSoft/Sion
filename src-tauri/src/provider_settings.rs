//! Desktop model-provider settings. Provider records and their plaintext API
//! keys live together in `~/.sion/providers.json`, written atomically with
//! restricted file permissions. Keys never cross provider-list IPC: only
//! `has_api_key` is surfaced, and `ResolvedModel` (which carries the key) is
//! process-only and never serialized across IPC.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const PROVIDERS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub name: String,
    pub is_default: bool,
    pub tool_calling: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: String,
    pub name: String,
    pub api_base_url: String,
    pub api_url_mode: String,
    pub protocol: String,
    pub models: Vec<ProviderModel>,
    pub is_default: bool,
    pub api_key: Option<String>,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
    pub api_base_url: String,
    pub api_url_mode: String,
    pub protocol: String,
    pub models: Vec<ProviderModel>,
    pub is_default: bool,
    pub has_api_key: bool,
}

/// Kept inside the Rust process only. This type is never serialized across IPC.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub provider_id: String,
    pub endpoint: String,
    pub api_key: String,
    pub protocol: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvidersFile {
    schema_version: u32,
    providers: Vec<ProviderRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRecord {
    id: String,
    name: String,
    api_base_url: String,
    api_url_mode: String,
    protocol: String,
    models: Vec<ProviderModel>,
    is_default: bool,
    created_at: String,
    updated_at: String,
    api_key: String,
}

pub fn list(app_data_root: &Path) -> Result<Vec<ProviderSummary>, String> {
    let file = read_file(app_data_root)?;
    file.providers
        .into_iter()
        .map(|provider| Ok(summary(provider)))
        .collect()
}

pub fn save(app_data_root: &Path, input: ProviderInput) -> Result<ProviderSummary, String> {
    validate_input(&input)?;
    let mut file = read_file(app_data_root)?;
    let existing_index = file.providers.iter().position(|item| item.id == input.id);
    let api_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| existing_index.map(|index| file.providers[index].api_key.clone()))
        .ok_or_else(|| "a new provider requires an API key".to_string())?;
    let created_at = existing_index
        .map(|index| file.providers[index].created_at.clone())
        .unwrap_or_else(|| input.now.clone());
    let record = ProviderRecord {
        id: input.id,
        name: input.name,
        api_base_url: input.api_base_url,
        api_url_mode: input.api_url_mode,
        protocol: input.protocol,
        models: input.models,
        is_default: input.is_default,
        created_at,
        updated_at: input.now,
        api_key,
    };
    if let Some(index) = existing_index {
        file.providers[index] = record.clone();
    } else {
        file.providers.push(record.clone());
    }
    normalize_defaults(&mut file.providers);
    atomic_write_json(&path(app_data_root), &file)?;
    let persisted = file
        .providers
        .into_iter()
        .find(|provider| provider.id == record.id)
        .ok_or_else(|| "saved provider was not found in metadata".to_string())?;
    Ok(summary(persisted))
}

pub fn delete(app_data_root: &Path, provider_id: &str) -> Result<(), String> {
    if !safe_id(provider_id) {
        return Err("provider id is unsafe".to_string());
    }
    let mut file = read_file(app_data_root)?;
    let Some(index) = file
        .providers
        .iter()
        .position(|item| item.id == provider_id)
    else {
        return Err("provider was not found".to_string());
    };
    let removed = file.providers.remove(index);
    normalize_defaults(&mut file.providers);
    atomic_write_json(&path(app_data_root), &file)?;
    debug_assert_eq!(removed.id, provider_id);
    Ok(())
}

pub fn set_default(app_data_root: &Path, provider_id: &str) -> Result<ProviderSummary, String> {
    if !safe_id(provider_id) {
        return Err("provider id is unsafe".to_string());
    }
    let mut file = read_file(app_data_root)?;
    let Some(selected) = file
        .providers
        .iter()
        .position(|provider| provider.id == provider_id)
    else {
        return Err("provider was not found".to_string());
    };
    for (index, provider) in file.providers.iter_mut().enumerate() {
        provider.is_default = index == selected;
    }
    atomic_write_json(&path(app_data_root), &file)?;
    let provider = file.providers.remove(selected);
    Ok(summary(provider))
}

pub fn resolve_default_model(app_data_root: &Path) -> Result<ResolvedModel, String> {
    let file = read_file(app_data_root)?;
    let provider = file
        .providers
        .iter()
        .find(|provider| provider.is_default)
        .or_else(|| file.providers.first())
        .ok_or_else(|| "configure a model provider before starting an Agent Run".to_string())?;
    let model = provider
        .models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| provider.models.first())
        .ok_or_else(|| "the default provider has no model".to_string())?;
    let api_key = provider.api_key.clone();
    let endpoint = match provider.api_url_mode.as_str() {
        "full" => provider.api_base_url.clone(),
        "base" => {
            let suffix = match provider.protocol.as_str() {
                "chat_completions" => "chat/completions",
                "openai_responses" => "responses",
                _ => return Err("the default provider uses an unsupported protocol".to_string()),
            };
            format!("{}/{}", provider.api_base_url.trim_end_matches('/'), suffix)
        }
        _ => return Err("the default provider has an unsupported URL mode".to_string()),
    };
    Ok(ResolvedModel {
        provider_id: provider.id.clone(),
        endpoint,
        api_key,
        protocol: provider.protocol.clone(),
        model: model.name.clone(),
    })
}

fn read_file(app_data_root: &Path) -> Result<ProvidersFile, String> {
    let target = path(app_data_root);
    if !target.exists() {
        return Ok(ProvidersFile {
            schema_version: PROVIDERS_SCHEMA_VERSION,
            providers: Vec::new(),
        });
    }
    let raw =
        fs::read(&target).map_err(|error| format!("cannot read {}: {error}", target.display()))?;
    let file: ProvidersFile = serde_json::from_slice(&raw)
        .map_err(|error| format!("invalid JSON {}: {error}", target.display()))?;
    if file.schema_version != PROVIDERS_SCHEMA_VERSION {
        return Err(format!(
            "providers schema {} is unsupported",
            file.schema_version
        ));
    }
    Ok(file)
}

fn path(app_data_root: &Path) -> std::path::PathBuf {
    app_data_root.join("providers.json")
}

fn validate_input(input: &ProviderInput) -> Result<(), String> {
    if !safe_id(&input.id) || input.name.trim().is_empty() {
        return Err("provider id and name are required".to_string());
    }
    let url = input.api_base_url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("provider URL must use http or https".to_string());
    }
    if !matches!(input.api_url_mode.as_str(), "base" | "full") {
        return Err("provider URL mode must be base or full".to_string());
    }
    if !matches!(
        input.protocol.as_str(),
        "chat_completions" | "openai_responses"
    ) {
        return Err("provider protocol is unsupported".to_string());
    }
    if input.models.is_empty()
        || input
            .models
            .iter()
            .any(|model| model.name.trim().is_empty())
    {
        return Err("at least one named model is required".to_string());
    }
    Ok(())
}

fn normalize_defaults(providers: &mut [ProviderRecord]) {
    let provider_default = providers
        .iter()
        .position(|provider| provider.is_default)
        .unwrap_or(0);
    for (index, provider) in providers.iter_mut().enumerate() {
        provider.is_default = index == provider_default;
        let model_default = provider
            .models
            .iter()
            .position(|model| model.is_default)
            .unwrap_or(0);
        for (model_index, model) in provider.models.iter_mut().enumerate() {
            model.is_default = model_index == model_default;
        }
    }
}

fn summary(provider: ProviderRecord) -> ProviderSummary {
    ProviderSummary {
        id: provider.id,
        name: provider.name,
        api_base_url: provider.api_base_url,
        api_url_mode: provider.api_url_mode,
        protocol: provider.protocol,
        models: provider.models,
        is_default: provider.is_default,
        has_api_key: !provider.api_key.is_empty(),
    }
}

fn safe_id(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\', '\0'])
}

fn atomic_write_json(target: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "providers.json has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staging = parent.join(format!(".providers.{}.tmp", Uuid::new_v4()));
    let raw = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let result = (|| {
        fs::write(&staging, [raw.as_slice(), b"\n"].concat()).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&staging, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        fs::rename(&staging, target).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("sion-provider-settings-{}", Uuid::new_v4()))
    }
    fn input(id: &str) -> ProviderInput {
        ProviderInput {
            id: id.to_string(),
            name: "Test Provider".to_string(),
            api_base_url: "https://example.invalid/v1".to_string(),
            api_url_mode: "base".to_string(),
            protocol: "chat_completions".to_string(),
            models: vec![ProviderModel {
                name: "model-a".to_string(),
                is_default: true,
                tool_calling: false,
            }],
            is_default: true,
            api_key: Some("secret-value".to_string()),
            now: "2026-07-15T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn stores_key_locally_but_never_in_summary_json() {
        let root = root();
        let saved = save(&root, input("provider-a")).unwrap();
        assert!(saved.has_api_key);
        assert!(
            !serde_json::to_string(&saved)
                .unwrap()
                .contains("secret-value")
        );
        assert!(
            fs::read_to_string(path(&root))
                .unwrap()
                .contains("secret-value")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn blank_edit_preserves_the_existing_key() {
        let root = root();
        save(&root, input("provider-a")).unwrap();
        let mut edited = input("provider-a");
        edited.api_key = None;
        save(&root, edited).unwrap();
        assert_eq!(
            resolve_default_model(&root).unwrap().api_key,
            "secret-value"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_provider_removes_its_key_record() {
        let root = root();
        save(&root, input("provider-a")).unwrap();
        delete(&root, "provider-a").unwrap();
        assert!(
            !fs::read_to_string(path(&root))
                .unwrap()
                .contains("secret-value")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn provider_file_has_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let root = root();
        save(&root, input("provider-a")).unwrap();
        assert_eq!(
            fs::metadata(path(&root)).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(root);
    }
}
