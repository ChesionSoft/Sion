//! Pure stream projection, turn transitions, and safe delivery summaries.
//!
//! The projector keeps the raw model response for final parsing but emits only
//! the bytes before the first complete ```delivery fence, so delivery JSON and
//! any partial fence prefix never leak as a visible token.

// Task 4 introduces the turn runtime before the orchestrator wires it up in
// Task 5-7; remove this allowance once every helper has a non-test caller.
#![allow(dead_code)]

use sion_core::{
    AgentDelivery, DeliveryOutcome, DeliveryResolution, DeliveryStage, TurnActivity,
    TurnActivityKind, TurnActivityStatus, WorkflowNodeId,
};

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
    pub delivery: Result<AgentDelivery, String>,
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

    pub fn finish(self) -> ProjectedDelivery {
        let visible_content = self
            .raw
            .find(DELIVERY_FENCE_START)
            .map(|position| self.raw[..position].trim_end().to_string())
            .unwrap_or_else(|| self.raw.trim_end().to_string());
        let delivery = sion_core::parse_agent_response(&self.raw)
            .map(|parsed| parsed.delivery)
            .map_err(|error| error.to_string());
        ProjectedDelivery {
            visible_content,
            delivery,
            raw_response: self.raw,
        }
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

fn activity(
    kind: TurnActivityKind,
    status: TurnActivityStatus,
    label: &str,
    summary: Option<&str>,
    now: &str,
) -> TurnActivity {
    TurnActivity {
        id: kind.as_str().to_string(),
        kind,
        status,
        label: label.to_string(),
        public_summary: summary.map(ToString::to_string),
        started_at: Some(now.to_string()),
        finished_at: (!matches!(
            status,
            TurnActivityStatus::Pending | TurnActivityStatus::Running
        ))
        .then(|| now.to_string()),
    }
}

pub fn running_activities(now: &str) -> Vec<TurnActivity> {
    vec![
        activity(
            TurnActivityKind::Response,
            TurnActivityStatus::Running,
            "Agent 正在回复",
            None,
            now,
        ),
        activity(
            TurnActivityKind::DeliveryCheck,
            TurnActivityStatus::Pending,
            "判断是否更新交付稿",
            None,
            now,
        ),
        activity(
            TurnActivityKind::DeliveryValidate,
            TurnActivityStatus::Pending,
            "校验交付内容",
            None,
            now,
        ),
        activity(
            TurnActivityKind::DeliverySave,
            TurnActivityStatus::Pending,
            "保存交付稿",
            None,
            now,
        ),
    ]
}

pub fn completed_activities(outcome: &DeliveryOutcome, now: &str) -> Vec<TurnActivity> {
    let (check_status, validate_status, save_status, save_summary) = match outcome {
        DeliveryOutcome::Unchanged => (
            TurnActivityStatus::Completed,
            TurnActivityStatus::Completed,
            TurnActivityStatus::Skipped,
            Some("无需更新交付稿"),
        ),
        DeliveryOutcome::PatchApplied { .. } => (
            TurnActivityStatus::Completed,
            TurnActivityStatus::Completed,
            TurnActivityStatus::Completed,
            Some("交付稿已保存"),
        ),
        DeliveryOutcome::AwaitingManualDraftResolution { .. } => (
            TurnActivityStatus::Completed,
            TurnActivityStatus::Completed,
            TurnActivityStatus::Skipped,
            Some("等待处理未保存草稿"),
        ),
        DeliveryOutcome::Conflict { .. } => (
            TurnActivityStatus::Completed,
            TurnActivityStatus::Completed,
            TurnActivityStatus::Failed,
            Some("交付稿版本已变化"),
        ),
        DeliveryOutcome::Failed {
            stage,
            public_error,
        } => {
            let check = if matches!(stage, DeliveryStage::Response) {
                TurnActivityStatus::Skipped
            } else {
                TurnActivityStatus::Failed
            };
            let validate = if matches!(stage, DeliveryStage::Validation) {
                TurnActivityStatus::Failed
            } else {
                TurnActivityStatus::Skipped
            };
            let save = if matches!(stage, DeliveryStage::Save) {
                TurnActivityStatus::Failed
            } else {
                TurnActivityStatus::Skipped
            };
            return vec![
                activity(
                    TurnActivityKind::Response,
                    if matches!(stage, DeliveryStage::Response) {
                        TurnActivityStatus::Failed
                    } else {
                        TurnActivityStatus::Completed
                    },
                    "Agent 回复",
                    None,
                    now,
                ),
                activity(
                    TurnActivityKind::DeliveryCheck,
                    check,
                    "判断是否更新交付稿",
                    Some(public_error),
                    now,
                ),
                activity(
                    TurnActivityKind::DeliveryValidate,
                    validate,
                    "校验交付内容",
                    None,
                    now,
                ),
                activity(
                    TurnActivityKind::DeliverySave,
                    save,
                    "保存交付稿",
                    None,
                    now,
                ),
            ];
        }
        DeliveryOutcome::Cancelled | DeliveryOutcome::Pending => (
            TurnActivityStatus::Skipped,
            TurnActivityStatus::Skipped,
            TurnActivityStatus::Skipped,
            Some("未保存未完成内容"),
        ),
    };
    vec![
        activity(
            TurnActivityKind::Response,
            TurnActivityStatus::Completed,
            "Agent 回复完成",
            None,
            now,
        ),
        activity(
            TurnActivityKind::DeliveryCheck,
            check_status,
            "判断是否更新交付稿",
            None,
            now,
        ),
        activity(
            TurnActivityKind::DeliveryValidate,
            validate_status,
            "校验交付内容",
            None,
            now,
        ),
        activity(
            TurnActivityKind::DeliverySave,
            save_status,
            "保存交付稿",
            save_summary,
            now,
        ),
    ]
}

pub fn public_reasoning_summary(chunks: &[String]) -> Option<String> {
    let joined = chunks
        .iter()
        .map(|chunk| chunk.trim())
        .filter(|chunk| !chunk.is_empty())
        .collect::<Vec<_>>()
        .join("");
    if joined.is_empty() {
        return None;
    }
    Some(joined.chars().take(2_000).collect())
}

pub fn prepare_retry_turn(
    turn: &mut sion_core::ConversationTurn,
    run_id: &str,
    status: sion_core::TurnStatus,
    now: &str,
) {
    turn.run_id = run_id.to_string();
    turn.status = status;
    turn.activities = if status == sion_core::TurnStatus::Running {
        running_activities(now)
    } else {
        Vec::new()
    };
    turn.delivery_outcome = DeliveryOutcome::Pending;
    turn.finished_at = None;
}

pub fn mark_turn_running(turn: &mut sion_core::ConversationTurn, now: &str) {
    turn.status = sion_core::TurnStatus::Running;
    turn.activities = running_activities(now);
    turn.finished_at = None;
}

pub fn mark_turn_cancelled(turn: &mut sion_core::ConversationTurn, now: &str) {
    turn.status = sion_core::TurnStatus::Cancelled;
    turn.activities = completed_activities(&DeliveryOutcome::Cancelled, now);
    turn.delivery_outcome = DeliveryOutcome::Cancelled;
    turn.finished_at = Some(now.to_string());
}

pub fn mark_turn_start_failed(turn: &mut sion_core::ConversationTurn, now: &str) {
    let outcome = DeliveryOutcome::Failed {
        stage: DeliveryStage::Response,
        public_error: "启动 Agent 任务失败".to_string(),
    };
    turn.status = sion_core::TurnStatus::Failed;
    turn.activities = completed_activities(&outcome, now);
    turn.delivery_outcome = outcome;
    turn.finished_at = Some(now.to_string());
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryCompletionPlan {
    Unchanged,
    Apply {
        markdown: String,
        expected_revision: u64,
        section_titles: Vec<String>,
    },
    AwaitingManualDraftResolution {
        expected_revision: u64,
    },
}

/// Validates the explicit delivery decision and decides whether the run should
/// apply a patch, stay unchanged, or defer to manual draft resolution. When the
/// draft is dirty (`delivery_write_allowed == false`) the patch payload is
/// discarded after validation so a retry must produce a fresh decision.
pub fn plan_delivery_completion(
    delivery: AgentDelivery,
    current_markdown: &str,
    node_id: WorkflowNodeId,
    expected_revision: u64,
    delivery_write_allowed: bool,
) -> Result<DeliveryCompletionPlan, sion_core::DeliveryError> {
    let section_titles: Vec<String> = match &delivery {
        AgentDelivery::Patch { sections } => sections
            .iter()
            .map(|section| section.title.clone())
            .collect(),
        _ => Vec::new(),
    };
    let resolution = sion_core::resolve_agent_delivery(delivery, node_id, current_markdown)?;
    match resolution {
        DeliveryResolution::Unchanged => Ok(DeliveryCompletionPlan::Unchanged),
        DeliveryResolution::Markdown(markdown) => {
            if delivery_write_allowed {
                Ok(DeliveryCompletionPlan::Apply {
                    markdown,
                    expected_revision,
                    section_titles,
                })
            } else {
                Ok(DeliveryCompletionPlan::AwaitingManualDraftResolution { expected_revision })
            }
        }
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
        let completed = projector.finish();
        assert_eq!(completed.visible_content, "回答正文");
        assert_eq!(completed.delivery.unwrap(), AgentDelivery::Unchanged);
        assert!(completed.raw_response.contains(r#"{"mode":"unchanged"}"#));
    }

    #[test]
    fn projector_preserves_visible_reply_when_delivery_decision_is_invalid() {
        let mut projector = DeliveryStreamProjector::default();
        projector.push("正文已经完成\n\n```delivery\n{invalid}\n```");
        let completed = projector.finish();
        assert_eq!(completed.visible_content, "正文已经完成");
        assert!(completed.delivery.is_err());
    }

    #[test]
    fn running_and_terminal_activities_expose_public_progress() {
        let running = running_activities("started");
        assert_eq!(running.len(), 4);
        assert_eq!(running[0].status, sion_core::TurnActivityStatus::Running);
        assert_eq!(running[1].status, sion_core::TurnActivityStatus::Pending);

        let completed = completed_activities(&DeliveryOutcome::Unchanged, "finished");
        assert_eq!(completed.len(), 4);
        assert!(completed.iter().all(|activity| matches!(
            activity.status,
            sion_core::TurnActivityStatus::Completed | sion_core::TurnActivityStatus::Skipped
        )));
    }

    #[test]
    fn public_reasoning_summary_is_trimmed_and_bounded() {
        let chunks = vec!["  公开摘要  ".to_string(), "x".repeat(3_000)];
        let summary = public_reasoning_summary(&chunks).unwrap();
        assert!(summary.starts_with("公开摘要"));
        assert!(summary.chars().count() <= 2_000);
        assert!(!summary.contains("  公开摘要  "));
    }

    #[test]
    fn retry_turn_switches_to_the_new_run_and_pending_delivery() {
        let mut original = sion_core::ConversationTurn {
            id: "turn-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: "session-1".into(),
            run_id: "run-old".into(),
            user_message_id: "user-1".into(),
            assistant_message_id: Some("assistant-1".into()),
            status: sion_core::TurnStatus::Completed,
            activities: Vec::new(),
            reasoning_summary: None,
            delivery_outcome: DeliveryOutcome::AwaitingManualDraftResolution {
                expected_revision: 7,
            },
            started_at: "started".into(),
            finished_at: Some("finished".into()),
        };
        prepare_retry_turn(
            &mut original,
            "run-new",
            sion_core::TurnStatus::Running,
            "retry-started",
        );
        assert_eq!(original.run_id, "run-new");
        assert_eq!(original.status, sion_core::TurnStatus::Running);
        assert_eq!(original.delivery_outcome, DeliveryOutcome::Pending);
        assert_eq!(
            original.activities[0].status,
            sion_core::TurnActivityStatus::Running
        );
        assert_eq!(
            original.assistant_message_id.as_deref(),
            Some("assistant-1")
        );
    }

    #[test]
    fn queued_turn_transitions_are_explicit_and_preserve_message_identity() {
        let mut turn = sion_core::ConversationTurn {
            id: "turn-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            user_message_id: "user-1".into(),
            assistant_message_id: Some("assistant-1".into()),
            status: sion_core::TurnStatus::Queued,
            activities: Vec::new(),
            reasoning_summary: None,
            delivery_outcome: DeliveryOutcome::Pending,
            started_at: "started".into(),
            finished_at: None,
        };
        mark_turn_running(&mut turn, "running");
        assert_eq!(turn.status, sion_core::TurnStatus::Running);
        assert_eq!(
            turn.activities[0].status,
            sion_core::TurnActivityStatus::Running
        );
        mark_turn_cancelled(&mut turn, "cancelled");
        assert_eq!(turn.status, sion_core::TurnStatus::Cancelled);
        assert_eq!(turn.delivery_outcome, DeliveryOutcome::Cancelled);
        assert_eq!(turn.assistant_message_id.as_deref(), Some("assistant-1"));
        assert_eq!(turn.finished_at.as_deref(), Some("cancelled"));
        mark_turn_start_failed(&mut turn, "failed");
        assert_eq!(turn.status, sion_core::TurnStatus::Failed);
        assert_eq!(turn.finished_at.as_deref(), Some("failed"));
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

    fn goals_markdown() -> &'static str {
        "# 需求背景与建设目标\n\n## 需求背景\n已有背景\n\n## 建设目标\n已有目标\n\n## 范围边界\n已有边界"
    }

    fn valid_goals_patch() -> AgentDelivery {
        AgentDelivery::Patch {
            sections: vec![sion_core::AgentDeliverySection {
                title: "建设目标".into(),
                content: "补充后的目标".into(),
            }],
        }
    }

    #[test]
    fn unchanged_completion_does_not_request_a_node_save() {
        let plan = plan_delivery_completion(
            AgentDelivery::Unchanged,
            "# 目标\n\n## 建设目标\n已有",
            WorkflowNodeId::Goals,
            7,
            true,
        )
        .unwrap();
        assert_eq!(plan, DeliveryCompletionPlan::Unchanged);
    }

    #[test]
    fn dirty_start_defers_a_valid_patch_without_reusing_it() {
        let plan = plan_delivery_completion(
            valid_goals_patch(),
            goals_markdown(),
            WorkflowNodeId::Goals,
            7,
            false,
        )
        .unwrap();
        assert_eq!(
            plan,
            DeliveryCompletionPlan::AwaitingManualDraftResolution {
                expected_revision: 7
            }
        );
    }
}
