//! Contract tests for confirmed Harness execution types and predicates.
//!
//! These fixtures pin the serde wire contract for the pending execution plan,
//! its lifecycle, the execution audit record, the write result, and the pure
//! confirmation predicates shared by the agent layer, the Tauri registry, the
//! storage layer, and the frontend. Legacy turns and run kinds must keep
//! loading unchanged while the new fields default gracefully.

use sion_core::{
    ConversationTurn, HarnessExecutionPlan, HarnessExecutionRecord, HarnessExecutionStatus,
    HarnessExecutionWrite, HarnessExecutionWriteResult, HarnessPlanInvalidReason, HarnessPlanStatus,
    HarnessProposal, HarnessProposalKind, HarnessProposalStatus, HarnessTurnState, TurnStatus,
    WorkflowNodeId, is_execution_confirmation, requests_execution_confirmation,
};

#[test]
fn plan_contract_pins_wire_names_and_optional_lifecycle() {
    let plan = HarnessExecutionPlan {
        id: "plan-1".into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::BusinessFlow,
        session_id: "session-1".into(),
        plan_turn_id: "turn-1".into(),
        plan_message_id: "message-1".into(),
        base_revision: 7,
        targets: Vec::new(),
        summary: "补充流程步骤并调整核心业务流程".into(),
        status: HarnessPlanStatus::Pending,
        created_at: "now".into(),
        expires_at: "later".into(),
        consumed_at: None,
        invalidated_at: None,
        invalid_reason: None,
    };
    let value = serde_json::to_value(&plan).unwrap();
    assert_eq!(value["id"], "plan-1");
    assert_eq!(value["nodeId"], "business-flow");
    assert_eq!(value["planTurnId"], "turn-1");
    assert_eq!(value["planMessageId"], "message-1");
    assert_eq!(value["baseRevision"], 7);
    assert_eq!(value["status"], "pending");
    assert!(value.get("consumedAt").is_none());
    assert!(value.get("invalidatedAt").is_none());
    assert!(value.get("invalidReason").is_none());
    assert_eq!(
        serde_json::from_value::<HarnessExecutionPlan>(value).unwrap(),
        plan
    );

    let invalidated = HarnessExecutionPlan {
        status: HarnessPlanStatus::Invalidated,
        consumed_at: None,
        invalidated_at: Some("later".into()),
        invalid_reason: Some(HarnessPlanInvalidReason::ManualEdit),
        ..plan
    };
    let value = serde_json::to_value(&invalidated).unwrap();
    assert_eq!(value["status"], "invalidated");
    assert_eq!(value["invalidReason"], "manual_edit");
    assert_eq!(
        serde_json::from_value::<HarnessExecutionPlan>(value).unwrap(),
        invalidated
    );
}

#[test]
fn plan_status_and_invalid_reason_cover_all_terminal_paths() {
    assert_eq!(serde_json::to_value(HarnessPlanStatus::Pending).unwrap(), "pending");
    assert_eq!(serde_json::to_value(HarnessPlanStatus::Consumed).unwrap(), "consumed");
    assert_eq!(serde_json::to_value(HarnessPlanStatus::Invalidated).unwrap(), "invalidated");
    for (reason, wire) in [
        (HarnessPlanInvalidReason::Expired, "expired"),
        (HarnessPlanInvalidReason::NodeChanged, "node_changed"),
        (HarnessPlanInvalidReason::SessionDeleted, "session_deleted"),
        (HarnessPlanInvalidReason::Cancelled, "cancelled"),
        (HarnessPlanInvalidReason::Restarted, "restarted"),
        (HarnessPlanInvalidReason::AmbiguousConfirmation, "ambiguous_confirmation"),
        (HarnessPlanInvalidReason::ManualEdit, "manual_edit"),
        (HarnessPlanInvalidReason::TargetChanged, "target_changed"),
        (HarnessPlanInvalidReason::TargetMissing, "target_missing"),
    ] {
        assert_eq!(serde_json::to_value(reason).unwrap(), wire);
    }
}

