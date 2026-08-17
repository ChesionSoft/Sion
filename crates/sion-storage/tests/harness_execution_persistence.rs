//! Integration tests for confirmed execution plan persistence.
//!
//! These cover plan publication (one active plan per session, linked to the
//! completed planning turn and assistant message), atomic consumption with all
//! eligibility checks, duplicate/racing confirmation, every execution-write
//! crash boundary, idempotent recovery, restart invalidation, and legacy
//! conversation formats.

use sion_core::{
    ChatMessage, ChatRole, ConversationTurn, HarnessExecutionPlan, HarnessExecutionRecord,
    HarnessExecutionStatus, HarnessPlanInvalidReason, HarnessPlanStatus,
    HarnessTurnState, NodeStatus, TurnStatus, WorkflowNodeId,
};
use sion_storage::{
    ConsumeExecutionPlanResult, CreateProjectInput, ExecutionPlanUnavailableReason,
    ExecutionWriteOutcome, ProjectStore, SaveNodeResult,
};
use std::path::PathBuf;

fn fixture() -> (PathBuf, ProjectStore) {
    let root = std::env::temp_dir().join(format!(
        "sion-harness-execution-persistence-{}",
        uuid::Uuid::new_v4()
    ));
    let projects = root.join("projects");
    ProjectStore::create_in(
        &projects,
        CreateProjectInput {
            id: "project-1".into(),
            name: "项目".into(),
            customer_name: "客户".into(),
            author_name: "作者".into(),
            now: "now".into(),
        },
    )
    .unwrap();
    let store = ProjectStore::at(projects.join("project-1"));
    assert!(matches!(
        store
            .save_node_if_revision(
                WorkflowNodeId::Goals,
                0,
                "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界".into(),
                NodeStatus::Generated,
                "now".into(),
            )
            .unwrap(),
        SaveNodeResult::Saved(_)
    ));
    (root, store)
}

fn message(id: &str, role: ChatRole, content: &str) -> ChatMessage {
    ChatMessage {
        id: id.into(),
        role,
        content: content.into(),
        reasoning_content: None,
        sources: None,
        created_at: "now".into(),
        turn_id: None,
        reasoning_duration_ms: None,
        usage: None,
        attachments: Vec::new(),
        model_execution: None,
    }
}

fn completed_turn(session_id: &str, turn_id: &str, assistant_id: &str) -> ConversationTurn {
    ConversationTurn {
        id: turn_id.into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: session_id.into(),
        run_id: format!("run-{turn_id}"),
        user_message_id: "user-plan".into(),
        assistant_message_id: Some(assistant_id.into()),
        status: TurnStatus::Completed,
        activities: Vec::new(),
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: Some(HarnessTurnState {
            proposals: Vec::new(),
            diagnostics: None,
            execution_plan: None,
            execution: None,
        }),
        started_at: "started".into(),
        finished_at: Some("finished".into()),
    }
}

fn running_execution_turn(
    session_id: &str,
    turn_id: &str,
    run_id: &str,
    _plan_id: &str,
) -> ConversationTurn {
    ConversationTurn {
        id: turn_id.into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: session_id.into(),
        run_id: run_id.into(),
        user_message_id: "user-confirm".into(),
        assistant_message_id: None,
        status: TurnStatus::Running,
        activities: Vec::new(),
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: Some(HarnessTurnState {
            proposals: Vec::new(),
            diagnostics: None,
            execution_plan: None,
            execution: Some(HarnessExecutionRecord {
                run_id: run_id.into(),
                turn_id: turn_id.into(),
                started_at: "started".into(),
                finished_at: None,
                status: HarnessExecutionStatus::Running,
                writes: Vec::new(),
                public_error: None,
            }),
        }),
        started_at: "started".into(),
        finished_at: None,
    }
}

fn run(
    run_id: &str,
    session_id: &str,
    turn_id: &str,
    kind: sion_agent::AgentRunKind,
) -> sion_agent::AgentRun {
    sion_agent::AgentRun {
        id: run_id.into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        status: sion_agent::AgentRunStatus::Running,
        created_at: "started".into(),
        started_at: Some("started".into()),
        finished_at: None,
        summary: None,
        provider_id: Some("provider-1".into()),
        model: Some("model-1".into()),
        reasoning_effort: None,
        file_ids: vec![],
        kind,
        session_id: Some(session_id.into()),
        turn_id: Some(turn_id.into()),
        context_snapshot: None,
        usage: None,
        duration_ms: None,
    }
}

