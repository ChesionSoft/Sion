//! Desktop model-provider settings. Provider metadata is portable JSON; API
//! keys are only kept in the operating-system credential store.

use std::{fs, path::Path};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const PROVIDERS_SCHEMA_VERSION: u32 = 1;
const KEYRING_SERVICE: &str = "com.chesoft.sion.desktop";

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvidersFile {
    schema_version: u32,
    providers: Vec<ProviderMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMetadata {
    id: String,
    name: String,
    api_base_url: String,
    api_url_mode: String,
    protocol: String,
    models: Vec<ProviderModel>,
    is_default: bool,
    created_at: String,
    updated_at: String,
    key_ref: String,
}

trait CredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = Entry::new(KEYRING_SERVICE, account)
            .map_err(|error| format!("credential entry failed: {error}"))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("credential read failed: {error}")),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        Entry::new(KEYRING_SERVICE, account)
            .map_err(|error| format!("credential entry failed: {error}"))?
            .set_password(secret)
            .map_err(|error| format!("credential write failed: {error}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = Entry::new(KEYRING_SERVICE, account)
            .map_err(|error| format!("credential entry failed: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("credential cleanup failed: {error}")),
        }
    }
}

pub fn list(app_data_root: &Path) -> Result<Vec<ProviderSummary>, String> {
    list_with_store(app_data_root, &SystemCredentialStore)
}

pub fn save(app_data_root: &Path, input: ProviderInput) -> Result<ProviderSummary, String> {
    save_with_store(app_data_root, input, &SystemCredentialStore)
}

pub fn delete(app_data_root: &Path, provider_id: &str) -> Result<(), String> {
    delete_with_store(app_data_root, provider_id, &SystemCredentialStore)
}

pub fn set_default(app_data_root: &Path, provider_id: &str) -> Result<ProviderSummary, String> {
    set_default_with_store(app_data_root, provider_id, &SystemCredentialStore)
}

fn set_default_with_store<S: CredentialStore>(
    app_data_root: &Path,
    provider_id: &str,
    credentials: &S,
) -> Result<ProviderSummary, String> {
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
    Ok(summary(
        provider.clone(),
        credentials.get(&keyring_account(&provider.id))?.is_some(),
    ))
}

pub fn resolve_default_model(app_data_root: &Path) -> Result<ResolvedModel, String> {
    resolve_default_model_with_store(app_data_root, &SystemCredentialStore)
}

fn list_with_store<S: CredentialStore>(
    app_data_root: &Path,
    credentials: &S,
) -> Result<Vec<ProviderSummary>, String> {
    let file = read_file(app_data_root)?;
    file.providers
        .into_iter()
        .map(|provider| {
            let has_api_key = credentials.get(&keyring_account(&provider.id))?.is_some();
            Ok(summary(provider, has_api_key))
        })
        .collect()
}

fn save_with_store<S: CredentialStore>(
    app_data_root: &Path,
    input: ProviderInput,
    credentials: &S,
) -> Result<ProviderSummary, String> {
    validate_input(&input)?;
    let mut file = read_file(app_data_root)?;
    let account = keyring_account(&input.id);
    let existing_index = file.providers.iter().position(|item| item.id == input.id);
    if existing_index.is_none()
        && input
            .api_key
            .as_deref()
            .map(str::trim)
            .is_none_or(str::is_empty)
    {
        return Err("a new provider requires an API key".to_string());
    }

    let previous_secret = credentials.get(&account)?;
    let mut wrote_secret = false;
    if let Some(api_key) = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        credentials.set(&account, api_key)?;
        wrote_secret = true;
    }

    let created_at = existing_index
        .map(|index| file.providers[index].created_at.clone())
        .unwrap_or_else(|| input.now.clone());
    let metadata = ProviderMetadata {
        id: input.id,
        name: input.name,
        api_base_url: input.api_base_url,
        api_url_mode: input.api_url_mode,
        protocol: input.protocol,
        models: input.models,
        is_default: input.is_default,
        created_at,
        updated_at: input.now,
        key_ref: format!("keyring://{KEYRING_SERVICE}/{account}"),
    };
    if let Some(index) = existing_index {
        file.providers[index] = metadata.clone();
    } else {
        file.providers.push(metadata.clone());
    }
    normalize_defaults(&mut file.providers);
    if let Err(error) = atomic_write_json(&path(app_data_root), &file) {
        if wrote_secret {
            restore_secret(credentials, &account, previous_secret);
        }
        return Err(error);
    }
    let persisted = file
        .providers
        .into_iter()
        .find(|provider| provider.id == metadata.id)
        .ok_or_else(|| "saved provider was not found in metadata".to_string())?;
    Ok(summary(persisted, credentials.get(&account)?.is_some()))
}

fn delete_with_store<S: CredentialStore>(
    app_data_root: &Path,
    provider_id: &str,
    credentials: &S,
) -> Result<(), String> {
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
    let account = keyring_account(provider_id);
    let previous_secret = credentials.get(&account)?;
    credentials.delete(&account)?;
    let removed = file.providers.remove(index);
    normalize_defaults(&mut file.providers);
    if let Err(error) = atomic_write_json(&path(app_data_root), &file) {
        restore_secret(credentials, &account, previous_secret);
        return Err(error);
    }
    debug_assert_eq!(removed.id, provider_id);
    Ok(())
}

