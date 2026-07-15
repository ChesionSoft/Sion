mod docx_check;
mod keyring_check;
#[allow(dead_code)]
mod streaming;

use serde::{Deserialize, Serialize};

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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_get_version,
            spike_docx_check,
            spike_keyring_check
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
