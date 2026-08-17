//! Integration contract tests for the Harness domain types.
//!
//! These fixtures pin the serde wire contract that the agent protocol layer,
//! the Tauri tool registry, the storage layer, and the frontend all share.
//! Legacy conversation documents and run kinds must keep loading unchanged
//! while new Harness fields default gracefully.

use sion_core::{
    ConversationTurn, DeliveryOutcome, HarnessDiagnostics, HarnessLimitKind, HarnessModelStepReason,
    HarnessProposal, HarnessProposalKind, HarnessProposalStatus, HarnessToolCall,
    HarnessToolDefinition, HarnessToolStatus, HarnessTurnState, SanitizedToolTrace,
    TurnActivityKind, TurnMessageAuthorization, TurnStatus, WorkflowNodeId,
    authorize_latest_user_message,
};

#[test]
fn tool_contract_uses_stable_wire_names() {
    let definition = HarnessToolDefinition {
        name: "list_dependency_sections".into(),
        description: "列出授权依赖章节".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "nodeId": { "type": "string", "enum": ["goals"] }
            },
            "required": ["nodeId"],
            "additionalProperties": false
        }),
    };
    let value = serde_json::to_value(&definition).unwrap();
    assert_eq!(value["name"], "list_dependency_sections");
    assert_eq!(value["parameters"]["additionalProperties"], false);
    assert_eq!(value["parameters"]["properties"]["nodeId"]["enum"][0], "goals");

    let call = HarnessToolCall {
        id: "call-a".into(),
        name: "read_dependency_section".into(),
        arguments: r#"{"nodeId":"goals","heading":"建设目标"}"#.into(),
    };
    let value = serde_json::to_value(&call).unwrap();
    assert_eq!(value["id"], "call-a");
    assert_eq!(value["name"], "read_dependency_section");
    let back: HarnessToolCall = serde_json::from_value(value).unwrap();
    assert_eq!(back, call);

    let step_reason = serde_json::to_value(HarnessModelStepReason::FinalResponse).unwrap();
    assert_eq!(step_reason, "final_response");
    assert_eq!(
        serde_json::from_value::<HarnessModelStepReason>(
            serde_json::json!("tool_calls")
        )
        .unwrap(),
        HarnessModelStepReason::ToolCalls
    );
}

#[test]
fn sanitized_trace_and_diagnostics_are_bounded_and_defaulted() {
    let trace = SanitizedToolTrace {
        call_id: "call-a".into(),
        name: "read_attachment".into(),
        status: HarnessToolStatus::Completed,
        summary: "已读取附件".into(),
        started_at: "s".into(),
        finished_at: "f".into(),
    };
    let value = serde_json::to_value(&trace).unwrap();
    assert_eq!(value["status"], "completed");
    assert!(!serde_json::to_string(&value).unwrap().contains("raw"));

    let diagnostics = HarnessDiagnostics {
        model_steps: 2,
        tool_calls: 3,
        validation_retries: 1,
        limit_reached: Some(HarnessLimitKind::ModelSteps),
        tool_traces: vec![trace],
    };
    let value = serde_json::to_value(&diagnostics).unwrap();
    assert_eq!(value["modelSteps"], 2);
    assert_eq!(value["limitReached"], "model_steps");
    assert_eq!(value["toolTraces"][0]["summary"], "已读取附件");
    assert_eq!(
        serde_json::from_value::<HarnessDiagnostics>(value).unwrap(),
        diagnostics
    );

    let empty = HarnessDiagnostics::new();
    let value = serde_json::to_value(&empty).unwrap();
    assert!(value.get("limitReached").is_none());
    assert!(value.get("toolTraces").is_none());
}

#[test]
fn proposal_contract_round_trips_delivery_and_agent_rule_kinds() {
    let delivery = HarnessProposal {
        id: "proposal-1".into(),
        kind: HarnessProposalKind::Delivery,
        status: HarnessProposalStatus::Ready,
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::BasicInfo,
        turn_id: "turn-1".into(),
        base_revision: Some(4),
        base_rule_digest: None,
        base_content: "# 项目基本信息\n\n## 基础信息表\n旧".into(),
        proposed_content: "# 项目基本信息\n\n## 基础信息表\n新".into(),
        reason: "用户要求补充".into(),
        validation_summary: Some("校验通过".into()),
        created_at: "now".into(),
        resolved_at: None,
    };
    let value = serde_json::to_value(&delivery).unwrap();
    assert_eq!(value["kind"], "delivery");
    assert_eq!(value["status"], "ready");
    assert_eq!(value["nodeId"], "basic-info");
    assert_eq!(value["baseRevision"], 4);
    assert!(value.get("baseRuleDigest").is_none());
    let back: HarnessProposal = serde_json::from_value(value).unwrap();
    assert_eq!(back, delivery);

    let rule = HarnessProposal {
        id: "proposal-2".into(),
        kind: HarnessProposalKind::AgentRule,
        status: HarnessProposalStatus::Stale,
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        turn_id: "turn-1".into(),
        base_revision: None,
        base_rule_digest: Some("0123456789abcdef".into()),
        base_content: String::new(),
        proposed_content: "只使用确认的目标。".into(),
        reason: "用户要求调整规则".into(),
        validation_summary: None,
        created_at: "now".into(),
        resolved_at: Some("later".into()),
    };
    let value = serde_json::to_value(&rule).unwrap();
    assert_eq!(value["kind"], "agent_rule");
    assert_eq!(value["status"], "stale");
    assert_eq!(value["baseRuleDigest"], "0123456789abcdef");
    assert!(value.get("baseRevision").is_none());
    assert_eq!(value["resolvedAt"], "later");
    let back: HarnessProposal = serde_json::from_value(value).unwrap();
    assert_eq!(back, rule);
}

