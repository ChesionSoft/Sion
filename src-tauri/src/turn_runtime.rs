//! Pure stream projection, turn transitions, and safe delivery summaries.
//!
//! The projector keeps the raw model response for final parsing but emits only
//! the bytes before the first complete ```delivery fence, so delivery JSON and
//! any partial fence prefix never leak as a visible token.

// Task 4 introduces the turn runtime before the orchestrator wires it up in
// Task 5-7; remove this allowance once every helper has a non-test caller.
#![allow(dead_code)]

use sion_core::{AgentDelivery, DeliveryOutcome, DeliveryStage};

const DELIVERY_FENCE_START: &str = "```delivery";

#[derive(Debug, Default)]
pub struct DeliveryStreamProjector {
    raw: String,
    buffer: String,
    emitted: String,
    fence_started: bool,
}

#[derive(Debug, Clone)]
pub struct ProjectedDelivery {
    pub visible_content: String,
    pub delivery: AgentDelivery,
    pub raw_response: String,
}

impl DeliveryStreamProjector {
    pub fn push(&mut self, chunk: &str) -> String {
        self.raw.push_str(chunk);
        if self.fence_started {
            return String::new();
        }
        self.buffer.push_str(chunk);
        if let Some(fence_pos) = self.buffer.find(DELIVERY_FENCE_START) {
            let visible = self.buffer[..fence_pos].to_string();
            self.buffer.clear();
            self.fence_started = true;
            self.emitted.push_str(&visible);
            return visible;
        }
        let safe_len = self.safe_emit_len();
        let visible = self.buffer[..safe_len].to_string();
        self.buffer = self.buffer[safe_len..].to_string();
        self.emitted.push_str(&visible);
        visible
    }

    pub fn raw_response(&self) -> &str {
        &self.raw
    }

    pub fn finish(self) -> Result<ProjectedDelivery, String> {
        let parsed = sion_core::parse_agent_response(&self.raw)
            .map_err(|error| error.to_string())?;
        if self.emitted.trim_end() != parsed.visible_content {
            return Err(
                "projected visible content did not match the parsed delivery block".to_string(),
            );
        }
        Ok(ProjectedDelivery {
            visible_content: parsed.visible_content,
            delivery: parsed.delivery,
            raw_response: self.raw,
        })
    }

    /// Returns how many leading bytes of `buffer` are safe to emit now, holding
    /// back any trailing suffix that could be the start of ```delivery.
    fn safe_emit_len(&self) -> usize {
        let bytes = self.buffer.as_bytes();
        let max_hold = DELIVERY_FENCE_START.len().saturating_sub(1);
        if bytes.len() <= max_hold {
            return 0;
        }
        let scan_start = bytes.len() - max_hold;
        let mut hold = 0;
        for start in scan_start..bytes.len() {
            if !self.buffer.is_char_boundary(start) {
                continue;
            }
            let tail = &self.buffer[start..];
            if DELIVERY_FENCE_START.starts_with(tail) {
                hold = bytes.len() - start;
                break;
            }
        }
        bytes.len() - hold
    }
}

/// Maps an internal delivery failure to a fixed safe public summary. Provider
/// bodies, filesystem paths, and debug strings never cross this boundary.
pub fn safe_delivery_error(stage: DeliveryStage, _error: &str) -> DeliveryOutcome {
    let public_error = match stage {
        DeliveryStage::Response => "模型回复失败",
        DeliveryStage::Decision => "模型回复未包含有效交付决策",
        DeliveryStage::Validation => "交付稿结构校验失败",
        DeliveryStage::Save => "保存时交付稿版本已变化",
    };
    DeliveryOutcome::Failed {
        stage,
        public_error: public_error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projector_never_emits_delivery_json_even_when_marker_splits_across_tokens() {
        let mut projector = DeliveryStreamProjector::default();
        assert_eq!(projector.push("回答正文\n\n```del"), "回答正文\n\n");
        assert_eq!(projector.push("ivery\n{\"mode\":\"unchanged\"}\n```"), "");
        let completed = projector.finish().unwrap();
        assert_eq!(completed.visible_content, "回答正文");
        assert!(completed.raw_response.contains(r#"{"mode":"unchanged"}"#));
    }

    #[test]
    fn safe_delivery_error_uses_fixed_summaries_without_leaking_the_internal_error() {
        let outcome = safe_delivery_error(
            DeliveryStage::Validation,
            "internal: /Users/secret/path db error",
        );
        let DeliveryOutcome::Failed { public_error, .. } = outcome else {
            panic!("expected failed outcome");
        };
        assert_eq!(public_error, "交付稿结构校验失败");
        assert!(!public_error.contains("secret"));
    }
}