#[test]
fn execution_record_audits_writes_without_content_or_secrets() {
    let record = HarnessExecutionRecord {
        run_id: "run-1".into(),
        turn_id: "turn-1".into(),
        started_at: "start".into(),
        finished_at: Some("finish".into()),
        status: HarnessExecutionStatus::Completed,
        writes: vec![
            HarnessExecutionWrite {
                node_id: Some(WorkflowNodeId::BusinessFlow),
                revision: 8,
                summary: "保存核心业务流程章节".into(),
                saved_at: "s1".into(),
            },
            HarnessExecutionWrite {
                node_id: Some(WorkflowNodeId::BusinessFlow),
                revision: 9,
                summary: "保存流程步骤章节".into(),
                saved_at: "s2".into(),
            },
        ],
        completed_targets: vec![WorkflowNodeId::BusinessFlow],
        stopped_target: None,
        stopped_reason: None,
        public_error: None,
    };
    let value = serde_json::to_value(&record).unwrap();
    assert_eq!(value["status"], "completed");
    assert_eq!(value["writes"].as_array().unwrap().len(), 2);
    assert_eq!(value["writes"][1]["revision"], 9);
    let serialized = serde_json::to_string(&record).unwrap();
    assert!(!serialized.contains("secret"));
    assert!(!serialized.contains("/nodes/"));
    assert!(!serialized.contains("prompt"));
    assert_eq!(
        serde_json::from_value::<HarnessExecutionRecord>(value).unwrap(),
        record
    );
}

#[test]
fn write_result_round_trips_every_safe_outcome() {
    for result in [
        HarnessExecutionWriteResult::Saved { revision: 9 },
        HarnessExecutionWriteResult::Conflict {
            expected_revision: 8,
            actual_revision: 10,
        },
        HarnessExecutionWriteResult::Unchanged,
        HarnessExecutionWriteResult::ValidationFailed {
            public_error: "缺少必填章节".into(),
        },
        HarnessExecutionWriteResult::Cancelled,
    ] {
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(
            serde_json::from_value::<HarnessExecutionWriteResult>(value).unwrap(),
            result
        );
    }
}

#[test]
fn confirmation_predicates_cover_chinese_and_english() {
    assert!(requests_execution_confirmation("请确认后我将执行上述修改。"));
    assert!(requests_execution_confirmation("是否继续？请回复“继续”。"));
    assert!(requests_execution_confirmation("Please confirm before I proceed."));
    assert!(is_execution_confirmation("继续"));
    assert!(is_execution_confirmation("可以"));
    assert!(is_execution_confirmation("OK"));
    assert!(is_execution_confirmation("go ahead"));
    assert!(!is_execution_confirmation("不要"));
    assert!(!is_execution_confirmation("取消"));
    assert!(!is_execution_confirmation("no"));
    assert!(!is_execution_confirmation("好的，我们改一下需求"));
}

#[test]
fn legacy_turn_with_plan_state_still_loads_and_plan_is_optional() {
    let legacy = serde_json::json!({
        "id": "turn-legacy",
        "projectId": "project-1",
        "nodeId": "goals",
        "sessionId": "session-1",
        "runId": "run-1",
        "userMessageId": "user-1",
        "status": "completed",
        "activities": [],
        "reasoningSummary": null,
        "startedAt": "2026-07-18T00:00:00Z"
    });
    let turn: ConversationTurn = serde_json::from_value(legacy).unwrap();
    assert_eq!(turn.harness, None);

    // A Harness turn with only proposals/diagnostics (historical) loads with
    // both new optional fields absent.
    let historical = serde_json::json!({
        "id": "turn-h",
        "projectId": "project-1",
        "nodeId": "goals",
        "sessionId": "session-1",
        "runId": "run-1",
        "userMessageId": "user-1",
        "status": "completed",
        "activities": [],
        "reasoningSummary": null,
        "harness": {
            "proposals": [],
            "diagnostics": { "modelSteps": 1, "toolCalls": 0, "validationRetries": 0 }
        },
        "startedAt": "2026-07-18T00:00:00Z"
    });
    let turn: ConversationTurn = serde_json::from_value(historical).unwrap();
    let harness = turn.harness.unwrap();
    assert_eq!(harness.execution_plan, None);
    assert_eq!(harness.execution, None);
}