#[test]
fn legacy_turn_fixture_loads_with_optional_delivery_fields() {
    let legacy = serde_json::json!({
        "id": "turn-legacy",
        "projectId": "project-1",
        "nodeId": "goals",
        "sessionId": "session-1",
        "runId": "run-1",
        "userMessageId": "user-1",
        "assistantMessageId": "assistant-1",
        "status": "completed",
        "activities": [
            {
                "id": "response",
                "kind": "response",
                "status": "completed",
                "label": "Agent 回复完成",
                "startedAt": "s",
                "finishedAt": "f"
            },
            {
                "id": "delivery_save",
                "kind": "delivery_save",
                "status": "completed",
                "label": "保存交付稿",
                "publicSummary": "交付稿已保存",
                "startedAt": "s",
                "finishedAt": "f"
            }
        ],
        "reasoningSummary": null,
        "deliveryOutcome": {
            "kind": "patch_applied",
            "previousRevision": 7,
            "revision": 8,
            "sectionTitles": ["建设目标"]
        },
        "deliveryInspection": {
            "rawResponse": "raw",
            "baseMarkdown": "base",
            "proposedMarkdown": "proposed"
        },
        "startedAt": "2026-07-18T00:00:00Z",
        "finishedAt": "2026-07-18T00:00:01Z"
    });
    let turn: ConversationTurn = serde_json::from_value(legacy).unwrap();
    assert_eq!(turn.id, "turn-legacy");
    assert_eq!(
        turn.delivery_outcome,
        Some(DeliveryOutcome::PatchApplied {
            previous_revision: 7,
            revision: 8,
            section_titles: vec!["建设目标".into()]
        })
    );
    assert!(turn.delivery_inspection.is_some());
    assert_eq!(turn.harness, None);
    assert_eq!(turn.activities[1].kind, TurnActivityKind::DeliverySave);
    let value = serde_json::to_value(&turn).unwrap();
    assert_eq!(value["deliveryOutcome"]["kind"], "patch_applied");
}

#[test]
fn harness_turn_state_defaults_and_round_trips() {
    let state = HarnessTurnState {
        proposals: Vec::new(),
        diagnostics: None,
    };
    let value = serde_json::to_value(&state).unwrap();
    assert!(value.get("proposals").is_none());
    assert!(value.get("diagnostics").is_none());
    let back: HarnessTurnState = serde_json::from_value(value).unwrap();
    assert_eq!(back, state);

    let loaded: HarnessTurnState = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(loaded.proposals.is_empty());
    assert_eq!(loaded.diagnostics, None);
}

#[test]
fn unknown_activity_kind_falls_back_to_other_without_failing_the_document() {
    let activity = serde_json::json!({
        "id": "future-kind",
        "kind": "future_kind",
        "status": "completed",
        "label": "未来的活动"
    });
    let parsed: sion_core::TurnActivity = serde_json::from_value(activity).unwrap();
    assert_eq!(parsed.kind, TurnActivityKind::Other);
}

#[test]
fn turn_message_authorization_covers_chinese_and_english_explicit_cases() {
    assert_eq!(
        authorize_latest_user_message("请整篇重写当前交付稿"),
        TurnMessageAuthorization {
            complete_delivery_rewrite: true,
            agent_rule_proposal: false
        }
    );
    assert_eq!(
        authorize_latest_user_message("Please rewrite the whole document"),
        TurnMessageAuthorization {
            complete_delivery_rewrite: true,
            agent_rule_proposal: false
        }
    );
    assert_eq!(
        authorize_latest_user_message("请修改本节点的 Agent 规则"),
        TurnMessageAuthorization {
            complete_delivery_rewrite: false,
            agent_rule_proposal: true
        }
    );
    assert_eq!(
        authorize_latest_user_message("Update the agent rules please"),
        TurnMessageAuthorization {
            complete_delivery_rewrite: false,
            agent_rule_proposal: true
        }
    );
    assert_eq!(
        authorize_latest_user_message("修改一下交付稿"),
        TurnMessageAuthorization::none()
    );
    assert_eq!(
        authorize_latest_user_message("Rewrite it"),
        TurnMessageAuthorization::none()
    );
}

#[test]
fn new_harness_turn_serializes_without_delivery_outcome() {
    let turn = ConversationTurn {
        id: "turn-harness".into(),
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
        harness: Some(HarnessTurnState {
            proposals: Vec::new(),
            diagnostics: None,
        }),
        started_at: "started".into(),
        finished_at: Some("finished".into()),
    };
    let value = serde_json::to_value(&turn).unwrap();
    assert!(value.get("deliveryOutcome").is_none());
    assert!(value.get("harness").is_some());
    assert!(value["harness"].get("proposals").is_none());
    let back: ConversationTurn = serde_json::from_value(value).unwrap();
    assert_eq!(back.harness, turn.harness);
    assert_eq!(back.delivery_outcome, None);
}

#[test]
fn workflow_node_ids_serialize_kebab_case_inside_proposals() {
    for node in [WorkflowNodeId::BasicInfo, WorkflowNodeId::FinalExport] {
        let proposal = HarnessProposal {
            id: "p".into(),
            kind: HarnessProposalKind::Delivery,
            status: HarnessProposalStatus::Ready,
            project_id: "project-1".into(),
            node_id: node,
            turn_id: "turn-1".into(),
            base_revision: Some(1),
            base_rule_digest: None,
            base_content: String::new(),
            proposed_content: String::new(),
            reason: "r".into(),
            validation_summary: None,
            created_at: "now".into(),
            resolved_at: None,
        };
        let value = serde_json::to_value(&proposal).unwrap();
        assert_eq!(value["nodeId"], node.as_str());
    }
}