fn resolve_default_model_with_store<S: CredentialStore>(
    app_data_root: &Path,
    credentials: &S,
) -> Result<ResolvedModel, String> {
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
    let api_key = credentials
        .get(&keyring_account(&provider.id))?
        .ok_or_else(|| {
            "the default provider has no API key in the system credential store".to_string()
        })?;
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

fn restore_secret<S: CredentialStore>(credentials: &S, account: &str, previous: Option<String>) {
    match previous {
        Some(secret) => {
            let _ = credentials.set(account, &secret);
        }
        None => {
            let _ = credentials.delete(account);
        }
    }
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

fn normalize_defaults(providers: &mut [ProviderMetadata]) {
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

fn summary(provider: ProviderMetadata, has_api_key: bool) -> ProviderSummary {
    ProviderSummary {
        id: provider.id,
        name: provider.name,
        api_base_url: provider.api_base_url,
        api_url_mode: provider.api_url_mode,
        protocol: provider.protocol,
        models: provider.models,
        is_default: provider.is_default,
        has_api_key,
    }
}

fn keyring_account(provider_id: &str) -> String {
    format!("provider:{provider_id}")
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
    use std::{cell::RefCell, collections::BTreeMap, path::PathBuf};

    #[derive(Default)]
    struct FakeCredentials {
        values: RefCell<BTreeMap<String, String>>,
        fail_set: bool,
    }
    impl CredentialStore for FakeCredentials {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.values.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            if self.fail_set {
                return Err("simulated credential failure".to_string());
            }
            self.values
                .borrow_mut()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.values.borrow_mut().remove(account);
            Ok(())
        }
    }
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
    fn keeps_secret_out_of_metadata_and_lists_only_its_presence() {
        let root = root();
        let credentials = FakeCredentials::default();
        let saved = save_with_store(&root, input("provider-a"), &credentials).unwrap();
        assert!(saved.has_api_key);
        assert_eq!(
            credentials.values.borrow()["provider:provider-a"],
            "secret-value"
        );
        let raw = fs::read_to_string(path(&root)).unwrap();
        assert!(!raw.contains("secret-value"));
        assert!(list_with_store(&root, &credentials).unwrap()[0].has_api_key);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_new_provider_when_keyring_write_fails_without_metadata() {
        let root = root();
        let credentials = FakeCredentials {
            values: RefCell::new(BTreeMap::new()),
            fail_set: true,
        };
        assert!(save_with_store(&root, input("provider-a"), &credentials).is_err());
        assert!(!path(&root).exists());
    }

    #[test]
    fn removes_metadata_and_keyring_entry_together() {
        let root = root();
        let credentials = FakeCredentials::default();
        save_with_store(&root, input("provider-a"), &credentials).unwrap();
        delete_with_store(&root, "provider-a", &credentials).unwrap();
        assert!(list_with_store(&root, &credentials).unwrap().is_empty());
        assert!(credentials.values.borrow().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn returns_the_normalized_default_state_from_disk() {
        let root = root();
        let credentials = FakeCredentials::default();
        save_with_store(&root, input("provider-a"), &credentials).unwrap();
        let saved = save_with_store(&root, input("provider-b"), &credentials).unwrap();
        assert!(!saved.is_default);
        let listed = list_with_store(&root, &credentials).unwrap();
        assert!(listed[0].is_default);
        assert!(!listed[1].is_default);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_only_the_default_model_for_the_agent_process() {
        let root = root();
        let credentials = FakeCredentials::default();
        save_with_store(&root, input("provider-a"), &credentials).unwrap();
        let resolved = resolve_default_model_with_store(&root, &credentials).unwrap();
        assert_eq!(
            resolved.endpoint,
            "https://example.invalid/v1/chat/completions"
        );
        assert_eq!(resolved.model, "model-a");
        assert_eq!(resolved.api_key, "secret-value");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn edits_existing_metadata_without_replacing_the_saved_secret() {
        let root = root();
        let credentials = FakeCredentials::default();
        save_with_store(&root, input("provider-a"), &credentials).unwrap();
        let mut edited = input("provider-a");
        edited.name = "Renamed Provider".to_string();
        edited.api_key = None;
        save_with_store(&root, edited, &credentials).unwrap();
        assert_eq!(
            credentials.values.borrow()["provider:provider-a"],
            "secret-value"
        );
        assert_eq!(
            list_with_store(&root, &credentials).unwrap()[0].name,
            "Renamed Provider"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn explicitly_switches_the_default_provider_without_touching_credentials() {
        let root = root();
        let credentials = FakeCredentials::default();
        save_with_store(&root, input("provider-a"), &credentials).unwrap();
        let mut second = input("provider-b");
        second.is_default = false;
        save_with_store(&root, second, &credentials).unwrap();
        set_default_with_store(&root, "provider-b", &credentials).unwrap();
        let providers = list_with_store(&root, &credentials).unwrap();
        assert!(!providers[0].is_default && providers[1].is_default);
        assert_eq!(credentials.values.borrow().len(), 2);
        let _ = fs::remove_dir_all(root);
    }
}
