use sion_core::{
    HarnessExecutionPlan, HarnessExecutionTarget, HarnessPlanStatus, SemanticReviewResult,
    SemanticReviewVerdict, WorkflowNodeId,
};

fn legacy_plan() -> HarnessExecutionPlan {
    HarnessExecutionPlan {
        id: "legacy".into(),
        project_id: "project".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: "session".into(),
        plan_turn_id: "turn".into(),
        plan_message_id: "message".into(),
        base_revision: 4,
        targets: Vec::new(),
        summary: "补充目标".into(),
        status: HarnessPlanStatus::Pending,
        created_at: "now".into(),
        expires_at: "later".into(),
        consumed_at: None,
        invalidated_at: None,
        invalid_reason: None,
    }
}

#[test]
fn legacy_plan_normalizes_to_owner_target() {
    let plan = legacy_plan();
    assert_eq!(plan.normalized_targets().len(), 1);
    assert_eq!(plan.normalized_targets()[0].node_id, WorkflowNodeId::Goals);
    assert_eq!(plan.normalized_targets()[0].base_revision, 4);
    assert!(plan.validate_targets().is_ok());
}

#[test]
fn multi_node_plan_rejects_duplicate_targets_and_round_trips() {
    let mut plan = legacy_plan();
    plan.targets = vec![
        HarnessExecutionTarget {
            node_id: WorkflowNodeId::Goals,
            base_revision: 4,
            display_name: None,
        },
        HarnessExecutionTarget {
            node_id: WorkflowNodeId::BusinessFlow,
            base_revision: 2,
            display_name: Some("业务流程".into()),
        },
    ];
    assert!(plan.validate_targets().is_ok());
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(json["targets"].as_array().unwrap().len(), 2);
    assert_eq!(serde_json::from_value::<HarnessExecutionPlan>(json).unwrap(), plan);

    plan.targets.push(HarnessExecutionTarget {
        node_id: WorkflowNodeId::Goals,
        base_revision: 4,
        display_name: None,
    });
    assert_eq!(plan.validate_targets(), Err("execution plan contains duplicate targets"));
}

#[test]
fn semantic_review_is_finite_and_never_contains_replacement_markdown() {
    let result = SemanticReviewResult {
        verdict: SemanticReviewVerdict::Revise,
        missing_requirements: vec!["补充验收条件".into()],
        out_of_plan_content: Vec::new(),
        cross_node_conflicts: vec!["目标与流程不一致".into()],
        reason: Some("需要补充后再保存".into()),
    };
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(serialized.contains("revise"));
    assert!(!serialized.contains("# "));
    assert!(!serialized.contains("markdown"));
}
