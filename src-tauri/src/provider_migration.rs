use std::{collections::BTreeMap, fs, path::Path};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[cfg(test)]
use std::path::PathBuf;

const PROVIDERS_SCHEMA_VERSION: u32 = 1;
const KEYRING_SERVICE: &str = "com.chesoft.sion.desktop";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMigrationInspection {
    pub providers: Vec<ProviderMigrationCandidate>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMigrationCandidate {
    pub id: String,
    pub name: String,
    pub model_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMigrationReport {
    pub schema_version: u32,
    pub migrated_providers: usize,
    pub key_references: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ProvidersFile {
    schema_version: u32,
    providers: Vec<ProviderMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ProviderMetadata {
    id: String,
    name: String,
    api_base_url: String,
    api_url_mode: String,
    protocol: String,
    models: Vec<ModelMetadata>,
    is_default: bool,
    created_at: String,
    updated_at: String,
    key_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ModelMetadata {
    name: String,
    is_default: bool,
    tool_calling: bool,
}

#[derive(Debug, Clone)]
struct LegacyProvider {
    metadata: ProviderMetadata,
    api_key: String,
}

trait CredentialStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = Entry::new(KEYRING_SERVICE, account)
            .map_err(|error| format!("credential entry failed: {error}"))?;
        entry
            .set_password(secret)
            .map_err(|error| format!("credential write failed: {error}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = Entry::new(KEYRING_SERVICE, account)
            .map_err(|error| format!("credential entry failed: {error}"))?;
        entry
            .delete_credential()
            .map_err(|error| format!("credential cleanup failed: {error}"))
    }
}

pub fn inspect_legacy_providers(legacy_root: &Path) -> Result<ProviderMigrationInspection, String> {
    let providers = read_legacy_providers(legacy_root)?;
    Ok(ProviderMigrationInspection {
        providers: providers
            .into_iter()
            .map(|provider| ProviderMigrationCandidate {
                id: provider.metadata.id,
                name: provider.metadata.name,
                model_count: provider.metadata.models.len(),
            })
            .collect(),
    })
}

/// Migrates legacy plaintext API keys to the operating-system credential store.
///
/// The target `providers.json` is created only after every credential write has
/// succeeded. If a later credential write fails, all credentials written by this
/// attempt are deleted and no metadata file is committed.
pub fn migrate_legacy_providers(
    legacy_root: &Path,
    app_data_root: &Path,
) -> Result<ProviderMigrationReport, String> {
    migrate_legacy_providers_with_store(legacy_root, app_data_root, &SystemCredentialStore)
}

fn migrate_legacy_providers_with_store<S: CredentialStore>(
    legacy_root: &Path,
    app_data_root: &Path,
    credential_store: &S,
) -> Result<ProviderMigrationReport, String> {
    let providers = read_legacy_providers(legacy_root)?;
    let target = app_data_root.join("providers.json");
    if target.exists() {
        return Err(
            "providers.json already exists; refusing to overwrite desktop settings".to_string(),
        );
    }

    let mut written_accounts = Vec::new();
    for provider in &providers {
        let account = keyring_account(&provider.metadata.id);
        if let Err(error) = credential_store.set(&account, &provider.api_key) {
            cleanup_credentials(credential_store, &written_accounts);
            return Err(error);
        }
        written_accounts.push(account);
    }

    let metadata = ProvidersFile {
        schema_version: PROVIDERS_SCHEMA_VERSION,
        providers: providers
            .iter()
            .map(|provider| provider.metadata.clone())
            .collect(),
    };
    if let Err(error) = atomic_write_json(&target, &metadata) {
        cleanup_credentials(credential_store, &written_accounts);
        return Err(error);
    }

    Ok(ProviderMigrationReport {
        schema_version: PROVIDERS_SCHEMA_VERSION,
        migrated_providers: metadata.providers.len(),
        key_references: metadata
            .providers
            .iter()
            .map(|provider| provider.key_ref.clone())
            .collect(),
    })
}

fn cleanup_credentials<S: CredentialStore>(credential_store: &S, accounts: &[String]) {
    for account in accounts.iter().rev() {
        let _ = credential_store.delete(account);
    }
}

fn read_legacy_providers(legacy_root: &Path) -> Result<Vec<LegacyProvider>, String> {
    let path = legacy_root.join("settings/model-providers.json");
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let entries: Vec<Value> = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid JSON {}: {error}", path.display()))?;
    let mut ids = BTreeMap::new();
    let mut providers = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let provider = parse_legacy_provider(entry, index)?;
        if ids.insert(provider.metadata.id.clone(), ()).is_some() {
            return Err(format!(
                "legacy provider id {} is duplicated",
                provider.metadata.id
            ));
        }
        providers.push(provider);
    }
    normalize_provider_defaults(&mut providers);
    Ok(providers)
}

fn parse_legacy_provider(value: &Value, index: usize) -> Result<LegacyProvider, String> {
    let value = value
        .as_object()
        .ok_or_else(|| format!("legacy provider at index {index} is not an object"))?;
    let id = required_string(value, "id", index)?;
    if !is_safe_provider_id(&id) {
        return Err(format!("legacy provider {id} has an unsafe id"));
    }
    let api_key = required_string(value, "apiKey", index)?;
    let models = parse_models(value, index)?;
    let key_ref = format!("keyring://{KEYRING_SERVICE}/{}", keyring_account(&id));
    Ok(LegacyProvider {
        metadata: ProviderMetadata {
            id,
            name: required_string(value, "name", index)?,
            api_base_url: required_string(value, "apiBaseUrl", index)?,
            api_url_mode: match value.get("apiUrlMode").and_then(Value::as_str) {
                Some("full") => "full".to_string(),
                _ => "base".to_string(),
            },
            protocol: match value.get("protocol").and_then(Value::as_str) {
                Some("openai_responses") => "openai_responses".to_string(),
                Some("chat_completions") | None => "chat_completions".to_string(),
                Some(protocol) => {
                    return Err(format!(
                        "legacy provider {index} has unsupported protocol {protocol}"
                    ));
                }
            },
            models,
            is_default: value
                .get("isDefault")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            created_at: value
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("1970-01-01T00:00:00.000Z")
                .to_string(),
            updated_at: value
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or("1970-01-01T00:00:00.000Z")
                .to_string(),
            key_ref,
        },
        api_key,
    })
}

fn parse_models(
    value: &serde_json::Map<String, Value>,
    provider_index: usize,
) -> Result<Vec<ModelMetadata>, String> {
    let values = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("legacy provider {provider_index} has no models array"))?;
    if values.is_empty() {
        return Err(format!("legacy provider {provider_index} has no models"));
    }

    let mut models = Vec::with_capacity(values.len());
    for (model_index, model) in values.iter().enumerate() {
        let model = if let Some(name) = model.as_str() {
            ModelMetadata {
                name: name.to_string(),
                is_default: value.get("defaultModel").and_then(Value::as_str) == Some(name),
                tool_calling: false,
            }
        } else {
            let model = model.as_object().ok_or_else(|| {
                format!("legacy provider {provider_index} model {model_index} is invalid")
            })?;
            ModelMetadata {
                name: required_model_name(model, provider_index, model_index)?,
                is_default: model
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                tool_calling: model
                    .get("toolCalling")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        };
        if model.name.trim().is_empty() {
            return Err(format!(
                "legacy provider {provider_index} has an empty model name"
            ));
        }
        models.push(model);
    }
    normalize_model_defaults(&mut models);
    Ok(models)
}

fn required_string(
    value: &serde_json::Map<String, Value>,
    field: &str,
    index: usize,
) -> Result<String, String> {
    let field_value = value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("legacy provider {index} has no valid {field}"))?;
    Ok(field_value.to_string())
}

fn required_model_name(
    value: &serde_json::Map<String, Value>,
    provider_index: usize,
    model_index: usize,
) -> Result<String, String> {
    value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("legacy provider {provider_index} model {model_index} has no name"))
}

fn normalize_provider_defaults(providers: &mut [LegacyProvider]) {
    let default = providers
        .iter()
        .position(|provider| provider.metadata.is_default)
        .unwrap_or(0);
    for (index, provider) in providers.iter_mut().enumerate() {
        provider.metadata.is_default = index == default;
    }
}

fn normalize_model_defaults(models: &mut [ModelMetadata]) {
    let default = models
        .iter()
        .position(|model| model.is_default)
        .unwrap_or(0);
    for (index, model) in models.iter_mut().enumerate() {
        model.is_default = index == default;
    }
}

fn keyring_account(provider_id: &str) -> String {
    format!("provider:{provider_id}")
}

fn is_safe_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains('\0')
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "providers.json has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staging = parent.join(format!(".providers.{}.tmp", Uuid::new_v4()));
    let raw = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let result = (|| {
        fs::write(&staging, [raw.as_slice(), b"\n"].concat()).map_err(|error| error.to_string())?;
        fs::rename(&staging, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::BTreeSet};

    #[derive(Default)]
    struct FakeCredentialStore {
        values: RefCell<BTreeMap<String, String>>,
        fail_on: Option<String>,
        deleted: RefCell<BTreeSet<String>>,
    }

    impl CredentialStore for FakeCredentialStore {
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            if self.fail_on.as_deref() == Some(account) {
                return Err("simulated credential failure".to_string());
            }
            self.values
                .borrow_mut()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            self.values.borrow_mut().remove(account);
            self.deleted.borrow_mut().insert(account.to_string());
            Ok(())
        }
    }

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("sion-provider-migration-{}", Uuid::new_v4()))
    }

    fn write_legacy_settings(root: &Path, value: &str) {
        let settings = root.join("settings");
        fs::create_dir_all(&settings).unwrap();
        fs::write(settings.join("model-providers.json"), value).unwrap();
    }

    #[test]
    fn migrates_plaintext_keys_to_the_credential_store_without_serializing_them() {
        let root = temp_root();
        let legacy = root.join("legacy");
        write_legacy_settings(
            &legacy,
            r#"[{"id":"provider-a","name":"Alpha","apiBaseUrl":"https://alpha.invalid","apiKey":"secret-a","models":["a-small","a-large"],"defaultModel":"a-large"}]"#,
        );
        let store = FakeCredentialStore::default();

        let inspection = inspect_legacy_providers(&legacy).unwrap();
        assert_eq!(inspection.providers[0].model_count, 2);
        let report =
            migrate_legacy_providers_with_store(&legacy, &root.join("app-data"), &store).unwrap();
        assert_eq!(report.migrated_providers, 1);
        assert_eq!(store.values.borrow()["provider:provider-a"], "secret-a");

        let raw = fs::read_to_string(root.join("app-data/providers.json")).unwrap();
        assert!(!raw.contains("secret-a"));
        let metadata: ProvidersFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            metadata.providers[0].key_ref,
            "keyring://com.chesoft.sion.desktop/provider:provider-a"
        );
        assert!(metadata.providers[0].models[1].is_default);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleans_up_written_credentials_when_a_later_credential_fails() {
        let root = temp_root();
        let legacy = root.join("legacy");
        write_legacy_settings(
            &legacy,
            r#"[
              {"id":"provider-a","name":"Alpha","apiBaseUrl":"https://alpha.invalid","apiKey":"secret-a","models":["a"]},
              {"id":"provider-b","name":"Beta","apiBaseUrl":"https://beta.invalid","apiKey":"secret-b","models":["b"]}
            ]"#,
        );
        let store = FakeCredentialStore {
            fail_on: Some("provider:provider-b".to_string()),
            ..Default::default()
        };

        let error = migrate_legacy_providers_with_store(&legacy, &root.join("app-data"), &store)
            .unwrap_err();
        assert!(error.contains("simulated credential failure"));
        assert!(store.values.borrow().is_empty());
        assert!(store.deleted.borrow().contains("provider:provider-a"));
        assert!(!root.join("app-data/providers.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unsafe_provider_ids_before_creating_any_credentials() {
        let root = temp_root();
        let legacy = root.join("legacy");
        write_legacy_settings(
            &legacy,
            r#"[{"id":"../escape","name":"Bad","apiBaseUrl":"https://bad.invalid","apiKey":"secret","models":["bad"]}]"#,
        );
        let store = FakeCredentialStore::default();

        let error = migrate_legacy_providers_with_store(&legacy, &root.join("app-data"), &store)
            .unwrap_err();
        assert!(error.contains("unsafe id"));
        assert!(store.values.borrow().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires a real operating-system credential store"]
    fn writes_provider_keys_to_the_real_system_credential_store() {
        let root = temp_root();
        let legacy = root.join("legacy");
        let provider_id = format!("system-provider-{}", Uuid::new_v4());
        let secret = format!("system-secret-{}", Uuid::new_v4());
        write_legacy_settings(
            &legacy,
            &format!(
                r#"[{{"id":"{provider_id}","name":"System Test","apiBaseUrl":"https://system.invalid","apiKey":"{secret}","models":["system-model"]}}]"#
            ),
        );

        let result = (|| {
            let report = migrate_legacy_providers(&legacy, &root.join("app-data"))?;
            assert_eq!(report.migrated_providers, 1);
            let entry = Entry::new(KEYRING_SERVICE, &keyring_account(&provider_id))
                .map_err(|error| error.to_string())?;
            let saved_secret = entry.get_password().map_err(|error| error.to_string())?;
            if saved_secret != secret {
                return Err("stored provider secret did not match the source".to_string());
            }
            let metadata = fs::read_to_string(root.join("app-data/providers.json"))
                .map_err(|error| error.to_string())?;
            if metadata.contains(&secret) {
                return Err("providers.json contains a plaintext API key".to_string());
            }
            Ok(())
        })();

        let cleanup_entry = Entry::new(KEYRING_SERVICE, &keyring_account(&provider_id)).unwrap();
        let _ = cleanup_entry.delete_credential();
        let _ = fs::remove_dir_all(root);
        result.unwrap();
    }
}