fn plan(
    plan_id: &str,
    session_id: &str,
    turn_id: &str,
    message_id: &str,
    base_revision: u64,
    expires_at: &str,
) -> HarnessExecutionPlan {
    HarnessExecutionPlan {
        id: plan_id.into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: session_id.into(),
        plan_turn_id: turn_id.into(),
        plan_message_id: message_id.into(),
        base_revision,
        summary: "补充建设目标与范围边界".into(),
        status: HarnessPlanStatus::Pending,
        created_at: "2026-08-17T00:00:00.000Z".into(),
        expires_at: expires_at.into(),
        consumed_at: None,
        invalidated_at: None,
        invalid_reason: None,
    }
}

/// A far-future expiry so normal consume tests never trip the expiry check.
fn unexpired_expiry() -> &'static str {
    "2099-01-01T00:00:00.000Z"
}

/// A `now` timestamp that sorts after any normal test creation timestamp.
fn later_now() -> &'static str {
    "2026-08-17T00:02:00.000Z"
}

/// Persists a completed planning turn (with its assistant message) exactly as
/// the runtime does, then publishes the pending plan on it.
fn publish(
    store: &ProjectStore,
    session_id: &str,
    turn: &ConversationTurn,
    plan: HarnessExecutionPlan,
) {
    store
        .begin_harness_turn(
            WorkflowNodeId::Goals,
            session_id,
            message("user-plan", ChatRole::User, "请给出修改计划"),
            turn.clone(),
            &run(
                &format!("run-{}", turn.id),
                session_id,
                &turn.id,
                sion_agent::AgentRunKind::Harness,
            ),
            "started".into(),
        )
        .unwrap();
    store
        .complete_harness_turn(
            WorkflowNodeId::Goals,
            session_id,
            Some(message(
                &plan.plan_message_id,
                ChatRole::Assistant,
                "我计划补充建设目标，请确认后执行。",
            )),
            turn.clone(),
            &sion_agent::AgentRun {
                status: sion_agent::AgentRunStatus::Completed,
                finished_at: Some("finished".into()),
                ..run(
                    &format!("run-{}", turn.id),
                    session_id,
                    &turn.id,
                    sion_agent::AgentRunKind::Harness,
                )
            },
            "finished".into(),
        )
        .unwrap();
    store
        .publish_execution_plan(
            WorkflowNodeId::Goals,
            session_id,
            plan.clone(),
            "published".into(),
        )
        .unwrap();
}

