//! Durable conversation turn, activity, and delivery-outcome wire types.

use crate::WorkflowNodeId;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnActivityKind {
    Response,
    DeliveryCheck,
    DeliveryValidate,
    DeliverySave,
}

impl TurnActivityKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Response => "response",
            Self::DeliveryCheck => "delivery_check",
            Self::DeliveryValidate => "delivery_validate",
            Self::DeliverySave => "delivery_save",
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
    pub delivery_outcome: DeliveryOutcome,
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
            delivery_outcome: DeliveryOutcome::PatchApplied {
                previous_revision: 7,
                revision: 8,
                section_titles: vec!["建设目标".into()],
            },
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
}
