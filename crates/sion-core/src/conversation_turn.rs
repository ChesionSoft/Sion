//! Durable conversation turn, activity, and delivery-outcome wire types.

use crate::{HarnessTurnState, WorkflowNodeId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

/// Fixed kinds used by the legacy pipeline plus the dynamic kinds a Harness
/// turn produces. The four original kinds keep their exact wire names so
/// historical turns deserialize unchanged; unknown future kinds fall back to
/// `Other` instead of failing the whole document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnActivityKind {
    Response,
    DeliveryCheck,
    DeliveryValidate,
    DeliverySave,
    /// A safe read of an approved project document (current node, attachment,
    /// or dependency section) requested by the model.
    ToolRead,
    /// An in-context literal/token search over approved project content.
    Search,
    /// A delivery or Agent-rule proposal being prepared or revised.
    Proposal,
    /// Deterministic validation of a proposal candidate.
    Validation,
    /// A valid proposal is ready for user review.
    ProposalReady,
    /// Fallback for unknown future kinds so historical documents stay readable.
    #[serde(other)]
    Other,
}

impl TurnActivityKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Response => "response",
            Self::DeliveryCheck => "delivery_check",
            Self::DeliveryValidate => "delivery_validate",
            Self::DeliverySave => "delivery_save",
            Self::ToolRead => "tool_read",
            Self::Search => "search",
            Self::Proposal => "proposal",
            Self::Validation => "validation",
            Self::ProposalReady => "proposal_ready",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnActivityStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnActivity {
    pub id: String,
    pub kind: TurnActivityKind,
    pub status: TurnActivityStatus,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl TurnActivity {
    pub fn completed(
        kind: TurnActivityKind,
        label: impl Into<String>,
        now: impl Into<String>,
    ) -> Self {
        let now = now.into();
        let id = kind.as_str().to_string();
        Self {
            id,
            kind,
            status: TurnActivityStatus::Completed,
            label: label.into(),
            public_summary: None,
            started_at: Some(now.clone()),
            finished_at: Some(now),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStage {
    Response,
    Decision,
    Validation,
    Save,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DeliveryOutcome {
    Pending,
    Unchanged,
    PatchApplied {
        previous_revision: u64,
        revision: u64,
        section_titles: Vec<String>,
    },
    AwaitingManualDraftResolution {
        expected_revision: u64,
    },
    Conflict {
        expected_revision: u64,
        actual_revision: u64,
    },
    Failed {
        stage: DeliveryStage,
        public_error: String,
    },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryDecisionInspection {
    pub raw_response: String,
    pub base_markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposed_markdown: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    pub id: String,
    pub project_id: String,
    pub node_id: WorkflowNodeId,
    pub session_id: String,
    pub run_id: String,
    pub user_message_id: String,
    pub assistant_message_id: Option<String>,
    pub status: TurnStatus,
    pub activities: Vec<TurnActivity>,
    pub reasoning_summary: Option<String>,
    /// Legacy fixed-pipeline delivery outcome. Harness turns omit this field
    /// and carry `harness` instead; `#[serde(default)]` keeps historical JSON
    /// with a `deliveryOutcome` field deserializing unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_outcome: Option<DeliveryOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_inspection: Option<DeliveryDecisionInspection>,
    /// Explicit Harness marker/state for new node conversations. Legacy turns
    /// leave this `None` so no bulk rewrite is needed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<HarnessTurnState>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_round_trips_with_a_patch_result() {
        let turn = ConversationTurn {
            id: "turn-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            user_message_id: "user-1".into(),
            assistant_message_id: Some("assistant-1".into()),
            status: TurnStatus::Completed,
            activities: vec![TurnActivity::completed(
                TurnActivityKind::DeliverySave,
                "交付稿已保存",
                "2026-07-18T00:00:00Z",
            )],
            reasoning_summary: Some("核对了当前章节与用户新增约束。".into()),
            delivery_outcome: Some(DeliveryOutcome::PatchApplied {
                previous_revision: 7,
                revision: 8,
                section_titles: vec!["建设目标".into()],
            }),
            delivery_inspection: None,
            harness: None,
            started_at: "2026-07-18T00:00:00Z".into(),
            finished_at: Some("2026-07-18T00:00:01Z".into()),
        };
        let value = serde_json::to_value(&turn).unwrap();
        assert_eq!(value["status"], "completed");
        assert_eq!(value["deliveryOutcome"]["kind"], "patch_applied");
        assert_eq!(
            serde_json::from_value::<ConversationTurn>(value).unwrap(),
            turn
        );
    }

    #[test]
    fn delivery_inspection_round_trips_with_raw_base_and_proposed_markdown() {
        let raw = "```delivery\n{\"mode\":\"patch\",\"sections\":[{\"title\":\"建设目标\",\"content\":\"版本为 v1.0\"}]}\n```";
        let base = "# 需求背景与建设目标\n\n## 建设目标\n已有";
        let proposed = "# 需求背景与建设目标\n\n## 建设目标\n版本为 v1.0";
        let turn = ConversationTurn {
            id: "turn-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            user_message_id: "user-1".into(),
            assistant_message_id: Some("assistant-1".into()),
            status: TurnStatus::Completed,
            activities: Vec::new(),
            reasoning_summary: None,
            delivery_outcome: Some(DeliveryOutcome::PatchApplied {
                previous_revision: 7,
                revision: 8,
                section_titles: vec!["建设目标".into()],
            }),
            delivery_inspection: Some(DeliveryDecisionInspection {
                raw_response: raw.into(),
                base_markdown: base.into(),
                proposed_markdown: Some(proposed.into()),
            }),
            harness: None,
            started_at: "2026-07-18T00:00:00Z".into(),
            finished_at: Some("2026-07-18T00:00:01Z".into()),
        };
        let value = serde_json::to_value(&turn).unwrap();
        assert_eq!(value["deliveryInspection"]["rawResponse"], raw);
        assert_eq!(value["deliveryInspection"]["baseMarkdown"], base);
        assert_eq!(value["deliveryInspection"]["proposedMarkdown"], proposed);
        assert_eq!(
            serde_json::from_value::<ConversationTurn>(value).unwrap(),
            turn
        );
    }

    #[test]
    fn delivery_inspection_is_skipped_when_absent_and_legacy_turns_deserialize() {
        let legacy = serde_json::json!({
            "id": "turn-1",
            "projectId": "project-1",
            "nodeId": "goals",
            "sessionId": "session-1",
            "runId": "run-1",
            "userMessageId": "user-1",
            "assistantMessageId": "assistant-1",
            "status": "completed",
            "activities": [],
            "reasoningSummary": null,
            "deliveryOutcome": { "kind": "unchanged" },
            "startedAt": "2026-07-18T00:00:00Z",
            "finishedAt": "2026-07-18T00:00:01Z"
        });
        let turn: ConversationTurn = serde_json::from_value(legacy).unwrap();
        assert_eq!(turn.delivery_outcome, Some(DeliveryOutcome::Unchanged));
        assert_eq!(turn.delivery_inspection, None);
        assert_eq!(turn.harness, None);
        let value = serde_json::to_value(&turn).unwrap();
        assert!(value.get("deliveryInspection").is_none());
        assert!(value.get("harness").is_none());
    }

    #[test]
    fn harness_turn_omits_legacy_delivery_fields_and_round_trips_its_state() {
        let harness = crate::HarnessTurnState {
            proposals: vec![crate::HarnessProposal {
                id: "proposal-1".into(),
                kind: crate::HarnessProposalKind::Delivery,
                status: crate::HarnessProposalStatus::Ready,
                project_id: "project-1".into(),
                node_id: WorkflowNodeId::Goals,
                turn_id: "turn-1".into(),
                base_revision: Some(3),
                base_rule_digest: None,
                base_content: "旧".into(),
                proposed_content: "新".into(),
                reason: "用户要求补充".into(),
                validation_summary: Some("校验通过".into()),
                created_at: "now".into(),
                resolved_at: None,
            }],
            diagnostics: Some(crate::HarnessDiagnostics {
                model_steps: 1,
                tool_calls: 1,
                validation_retries: 0,
                limit_reached: None,
                tool_traces: Vec::new(),
            }),
        };
        let turn = ConversationTurn {
            id: "turn-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            user_message_id: "user-1".into(),
            assistant_message_id: Some("assistant-1".into()),
            status: TurnStatus::Completed,
            activities: Vec::new(),
            reasoning_summary: None,
            delivery_outcome: None,
            delivery_inspection: None,
            harness: Some(harness),
            started_at: "2026-07-18T00:00:00Z".into(),
            finished_at: Some("2026-07-18T00:00:01Z".into()),
        };
        let value = serde_json::to_value(&turn).unwrap();
        assert!(value.get("deliveryOutcome").is_none());
        assert!(value.get("deliveryInspection").is_none());
        assert_eq!(value["harness"]["proposals"][0]["kind"], "delivery");
        assert_eq!(value["harness"]["diagnostics"]["modelSteps"], 1);
        assert_eq!(
            serde_json::from_value::<ConversationTurn>(value).unwrap(),
            turn
        );
    }

    #[test]
    fn a_turn_without_harness_or_delivery_fields_still_loads() {
        let minimal = serde_json::json!({
            "id": "turn-1",
            "projectId": "project-1",
            "nodeId": "goals",
            "sessionId": "session-1",
            "runId": "run-1",
            "userMessageId": "user-1",
            "status": "queued",
            "activities": [],
            "reasoningSummary": null,
            "startedAt": "2026-07-18T00:00:00Z"
        });
        let turn: ConversationTurn = serde_json::from_value(minimal).unwrap();
        assert_eq!(turn.delivery_outcome, None);
        assert_eq!(turn.harness, None);
        assert_eq!(turn.finished_at, None);
    }
}
