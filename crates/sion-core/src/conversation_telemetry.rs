//! Conversation context and token-usage telemetry.
//!
//! The functions in this module intentionally stay provider-agnostic. Exact
//! provider usage is accepted only when it is internally consistent; otherwise
//! the same deterministic estimator used by context preflight supplies a safe
//! fallback.

use serde::{Deserialize, Serialize};

use crate::{
    ChatMessage, ContextEstimateStatus, ModelCallCategory, ModelCallStatus, ModelCallUsage,
    TokenUsageSource, TurnTokenUsage, estimate_input_tokens,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageBreakdown {
    pub protocol_tokens: u64,
    pub rules_tokens: u64,
    pub node_markdown_tokens: u64,
    pub conversation_tokens: u64,
    pub attachment_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CumulativeTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub call_count: u32,
    pub source: TokenUsageSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextSnapshot {
    pub estimated_input_tokens: u64,
    pub context_window_tokens: u64,
    pub ratio: f64,
    pub status: ContextEstimateStatus,
    pub breakdown: ContextUsageBreakdown,
    pub cumulative_usage: CumulativeTokenUsage,
    pub calculated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

pub fn normalize_provider_usage(usage: ProviderTokenUsage) -> Option<ProviderTokenUsage> {
    if usage.input_tokens == 0 {
        return None;
    }
    let total_tokens = usage.input_tokens.checked_add(usage.output_tokens)?;
    (total_tokens == usage.total_tokens).then_some(usage)
}

#[allow(clippy::too_many_arguments)]
pub fn build_turn_usage(
    turn_id: &str,
    call_id: &str,
    provider_id: &str,
    model: &str,
    category: ModelCallCategory,
    status: ModelCallStatus,
    exact: Option<ProviderTokenUsage>,
    input_text: &str,
    output_text: &str,
) -> TurnTokenUsage {
    let (source, input_tokens, output_tokens, total_tokens) = exact
        .and_then(normalize_provider_usage)
        .map(|usage| {
            (
                TokenUsageSource::Exact,
                usage.input_tokens,
                usage.output_tokens,
                usage.total_tokens,
            )
        })
        .unwrap_or_else(|| {
            let input_tokens = estimate_input_tokens(input_text);
            let output_tokens = estimate_input_tokens(output_text);
            (
                TokenUsageSource::Estimated,
                input_tokens,
                output_tokens,
                input_tokens.saturating_add(output_tokens),
            )
        });

    TurnTokenUsage {
        turn_id: turn_id.to_owned(),
        source: source.clone(),
        call_count: 1,
        calls: vec![ModelCallUsage {
            id: call_id.to_owned(),
            category,
            provider_id: provider_id.to_owned(),
            model: model.to_owned(),
            source,
            status,
            input_tokens,
            output_tokens,
            total_tokens,
        }],
        input_tokens,
        output_tokens,
        total_tokens,
    }
}

pub fn aggregate_usages<'a>(
    usages: impl IntoIterator<Item = &'a TurnTokenUsage>,
) -> CumulativeTokenUsage {
    let mut result = CumulativeTokenUsage {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        call_count: 0,
        source: TokenUsageSource::Exact,
    };
    let mut saw_exact = false;
    let mut saw_estimated = false;

    for usage in usages {
        result.input_tokens = result.input_tokens.saturating_add(usage.input_tokens);
        result.output_tokens = result.output_tokens.saturating_add(usage.output_tokens);
        result.total_tokens = result.total_tokens.saturating_add(usage.total_tokens);
        result.call_count = result.call_count.saturating_add(usage.call_count);
        match usage.source {
            TokenUsageSource::Exact => saw_exact = true,
            TokenUsageSource::Estimated => saw_estimated = true,
            TokenUsageSource::Mixed => {
                saw_exact = true;
                saw_estimated = true;
            }
        }
    }

    result.source = match (saw_exact, saw_estimated) {
        (true, true) => TokenUsageSource::Mixed,
        (false, true) => TokenUsageSource::Estimated,
        _ => TokenUsageSource::Exact,
    };
    result
}

pub fn aggregate_message_usage(messages: &[ChatMessage]) -> CumulativeTokenUsage {
    aggregate_usages(messages.iter().filter_map(|message| message.usage.as_ref()))
}
