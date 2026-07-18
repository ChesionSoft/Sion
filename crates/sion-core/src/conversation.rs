//! Conversation execution context for Sion Desktop.
//!
//! Pure domain types for reasoning effort, model selection, file attachment
//! references, frozen execution metadata, and deterministic input-token
//! estimation. This module has no dependency on Tauri, HTTP, or the filesystem.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Off,
    Low,
    #[default]
    Medium,
    High,
}

impl ReasoningEffort {
    pub fn provider_value(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High => Some("high"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelSelection {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachmentRef {
    pub file_id: String,
    pub original_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelExecution {
    pub provider_id: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextEstimateStatus {
    Ready,
    Warning,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEstimate {
    pub estimated_input_tokens: u64,
    pub context_window_tokens: u64,
    pub ratio: f64,
    pub status: ContextEstimateStatus,
}

pub fn estimate_input_tokens(text: &str) -> u64 {
    let mut ascii_bytes = 0_u64;
    let mut non_ascii = 0_u64;
    for character in text.chars() {
        if character.is_ascii() {
            ascii_bytes += character.len_utf8() as u64;
        } else {
            non_ascii += 1;
        }
    }
    let base = ascii_bytes.div_ceil(4) + non_ascii;
    (base * 115).div_ceil(100)
}

pub fn estimate_context(text: &str, window: u64) -> ContextEstimate {
    let estimated = estimate_input_tokens(text);
    let ratio = estimated as f64 / window as f64;
    let status = if ratio > 1.0 {
        ContextEstimateStatus::Blocked
    } else if ratio >= 0.8 {
        ContextEstimateStatus::Warning
    } else {
        ContextEstimateStatus::Ready
    };
    ContextEstimate {
        estimated_input_tokens: estimated,
        context_window_tokens: window,
        ratio,
        status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_effort_defaults_to_medium_and_serializes_snake_case() {
        assert_eq!(ReasoningEffort::default(), ReasoningEffort::Medium);
        assert_eq!(
            serde_json::to_string(&ReasoningEffort::Off).unwrap(),
            "\"off\""
        );
        assert_eq!(ReasoningEffort::High.provider_value(), Some("high"));
        assert_eq!(ReasoningEffort::Off.provider_value(), None);
    }

    #[test]
    fn estimates_ascii_unicode_and_thresholds_deterministically() {
        assert_eq!(estimate_input_tokens("abcdefgh"), 3); // ceil(2 * 1.15)
        assert_eq!(estimate_input_tokens("需求"), 3); // ceil(2 * 1.15)
        assert_eq!(
            estimate_context("a".repeat(276).as_str(), 100).status,
            ContextEstimateStatus::Warning
        );
        assert_eq!(
            estimate_context("a".repeat(348).as_str(), 100).status,
            ContextEstimateStatus::Blocked
        );
    }
}