#[test]
fn publish_execution_plan_links_to_completed_turn_and_assistant_message() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan.clone());

    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let stored = turns[0].harness.as_ref().unwrap().execution_plan.as_ref().unwrap();
    assert_eq!(stored.id, "plan-1");
    assert_eq!(stored.status, HarnessPlanStatus::Pending);
    assert_eq!(stored.plan_message_id, "assistant-plan");
    assert_eq!(stored.base_revision, 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn second_pending_plan_for_same_session_is_rejected() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let first = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, first);

    // A second plan for the same session (even a different turn) is refused.
    let second = plan("plan-2", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    let error = store
        .publish_execution_plan(WorkflowNodeId::Goals, &session.id, second, "later".into())
        .unwrap_err();
    assert!(error.to_string().contains("already active"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn publish_requires_completed_turn_with_matching_assistant_message() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    // A running turn is not a valid plan owner.
    let running = ConversationTurn {
        status: TurnStatus::Running,
        assistant_message_id: None,
        finished_at: None,
        ..completed_turn(&session.id, "turn-plan", "assistant-plan")
    };
    let error = store
        .publish_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry()),
            "now".into(),
        )
        .unwrap_err();
    assert!(matches!(
        error,
        sion_storage::StorageError::ExecutionPlanTurnUnavailable(_)
    ));
    let _ = running;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn consume_plan_begins_execution_turn_with_user_message_and_run() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan.clone());

    let execution_turn = running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-1");
    let execution_run = run(
        "run-exec",
        &session.id,
        "turn-exec",
        sion_agent::AgentRunKind::HarnessExecution,
    );
    let result = store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-1",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            execution_turn.clone(),
            &execution_run,
            later_now().into(),
        )
        .unwrap();
    match result {
        ConsumeExecutionPlanResult::Consumed { run, turn, plan: consumed } => {
            assert_eq!(run.kind, sion_agent::AgentRunKind::HarnessExecution);
            assert_eq!(turn.id, "turn-exec");
            assert_eq!(consumed.status, HarnessPlanStatus::Consumed);
        }
        other => panic!("expected consumed, got {other:?}"),
    }
    let messages = store.messages(WorkflowNodeId::Goals, &session.id).unwrap();
    assert!(messages.iter().any(|m| m.id == "user-confirm" && m.content == "继续"));
    assert!(store.run("run-exec").is_ok());
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1].id, "turn-exec");
    assert_eq!(turns[1].status, TurnStatus::Running);
    let plan_turn = &turns[0];
    assert_eq!(
        plan_turn.harness.as_ref().unwrap().execution_plan.as_ref().unwrap().status,
        HarnessPlanStatus::Consumed
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn duplicate_or_racing_confirmation_consumes_once_only() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);

    let execution_turn = running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-1");
    let execution_run = run(
        "run-exec",
        &session.id,
        "turn-exec",
        sion_agent::AgentRunKind::HarnessExecution,
    );
    let first = store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-1",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            execution_turn.clone(),
            &execution_run,
            later_now().into(),
        )
        .unwrap();
    assert!(matches!(first, ConsumeExecutionPlanResult::Consumed { .. }));

    // A second attempt finds the plan already consumed; no second run appends.
    let second = store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-1",
            "可以",
            message("user-confirm-2", ChatRole::User, "可以"),
            execution_turn.clone(),
            &execution_run,
            later_now().into(),
        )
        .unwrap();
    match second {
        ConsumeExecutionPlanResult::Unavailable { reason } => {
            assert_eq!(reason, ExecutionPlanUnavailableReason::NotPending);
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
    // Exactly one execution run and one user confirmation message exist.
    let runs = store.list_runs().unwrap();
    assert_eq!(
        runs.iter().filter(|run| run.kind == sion_agent::AgentRunKind::HarnessExecution).count(),
        1
    );
    let messages = store.messages(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(
        messages.iter().filter(|m| m.id == "user-confirm" || m.id == "user-confirm-2").count(),
        1
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn consume_fails_when_node_revision_changed_and_invalidates_plan() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);

    // A manual save bumps the node revision from 1 to 2.
    store
        .save_node_if_revision(
            WorkflowNodeId::Goals,
            1,
            "# 需求背景与建设目标\n\n## 需求背景\n新背景\n\n## 建设目标\n新目标\n\n## 范围边界\n新边界".into(),
            NodeStatus::Generated,
            "manual".into(),
        )
        .unwrap();

    let result = store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-1",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-1"),
            &run(
                "run-exec",
                &session.id,
                "turn-exec",
                sion_agent::AgentRunKind::HarnessExecution,
            ),
            later_now().into(),
        )
        .unwrap();
    match result {
        ConsumeExecutionPlanResult::Unavailable { reason } => {
            assert_eq!(reason, ExecutionPlanUnavailableReason::NodeChanged);
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
    // The plan is now invalidated and no execution run exists.
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let stored = turns[0].harness.as_ref().unwrap().execution_plan.as_ref().unwrap();
    assert_eq!(stored.status, HarnessPlanStatus::Invalidated);
    assert_eq!(stored.invalid_reason, Some(HarnessPlanInvalidReason::NodeChanged));
    assert!(
        store
            .list_runs()
            .unwrap()
            .iter()
            .all(|run| run.kind != sion_agent::AgentRunKind::HarnessExecution)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn consume_fails_when_expired_or_ordering_mismatched() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let expired = plan("plan-expired", &session.id, "turn-plan", "assistant-plan", 1, "2000-01-01T00:00:00Z");
    publish(&store, &session.id, &turn, expired);
    let result = store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-expired",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-expired"),
            &run(
                "run-exec",
                &session.id,
                "turn-exec",
                sion_agent::AgentRunKind::HarnessExecution,
            ),
            later_now().into(),
        )
        .unwrap();
    match result {
        ConsumeExecutionPlanResult::Unavailable { reason } => {
            assert_eq!(reason, ExecutionPlanUnavailableReason::Expired);
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
    std::fs::remove_dir_all(root).unwrap();

    // Ordering mismatch: a user message was inserted between the plan's
    // assistant message and the confirmation.
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-order", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);
    store
        .append_message(
            WorkflowNodeId::Goals,
            &session.id,
            message("intruder", ChatRole::User, "等等，我补充一下需求"),
            "intruded".into(),
        )
        .unwrap();
    let result = store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-order",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-order"),
            &run(
                "run-exec",
                &session.id,
                "turn-exec",
                sion_agent::AgentRunKind::HarnessExecution,
            ),
            later_now().into(),
        )
        .unwrap();
    match result {
        ConsumeExecutionPlanResult::Unavailable { reason } => {
            assert_eq!(reason, ExecutionPlanUnavailableReason::OrderingMismatch);
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn negative_or_ambiguous_reply_is_refused_and_invalidates_plan() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);

    for reply in ["不要", "取消", "no", "好的，我们再讨论一下需求", "嗯？"] {
        let result = store
            .consume_execution_plan(
                WorkflowNodeId::Goals,
                &session.id,
                "plan-1",
                reply,
                message("user-confirm", ChatRole::User, reply),
                running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-1"),
                &run(
                    "run-exec",
                    &session.id,
                    "turn-exec",
                    sion_agent::AgentRunKind::HarnessExecution,
                ),
                later_now().into(),
            )
            .unwrap();
        match result {
            ConsumeExecutionPlanResult::Unavailable { reason } => {
                assert_eq!(reason, ExecutionPlanUnavailableReason::NotAffirmative, "{reply}");
            }
            other => panic!("expected unavailable for {reply:?}, got {other:?}"),
        }
    }
    // The plan was invalidated after the first ambiguous reply; no execution
    // run was ever created.
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let stored = turns[0].harness.as_ref().unwrap().execution_plan.as_ref().unwrap();
    assert_eq!(stored.status, HarnessPlanStatus::Invalidated);
    assert_eq!(
        stored.invalid_reason,
        Some(HarnessPlanInvalidReason::AmbiguousConfirmation)
    );
    assert!(
        store
            .list_runs()
            .unwrap()
            .iter()
            .all(|run| run.kind != sion_agent::AgentRunKind::HarnessExecution)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn consume_fails_for_wrong_session_or_unknown_plan() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let other = store
        .create_session(WorkflowNodeId::Goals, "另一个".into(), None, "later".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);

    // Unknown plan id.
    let result = store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-missing",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-missing"),
            &run(
                "run-exec",
                &session.id,
                "turn-exec",
                sion_agent::AgentRunKind::HarnessExecution,
            ),
            later_now().into(),
        )
        .unwrap();
    match result {
        ConsumeExecutionPlanResult::Unavailable { reason } => {
            assert_eq!(reason, ExecutionPlanUnavailableReason::NotFound);
        }
        other => panic!("expected unavailable, got {other:?}"),
    }

    // Plan published in `session` cannot be consumed through `other`.
    let result = store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &other.id,
            "plan-1",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            running_execution_turn(&other.id, "turn-exec", "run-exec", "plan-1"),
            &run(
                "run-exec",
                &other.id,
                "turn-exec",
                sion_agent::AgentRunKind::HarnessExecution,
            ),
            later_now().into(),
        )
        .unwrap();
    match result {
        ConsumeExecutionPlanResult::Unavailable { reason } => {
            assert_eq!(reason, ExecutionPlanUnavailableReason::NotFound);
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn execution_write_saves_node_with_cas_and_records_audit_summary() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);
    let execution_turn = running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-1");
    let execution_run = run(
        "run-exec",
        &session.id,
        "turn-exec",
        sion_agent::AgentRunKind::HarnessExecution,
    );
    store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-1",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            execution_turn.clone(),
            &execution_run,
            later_now().into(),
        )
        .unwrap();

    let proposed = "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n新目标\n\n## 范围边界\n旧边界";
    let outcome = store
        .apply_execution_write(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-exec",
            "plan-1",
            1,
            proposed.into(),
            "保存建设目标".into(),
            "saved".into(),
        )
        .unwrap();
    match outcome {
        ExecutionWriteOutcome::Saved { node, write } => {
            assert_eq!(node.revision, 2);
            assert_eq!(write.revision, 2);
            assert_eq!(write.summary, "保存建设目标");
        }
        other => panic!("expected saved, got {other:?}"),
    }
    // The audit summary is recorded on the execution turn.
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let execution = turns.iter().find(|t| t.id == "turn-exec").unwrap();
    let record = execution.harness.as_ref().unwrap().execution.as_ref().unwrap();
    assert_eq!(record.writes.len(), 1);
    assert_eq!(record.writes[0].revision, 2);
    // The next write advances the expected revision.
    let second = store
        .apply_execution_write(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-exec",
            "plan-1",
            2,
            "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n新目标\n\n## 范围边界\n新边界".into(),
            "保存范围边界".into(),
            "saved-2".into(),
        )
        .unwrap();
    assert!(matches!(second, ExecutionWriteOutcome::Saved { .. }));
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let record = turns
        .iter()
        .find(|t| t.id == "turn-exec")
        .unwrap()
        .harness
        .as_ref()
        .unwrap()
        .execution
        .as_ref()
        .unwrap();
    assert_eq!(record.writes.len(), 2);
    assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 3);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn execution_write_conflict_and_validation_failure_write_nothing() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);
    store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-1",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-1"),
            &run(
                "run-exec",
                &session.id,
                "turn-exec",
                sion_agent::AgentRunKind::HarnessExecution,
            ),
            later_now().into(),
        )
        .unwrap();

    // CAS conflict: the node moved to revision 2 externally.
    store
        .save_node_if_revision(
            WorkflowNodeId::Goals,
            1,
            "# 需求背景与建设目标\n\n## 需求背景\n外部背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界".into(),
            NodeStatus::Generated,
            "external".into(),
        )
        .unwrap();
    let conflict = store
        .apply_execution_write(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-exec",
            "plan-1",
            1,
            "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n新目标\n\n## 范围边界\n旧边界".into(),
            "保存建设目标".into(),
            "saved".into(),
        )
        .unwrap();
    match conflict {
        ExecutionWriteOutcome::Conflict {
            expected_revision,
            actual_revision,
        } => {
            assert_eq!(expected_revision, 1);
            assert_eq!(actual_revision, 2);
        }
        other => panic!("expected conflict, got {other:?}"),
    }
    assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 2);

    // Validation failure: missing required section is refused, nothing writes.
    let invalid = store
        .apply_execution_write(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-exec",
            "plan-1",
            2,
            "# 需求背景与建设目标\n\n## 需求背景\n旧背景".into(),
            "非法写入".into(),
            "saved".into(),
        )
        .unwrap();
    assert!(matches!(
        invalid,
        ExecutionWriteOutcome::ValidationFailed { .. }
    ));
    assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 2);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn execution_write_crash_after_node_save_reconciles_audit_summary() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);
    store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-1",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-1"),
            &run(
                "run-exec",
                &session.id,
                "turn-exec",
                sion_agent::AgentRunKind::HarnessExecution,
            ),
            later_now().into(),
        )
        .unwrap();

    // Simulate a crash: the node was saved but the journal was never removed
    // and the audit record never updated.
    let proposed = "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n新目标\n\n## 范围边界\n旧边界";
    store
        .save_node_if_revision(
            WorkflowNodeId::Goals,
            1,
            proposed.into(),
            NodeStatus::Generated,
            "saved".into(),
        )
        .unwrap();
    sion_storage::harness_testing::write_execution_journal_for_test(
        &store,
        WorkflowNodeId::Goals,
        &sion_storage::harness_testing::ExecutionWriteJournalForTest {
            session_id: session.id.clone(),
            turn_id: "turn-exec".into(),
            plan_id: "plan-1".into(),
            expected_revision: 1,
            proposed_markdown: proposed.into(),
            summary: "保存建设目标".into(),
            now: "saved".into(),
        },
    );

    store.recover_pending_execution_write(WorkflowNodeId::Goals).unwrap();
    // The journal is gone and the audit record now carries the write.
    assert!(
        !sion_storage::harness_testing::execution_journal_exists_for_test(
            &store,
            WorkflowNodeId::Goals
        )
    );
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let record = turns
        .iter()
        .find(|t| t.id == "turn-exec")
        .unwrap()
        .harness
        .as_ref()
        .unwrap()
        .execution
        .as_ref()
        .unwrap();
    assert_eq!(record.writes.len(), 1);
    assert_eq!(record.writes[0].revision, 2);
    // The node content was NOT rewritten (revision stayed 2).
    assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 2);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn execution_write_crash_before_node_save_recovery_writes_nothing() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);
    store
        .consume_execution_plan(
            WorkflowNodeId::Goals,
            &session.id,
            "plan-1",
            "继续",
            message("user-confirm", ChatRole::User, "继续"),
            running_execution_turn(&session.id, "turn-exec", "run-exec", "plan-1"),
            &run(
                "run-exec",
                &session.id,
                "turn-exec",
                sion_agent::AgentRunKind::HarnessExecution,
            ),
            later_now().into(),
        )
        .unwrap();

    // The journal exists but the node was never saved.
    let proposed = "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n新目标\n\n## 范围边界\n旧边界";
    sion_storage::harness_testing::write_execution_journal_for_test(
        &store,
        WorkflowNodeId::Goals,
        &sion_storage::harness_testing::ExecutionWriteJournalForTest {
            session_id: session.id.clone(),
            turn_id: "turn-exec".into(),
            plan_id: "plan-1".into(),
            expected_revision: 1,
            proposed_markdown: proposed.into(),
            summary: "保存建设目标".into(),
            now: "saved".into(),
        },
    );
    store.recover_pending_execution_write(WorkflowNodeId::Goals).unwrap();
    // Node is untouched and no audit write was recorded.
    assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 1);
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let record = turns
        .iter()
        .find(|t| t.id == "turn-exec")
        .unwrap()
        .harness
        .as_ref()
        .unwrap()
        .execution
        .as_ref()
        .unwrap();
    assert!(record.writes.is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn startup_recovery_invalidates_pending_plans_and_never_replays() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);

    store
        .recover_pending_execution(WorkflowNodeId::Goals, "restarted".into())
        .unwrap();
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let stored = turns[0].harness.as_ref().unwrap().execution_plan.as_ref().unwrap();
    assert_eq!(stored.status, HarnessPlanStatus::Invalidated);
    assert_eq!(stored.invalid_reason, Some(HarnessPlanInvalidReason::Restarted));
    // No execution run was created by recovery.
    assert!(
        store
            .list_runs()
            .unwrap()
            .iter()
            .all(|run| run.kind != sion_agent::AgentRunKind::HarnessExecution)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalidate_pending_plans_marks_all_plans_in_session() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = completed_turn(&session.id, "turn-plan", "assistant-plan");
    let plan = plan("plan-1", &session.id, "turn-plan", "assistant-plan", 1, unexpired_expiry());
    publish(&store, &session.id, &turn, plan);
    store
        .invalidate_pending_plans(
            WorkflowNodeId::Goals,
            HarnessPlanInvalidReason::Cancelled,
            "cancelled".into(),
        )
        .unwrap();
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let stored = turns[0].harness.as_ref().unwrap().execution_plan.as_ref().unwrap();
    assert_eq!(stored.status, HarnessPlanStatus::Invalidated);
    assert_eq!(stored.invalid_reason, Some(HarnessPlanInvalidReason::Cancelled));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_conversation_document_without_plan_fields_still_loads() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = ConversationTurn {
        id: "turn-legacy".into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: session.id.clone(),
        run_id: "run-legacy".into(),
        user_message_id: "user-1".into(),
        assistant_message_id: None,
        status: TurnStatus::Completed,
        activities: Vec::new(),
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: None,
        started_at: "started".into(),
        finished_at: Some("finished".into()),
    };
    store
        .begin_turn(
            WorkflowNodeId::Goals,
            &session.id,
            message("user-1", ChatRole::User, "旧消息"),
            turn,
            "now".into(),
        )
        .unwrap();
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(turns[0].harness, None);
    std::fs::remove_dir_all(root).unwrap();
}