#[test]
fn planning_turn_with_plan_round_trips_inside_harness_state() {
    let plan = HarnessExecutionPlan {
        id: "plan-x".into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: "session-1".into(),
        plan_turn_id: "turn-plan".into(),
        plan_message_id: "message-plan".into(),
        base_revision: 2,
        targets: Vec::new(),
        summary: "补充范围边界".into(),
        status: HarnessPlanStatus::Pending,
        created_at: "created".into(),
        expires_at: "expires".into(),
        consumed_at: None,
        invalidated_at: None,
        invalid_reason: None,
    };
    let state = HarnessTurnState {
        proposals: vec![HarnessProposal {
            id: "proposal-1".into(),
            kind: HarnessProposalKind::Delivery,
            status: HarnessProposalStatus::Ready,
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            turn_id: "turn-plan".into(),
            base_revision: Some(2),
            base_rule_digest: None,
            base_content: "旧".into(),
            proposed_content: "新".into(),
            reason: "补充".into(),
            validation_summary: None,
            created_at: "created".into(),
            resolved_at: None,
            latest_revision: None,
            latest_rule_digest: None,
        }],
        diagnostics: None,
        execution_plan: Some(plan.clone()),
        execution: None,
    };
    let turn = ConversationTurn {
        id: "turn-plan".into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: "session-1".into(),
        run_id: "run-plan".into(),
        user_message_id: "user-1".into(),
        assistant_message_id: Some("message-plan".into()),
        status: TurnStatus::Completed,
        activities: Vec::new(),
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: Some(state.clone()),
        started_at: "created".into(),
        finished_at: Some("finished".into()),
    };
    let value = serde_json::to_value(&turn).unwrap();
    assert_eq!(value["harness"]["executionPlan"]["status"], "pending");
    assert_eq!(value["harness"]["executionPlan"]["baseRevision"], 2);
    let back: ConversationTurn = serde_json::from_value(value).unwrap();
    assert_eq!(back.harness, Some(state));
}

#[test]
fn execution_turn_with_audit_record_round_trips() {
    let record = HarnessExecutionRecord {
        run_id: "run-exec".into(),
        turn_id: "turn-exec".into(),
        started_at: "start".into(),
        finished_at: Some("finish".into()),
        status: HarnessExecutionStatus::Failed,
        writes: vec![HarnessExecutionWrite {
            node_id: Some(WorkflowNodeId::Goals),
            revision: 3,
            summary: "保存建设目标".into(),
            saved_at: "s".into(),
        }],
        completed_targets: vec![WorkflowNodeId::Goals],
        stopped_target: None,
        stopped_reason: None,
        public_error: Some("模型步骤失败".into()),
    };
    let state = HarnessTurnState {
        proposals: Vec::new(),
        diagnostics: None,
        execution_plan: None,
        execution: Some(record.clone()),
    };
    let value = serde_json::to_value(&state).unwrap();
    assert_eq!(value["execution"]["status"], "failed");
    assert_eq!(value["execution"]["publicError"], "模型步骤失败");
    assert_eq!(
        serde_json::from_value::<HarnessTurnState>(value).unwrap(),
        state
    );
}

#[test]
fn unknown_plan_fields_are_ignored_for_forward_compatibility() {
    let value = serde_json::json!({
        "id": "plan-y",
        "projectId": "project-1",
        "nodeId": "goals",
        "sessionId": "session-1",
        "planTurnId": "turn-1",
        "planMessageId": "message-1",
        "baseRevision": 1,
        "summary": "s",
        "status": "pending",
        "createdAt": "c",
        "expiresAt": "e",
        "futureField": 42
    });
    let plan: HarnessExecutionPlan = serde_json::from_value(value).unwrap();
    assert_eq!(plan.id, "plan-y");
    assert_eq!(plan.status, HarnessPlanStatus::Pending);
}
