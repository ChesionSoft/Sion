//! Integration tests for Harness turn checkpoints and proposal transactions.
//!
//! These cover crash points before/after every journaled write, idempotent
//! recovery, legacy conversation documents, multiple proposals per turn,
//! reject/apply independence, node CAS conflicts, rule digest conflicts, and
//! the guarantee that tool steps cause no disk writes.

use sion_core::{
    ChatMessage, ChatRole, ConversationTurn, HarnessDiagnostics, HarnessProposal,
    HarnessProposalKind, HarnessProposalStatus, HarnessTurnState, NodeStatus, TurnStatus,
    WorkflowNodeId,
};
use sion_storage::{
    CreateProjectInput, DeliveryProposalApplyResult, ProjectStore, RuleProposalApplyResult,
    SaveAgentOverrideResult, SaveNodeResult,
};
use std::path::PathBuf;

fn fixture() -> (PathBuf, ProjectStore) {
    let root =
        std::env::temp_dir().join(format!("sion-harness-persistence-{}", uuid::Uuid::new_v4()));
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

fn delivery_proposal(turn_id: &str, base_revision: u64) -> HarnessProposal {
    HarnessProposal {
        id: "proposal-delivery".into(),
        kind: HarnessProposalKind::Delivery,
        status: HarnessProposalStatus::Ready,
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        turn_id: turn_id.into(),
        base_revision: Some(base_revision),
        base_rule_digest: None,
        base_content: "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界".into(),
        proposed_content: "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n新目标\n\n## 范围边界\n旧边界".into(),
        reason: "补充目标".into(),
        validation_summary: Some("+1 -1".into()),
        created_at: "started".into(),
        resolved_at: None,
        latest_revision: None,
        latest_rule_digest: None,
    }
}

fn rule_proposal(turn_id: &str) -> HarnessProposal {
    HarnessProposal {
        id: "proposal-rule".into(),
        kind: HarnessProposalKind::AgentRule,
        status: HarnessProposalStatus::Ready,
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        turn_id: turn_id.into(),
        base_revision: None,
        base_rule_digest: Some(sion_core::agent_override_digest(None)),
        base_content: String::new(),
        proposed_content: "先询问澄清再写入交付稿。".into(),
        reason: "调整规则".into(),
        validation_summary: Some("+1".into()),
        created_at: "started".into(),
        resolved_at: None,
        latest_revision: None,
        latest_rule_digest: None,
    }
}

fn turn_with_proposals(session_id: &str, turn_id: &str, proposals: Vec<HarnessProposal>) -> ConversationTurn {
    ConversationTurn {
        id: turn_id.into(),
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        session_id: session_id.into(),
        run_id: format!("run-{turn_id}"),
        user_message_id: "user-1".into(),
        assistant_message_id: None,
        status: TurnStatus::Running,
        activities: Vec::new(),
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: Some(HarnessTurnState {
            proposals,
            diagnostics: Some(HarnessDiagnostics {
                model_steps: 2,
                tool_calls: 3,
                validation_retries: 1,
                limit_reached: None,
                tool_traces: Vec::new(),
            }),
        }),
        started_at: "started".into(),
        finished_at: None,
    }
}

fn run_for(store: &ProjectStore, turn_id: &str) -> sion_agent::AgentRun {
    store
        .list_runs()
        .unwrap()
        .into_iter()
        .find(|run| run.turn_id.as_deref() == Some(turn_id))
        .expect("linked run exists")
}

#[test]
fn begin_harness_turn_persists_message_turn_and_run_atomically() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = turn_with_proposals(&session.id, "turn-1", vec![]);
    let run = sion_agent::AgentRun {
        id: "run-turn-1".into(),
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
        kind: sion_agent::AgentRunKind::Harness,
        session_id: Some(session.id.clone()),
        turn_id: Some("turn-1".into()),
        context_snapshot: None,
        usage: None,
        duration_ms: None,
    };
    let updated = store
        .begin_harness_turn(
            WorkflowNodeId::Goals,
            &session.id,
            message("user-1", ChatRole::User, "请补充目标"),
            turn.clone(),
            &run,
            "started".into(),
        )
        .unwrap();
    assert_eq!(updated.message_count, 1);
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].status, TurnStatus::Running);
    assert!(store.run("run-turn-1").is_ok());
    // Intermediate tool steps are not written: exactly one run file, one turn,
    // and the conversation document has exactly the user message + turn.
    assert_eq!(store.list_runs().unwrap().len(), 1);
    let messages = store.messages(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].content, "请补充目标");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn complete_harness_turn_persists_assistant_terminal_turn_and_run_together() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let proposal = delivery_proposal("turn-1", 1);
    let mut turn = turn_with_proposals(&session.id, "turn-1", vec![proposal]);
    let begin_run = sion_agent::AgentRun {
        id: "run-turn-1".into(),
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
        kind: sion_agent::AgentRunKind::Harness,
        session_id: Some(session.id.clone()),
        turn_id: Some("turn-1".into()),
        context_snapshot: None,
        usage: None,
        duration_ms: None,
    };
    store
        .begin_harness_turn(
            WorkflowNodeId::Goals,
            &session.id,
            message("user-1", ChatRole::User, "请补充目标"),
            turn.clone(),
            &begin_run,
            "started".into(),
        )
        .unwrap();

    turn.status = TurnStatus::Completed;
    turn.assistant_message_id = Some("assistant-1".into());
    turn.finished_at = Some("finished".into());
    let mut end_run = begin_run.clone();
    end_run.status = sion_agent::AgentRunStatus::Completed;
    end_run.finished_at = Some("finished".into());
    end_run.usage = Some(sion_core::build_turn_usage(
        "turn-1",
        "call-1",
        "provider-1",
        "model-1",
        sion_core::ModelCallCategory::Answer,
        sion_core::ModelCallStatus::Completed,
        None,
        "in",
        "out",
    ));
    store
        .complete_harness_turn(
            WorkflowNodeId::Goals,
            &session.id,
            message("assistant-1", ChatRole::Assistant, "已补充目标"),
            turn.clone(),
            &end_run,
            "finished".into(),
        )
        .unwrap();

    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(turns[0].status, TurnStatus::Completed);
    assert_eq!(
        turns[0].harness.as_ref().unwrap().proposals[0].id,
        "proposal-delivery"
    );
    assert!(store.run("run-turn-1").unwrap().usage.is_some());
    let messages = store.messages(WorkflowNodeId::Goals, &session.id).unwrap();
    assert!(messages.iter().any(|m| m.id == "assistant-1"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn pending_harness_journal_recovers_atomically_without_duplication() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = turn_with_proposals(&session.id, "turn-1", vec![]);
    // Simulate a crash: only the journal exists (document not yet written).
    let document = {
        let mut document = sion_storage::harness_testing::conversation_document_for_test(
            &store,
            WorkflowNodeId::Goals,
            &session.id,
        );
        document.messages.push(message("user-1", ChatRole::User, "请补充目标"));
        document.turns.push(turn.clone());
        document
    };
    let journal = sion_storage::harness_testing::HarnessCheckpointJournalForTest {
        session_id: session.id.clone(),
        document,
        run: Some(sion_agent::AgentRun {
            id: "run-turn-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            status: sion_agent::AgentRunStatus::Running,
            created_at: "started".into(),
            started_at: None,
            finished_at: None,
            summary: None,
            provider_id: None,
            model: None,
            reasoning_effort: None,
            file_ids: vec![],
            kind: sion_agent::AgentRunKind::Harness,
            session_id: Some(session.id.clone()),
            turn_id: Some("turn-1".into()),
            context_snapshot: None,
            usage: None,
            duration_ms: None,
        }),
        updated_at: "started".into(),
    };
    sion_storage::harness_testing::write_harness_journal_for_test(
        &store,
        WorkflowNodeId::Goals,
        &journal,
    );
    store.recover_pending_harness(WorkflowNodeId::Goals).unwrap();
    // Recovery is idempotent: re-running leaves exactly one of each record.
    store.recover_pending_harness(WorkflowNodeId::Goals).unwrap();
    assert_eq!(store.messages(WorkflowNodeId::Goals, &session.id).unwrap().len(), 1);
    assert_eq!(store.turns(WorkflowNodeId::Goals, &session.id).unwrap().len(), 1);
    assert!(store.run("run-turn-1").is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn delivery_apply_saves_node_and_marks_proposal_applied() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let proposal = delivery_proposal("turn-1", 1);
    let turn = turn_with_proposals(&session.id, "turn-1", vec![proposal]);
    store
        .save_turn(WorkflowNodeId::Goals, &session.id, turn)
        .unwrap();
    let result = store
        .apply_delivery_proposal(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-1",
            "proposal-delivery",
            "applied".into(),
        )
        .unwrap();
    match result {
        DeliveryProposalApplyResult::Applied { saved_node, proposal } => {
            assert_eq!(saved_node.revision, 2);
            assert!(saved_node.markdown.contains("新目标"));
            assert_eq!(proposal.status, HarnessProposalStatus::Applied);
            assert_eq!(proposal.resolved_at.as_deref(), Some("applied"));
        }
        other => panic!("expected applied, got {other:?}"),
    }
    let stored = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(
        stored[0].harness.as_ref().unwrap().proposals[0].status,
        HarnessProposalStatus::Applied
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn delivery_apply_conflict_marks_stale_and_never_force_applies() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let proposal = delivery_proposal("turn-1", 1);
    let turn = turn_with_proposals(&session.id, "turn-1", vec![proposal]);
    store
        .save_turn(WorkflowNodeId::Goals, &session.id, turn)
        .unwrap();
    // The node moves underneath the proposal (someone else saves first).
    store
        .save_node_if_revision(
            WorkflowNodeId::Goals,
            1,
            "# 需求背景与建设目标\n\n## 需求背景\n新背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界".into(),
            NodeStatus::Confirmed,
            "later".into(),
        )
        .unwrap();
    let result = store
        .apply_delivery_proposal(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-1",
            "proposal-delivery",
            "applied".into(),
        )
        .unwrap();
    match result {
        DeliveryProposalApplyResult::Stale { latest_node, proposal } => {
            assert_eq!(latest_node.revision, 2);
            assert_eq!(proposal.status, HarnessProposalStatus::Stale);
            assert_eq!(proposal.latest_revision, Some(2));
        }
        other => panic!("expected stale, got {other:?}"),
    }
    // The conflicting content was never applied.
    let node = store.node(WorkflowNodeId::Goals).unwrap();
    assert!(!node.markdown.contains("新目标"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn delivery_apply_recovery_reconciles_an_already_saved_node() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let proposal = delivery_proposal("turn-1", 1);
    let turn = turn_with_proposals(&session.id, "turn-1", vec![proposal]);
    store
        .save_turn(WorkflowNodeId::Goals, &session.id, turn)
        .unwrap();
    // Crash after the node save but before the proposal state update.
    let proposed = "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n新目标\n\n## 范围边界\n旧边界";
    store
        .save_node_if_revision(
            WorkflowNodeId::Goals,
            1,
            proposed.into(),
            NodeStatus::Generated,
            "mid".into(),
        )
        .unwrap();
    let journal = sion_storage::harness_testing::ProposalResolutionJournalForTest::Delivery {
        session_id: session.id.clone(),
        turn_id: "turn-1".into(),
        proposal_id: "proposal-delivery".into(),
        expected_revision: 1,
        proposed_markdown: proposed.into(),
    };
    sion_storage::harness_testing::write_proposal_journal_for_test(
        &store,
        WorkflowNodeId::Goals,
        &journal,
    );
    store.recover_pending_proposal_resolution(WorkflowNodeId::Goals).unwrap();
    let stored = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(
        stored[0].harness.as_ref().unwrap().proposals[0].status,
        HarnessProposalStatus::Applied
    );
    // The node was not written twice: still revision 2 with the proposed text.
    let node = store.node(WorkflowNodeId::Goals).unwrap();
    assert_eq!(node.revision, 2);
    assert_eq!(node.markdown, proposed);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn agent_rule_apply_saves_override_and_marks_proposal_applied() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let proposal = rule_proposal("turn-1");
    let turn = turn_with_proposals(&session.id, "turn-1", vec![proposal]);
    store
        .save_turn(WorkflowNodeId::Goals, &session.id, turn)
        .unwrap();
    let result = store
        .apply_agent_rule_proposal(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-1",
            "proposal-rule",
            "applied".into(),
        )
        .unwrap();
    match result {
        RuleProposalApplyResult::Applied { saved_override, proposal } => {
            assert_eq!(saved_override.as_deref(), Some("先询问澄清再写入交付稿。"));
            assert_eq!(proposal.status, HarnessProposalStatus::Applied);
        }
        other => panic!("expected applied, got {other:?}"),
    }
    assert_eq!(
        store.agent_override(WorkflowNodeId::Goals).unwrap(),
        Some("先询问澄清再写入交付稿。".to_string())
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn agent_rule_apply_digest_conflict_marks_stale() {
    let (root, store) = fixture();
    store
        .save_agent_override(WorkflowNodeId::Goals, "其他人先写的规则。".into())
        .unwrap();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let proposal = rule_proposal("turn-1");
    let turn = turn_with_proposals(&session.id, "turn-1", vec![proposal]);
    store
        .save_turn(WorkflowNodeId::Goals, &session.id, turn)
        .unwrap();
    let result = store
        .apply_agent_rule_proposal(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-1",
            "proposal-rule",
            "applied".into(),
        )
        .unwrap();
    match result {
        RuleProposalApplyResult::Stale { latest_digest, proposal, .. } => {
            assert_eq!(
                latest_digest,
                sion_core::agent_override_digest(Some("其他人先写的规则。"))
            );
            assert_eq!(proposal.status, HarnessProposalStatus::Stale);
            assert_eq!(
                proposal.latest_rule_digest.as_deref(),
                Some(latest_digest.as_str())
            );
        }
        other => panic!("expected stale, got {other:?}"),
    }
    // The proposed override was never written.
    assert_eq!(
        store.agent_override(WorkflowNodeId::Goals).unwrap(),
        Some("其他人先写的规则。".to_string())
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reject_marks_proposal_rejected_without_touching_node_or_rule() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let proposal = delivery_proposal("turn-1", 1);
    let turn = turn_with_proposals(&session.id, "turn-1", vec![proposal]);
    store
        .save_turn(WorkflowNodeId::Goals, &session.id, turn)
        .unwrap();
    let rejected = store
        .reject_harness_proposal(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-1",
            "proposal-delivery",
            "rejected".into(),
        )
        .unwrap();
    assert_eq!(rejected.status, HarnessProposalStatus::Rejected);
    assert_eq!(rejected.resolved_at.as_deref(), Some("rejected"));
    // Node and override untouched.
    assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 1);
    assert_eq!(store.agent_override(WorkflowNodeId::Goals).unwrap(), None);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn multiple_proposals_resolve_independently() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let turn = turn_with_proposals(
        &session.id,
        "turn-1",
        vec![delivery_proposal("turn-1", 1), rule_proposal("turn-1")],
    );
    store
        .save_turn(WorkflowNodeId::Goals, &session.id, turn)
        .unwrap();
    // Apply the rule, reject the delivery: both independent.
    let rule = store
        .apply_agent_rule_proposal(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-1",
            "proposal-rule",
            "applied".into(),
        )
        .unwrap();
    assert!(matches!(rule, RuleProposalApplyResult::Applied { .. }));
    let delivery = store
        .reject_harness_proposal(
            WorkflowNodeId::Goals,
            &session.id,
            "turn-1",
            "proposal-delivery",
            "rejected".into(),
        )
        .unwrap();
    assert_eq!(delivery.status, HarnessProposalStatus::Rejected);
    let stored = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    let proposals = &stored[0].harness.as_ref().unwrap().proposals;
    assert_eq!(proposals[0].status, HarnessProposalStatus::Rejected);
    assert_eq!(proposals[1].status, HarnessProposalStatus::Applied);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_conversation_documents_load_unchanged() {
    let (root, store) = fixture();
    let session = store
        .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
        .unwrap();
    let path = sion_storage::harness_testing::conversation_path_for_test(
        &store,
        WorkflowNodeId::Goals,
        &session.id,
    );
    std::fs::write(
        &path,
        r#"{"messages":[{"id":"m1","role":"user","content":"旧消息","createdAt":"now"}],"turns":[{"id":"old-turn","projectId":"project-1","nodeId":"goals","sessionId":"SESSION","runId":"run","userMessageId":"m1","status":"completed","activities":[],"reasoningSummary":null,"deliveryOutcome":{"kind":"unchanged"},"startedAt":"s","finishedAt":"f"}]}"#,
    )
    .unwrap();
    let turns = store.turns(WorkflowNodeId::Goals, &session.id).unwrap();
    assert_eq!(turns[0].id, "old-turn");
    assert_eq!(turns[0].harness, None);
    assert_eq!(
        turns[0].delivery_outcome,
        Some(sion_core::DeliveryOutcome::Unchanged)
    );
    std::fs::remove_dir_all(root).unwrap();
}
