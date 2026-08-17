//! Run-kind compatibility tests for the Harness migration.
//!
//! New node conversations use `AgentRunKind::Harness`; legacy conversation,
//! delivery-decision, delivery-retry, and export run kinds must keep
//! deserializing from historical run files without any bulk rewrite.

use sion_agent::{AgentRun, AgentRunKind, AgentRunStatus};

#[test]
fn harness_kind_serializes_and_deserializes_as_harness() {
    assert_eq!(serde_json::to_value(AgentRunKind::Harness).unwrap(), "harness");
    assert_eq!(
        serde_json::from_value::<AgentRunKind>(serde_json::json!("harness")).unwrap(),
        AgentRunKind::Harness
    );
}

#[test]
fn harness_execution_kind_serializes_and_is_a_conversation_run() {
    assert_eq!(
        serde_json::to_value(AgentRunKind::HarnessExecution).unwrap(),
        "harness_execution"
    );
    assert_eq!(
        serde_json::from_value::<AgentRunKind>(serde_json::json!("harness_execution")).unwrap(),
        AgentRunKind::HarnessExecution
    );
    assert!(AgentRunKind::HarnessExecution.is_conversation_run());
    assert!(AgentRunKind::Harness.is_conversation_run());
    assert!(!AgentRunKind::ExportBlueprint.is_conversation_run());
}

#[test]
fn legacy_kinds_keep_their_exact_wire_names() {
    for (kind, wire) in [
        (AgentRunKind::Conversation, "conversation"),
        (AgentRunKind::DeliveryDecision, "delivery_decision"),
        (AgentRunKind::DeliveryRetry, "delivery_retry"),
        (AgentRunKind::DeliveryRegeneration, "delivery_regeneration"),
        (AgentRunKind::ExportBlueprint, "export_blueprint"),
        (AgentRunKind::ExportDraft, "export_draft"),
        (AgentRunKind::ExportReview, "export_review"),
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<AgentRunKind>(serde_json::json!(wire)).unwrap(),
            kind
        );
    }
}

#[test]
fn a_harness_run_record_round_trips_through_serde() {
    let run = AgentRun {
        id: "run-harness".into(),
        project_id: "project-1".into(),
        node_id: sion_core::WorkflowNodeId::Goals,
        status: AgentRunStatus::Completed,
        created_at: "2026-08-17T00:00:00Z".into(),
        started_at: Some("2026-08-17T00:00:01Z".into()),
        finished_at: Some("2026-08-17T00:00:02Z".into()),
        summary: Some("Harness 对话完成".into()),
        provider_id: Some("provider-1".into()),
        model: Some("model-1".into()),
        reasoning_effort: None,
        file_ids: vec!["file-1".into()],
        kind: AgentRunKind::Harness,
        session_id: Some("session-1".into()),
        turn_id: Some("turn-1".into()),
        context_snapshot: None,
        usage: None,
        duration_ms: Some(1000),
    };
    let value = serde_json::to_value(&run).unwrap();
    assert_eq!(value["kind"], "harness");
    assert_eq!(value["sessionId"], "session-1");
    let back: AgentRun = serde_json::from_value(value).unwrap();
    assert_eq!(back, run);
}

#[test]
fn legacy_run_records_load_without_harness_fields() {
    let legacy = serde_json::json!({
        "id": "run-legacy",
        "projectId": "project-1",
        "nodeId": "goals",
        "status": "interrupted",
        "createdAt": "2026-07-18T00:00:00Z",
        "startedAt": null,
        "finishedAt": null,
        "summary": null,
        "fileIds": [],
        "kind": "conversation"
    });
    let run: AgentRun = serde_json::from_value(legacy).unwrap();
    assert_eq!(run.kind, AgentRunKind::Conversation);
    assert_eq!(run.status, AgentRunStatus::Interrupted);
    assert_eq!(run.session_id, None);
    assert_eq!(run.turn_id, None);
}
