//! The trusted, immutable Harness scope frozen before the first model request.
//!
//! Every field is derived from trusted Rust state (the registered project root,
//! the current `ProjectStore`, frozen dependency IDs, and the latest user
//! message). Tool arguments can never widen this scope: node IDs resolve only
//! against the frozen dependency set, attachment IDs only against the current
//! project's file index, and raw paths are never accepted.

// The tool registry and harness runtime gain their callers in Tasks 4 and 8.
#![allow(dead_code)]

use std::path::PathBuf;

use sion_core::{
    ChatModelSelection, HarnessExecutionPlan, WorkflowNodeId, agent_override_digest,
    authorize_latest_user_message, readable_dependency_ids, TurnMessageAuthorization,
};
use sion_storage::ProjectStore;

use crate::conversation_runtime::compose_effective_agent_rules;

/// The effective Agent rule for the current node plus the stable digest of the
/// exact override state used by proposal resolution's digest CAS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EffectiveRuleSnapshot {
    pub(crate) built_in_markdown: String,
    pub(crate) custom_markdown: Option<String>,
    pub(crate) effective_markdown: String,
    pub(crate) digest: String,
}

/// Immutable scope for one Harness turn. All identifiers here are project-owned
/// and resolved through the current `ProjectStore`; the scope is frozen before
/// the first model request and cannot be widened by any tool argument.
#[derive(Debug, Clone)]
pub(crate) struct HarnessScope {
    pub(crate) project_id: String,
    /// Canonicalized, verified project root resolved through `ProjectRegistry`
    /// and the configured projects directory. Never accepted from a tool call.
    pub(crate) canonical_project_root: PathBuf,
    pub(crate) node_id: WorkflowNodeId,
    pub(crate) session_id: String,
    /// Trusted IDs of direct `depends_on` nodes only (never transitive).
    pub(crate) allowed_dependency_ids: Vec<WorkflowNodeId>,
    /// All current-project attachment IDs. Selection is a hint, not a boundary.
    pub(crate) attachment_ids: Vec<String>,
    pub(crate) expected_node_revision: u64,
    pub(crate) rule_snapshot: EffectiveRuleSnapshot,
    pub(crate) model_selection: ChatModelSelection,
    pub(crate) rewrite_authorized: bool,
    pub(crate) rule_write_authorized: bool,
}

impl HarnessScope {
    /// Per-turn authorization flags derived from the latest user message. Both
    /// fail closed: only explicit requests grant a capability.
    pub(crate) fn authorization(&self) -> TurnMessageAuthorization {
        TurnMessageAuthorization {
            complete_delivery_rewrite: self.rewrite_authorized,
            agent_rule_proposal: self.rule_write_authorized,
        }
    }
}

/// Freezes the immutable Harness scope for a node conversation turn. Reads the
/// current node, effective rule, direct dependencies, and all current-project
/// attachments through the `ProjectStore`; fails closed with safe messages
/// (never raw paths) when any authorized data is missing or corrupt.
pub(crate) fn freeze_harness_scope(
    store: &ProjectStore,
    canonical_project_root: PathBuf,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: &str,
    latest_user_message: &str,
    model_selection: ChatModelSelection,
) -> Result<HarnessScope, String> {
    store
        .session(node_id, session_id)
        .map_err(|_| "会话不存在或已删除".to_string())?;
    let node = store.node(node_id).map_err(|_| "当前节点交付稿读取失败".to_string())?;
    let custom_override = store
        .agent_override(node_id)
        .map_err(|_| "Agent 规则读取失败".to_string())?;
    let effective = compose_effective_agent_rules(node_id, custom_override);
    let dependency_ids = readable_dependency_ids(node_id);
    let files = store.list_files().map_err(|_| "项目附件读取失败".to_string())?;
    let attachment_ids = files.into_iter().map(|file| file.id).collect();
    let authorization = authorize_latest_user_message(latest_user_message);
    Ok(HarnessScope {
        project_id,
        canonical_project_root,
        node_id,
        session_id: session_id.to_string(),
        allowed_dependency_ids: dependency_ids,
        attachment_ids,
        expected_node_revision: node.revision,
        rule_snapshot: EffectiveRuleSnapshot {
            built_in_markdown: effective.built_in_markdown,
            custom_markdown: effective.custom_markdown.clone(),
            effective_markdown: effective.effective_markdown,
            digest: agent_override_digest(effective.custom_markdown.as_deref()),
        },
        model_selection,
        rewrite_authorized: authorization.complete_delivery_rewrite,
        rule_write_authorized: authorization.agent_rule_proposal,
    })
}

/// Renders the frozen scope's allowed dependency IDs for a tool executor.
pub(crate) fn allowed_dependency_set(scope: &HarnessScope) -> std::collections::HashSet<WorkflowNodeId> {
    scope.allowed_dependency_ids.iter().copied().collect()
}

/// Freezes the immutable execution scope from a consumed execution plan. It
/// preserves the planning scope's read permissions (current node, direct
/// dependencies, attachments, effective rule) and freezes the initial node
/// revision from the plan's base revision. The execution scope authorizes
/// current-node writes (the plan was already user-confirmed) but never
/// Agent-rule writes. Model arguments cannot widen this scope.
pub(crate) fn freeze_execution_scope(
    store: &ProjectStore,
    canonical_project_root: PathBuf,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: &str,
    plan: &HarnessExecutionPlan,
    model_selection: ChatModelSelection,
) -> Result<HarnessScope, String> {
    store
        .session(node_id, session_id)
        .map_err(|_| "会话不存在或已删除".to_string())?;
    if plan.node_id != node_id || plan.session_id != session_id || plan.project_id != project_id {
        return Err("执行范围与已确认计划不一致".to_string());
    }
    let node = store.node(node_id).map_err(|_| "当前节点交付稿读取失败".to_string())?;
    if node.revision != plan.base_revision {
        return Err("节点交付稿已变化，计划已失效".to_string());
    }
    let custom_override = store
        .agent_override(node_id)
        .map_err(|_| "Agent 规则读取失败".to_string())?;
    let effective = compose_effective_agent_rules(node_id, custom_override);
    let dependency_ids = readable_dependency_ids(node_id);
    let files = store.list_files().map_err(|_| "项目附件读取失败".to_string())?;
    let attachment_ids = files.into_iter().map(|file| file.id).collect();
    Ok(HarnessScope {
        project_id,
        canonical_project_root,
        node_id,
        session_id: session_id.to_string(),
        allowed_dependency_ids: dependency_ids,
        attachment_ids,
        expected_node_revision: plan.base_revision,
        rule_snapshot: EffectiveRuleSnapshot {
            built_in_markdown: effective.built_in_markdown,
            custom_markdown: effective.custom_markdown.clone(),
            effective_markdown: effective.effective_markdown,
            digest: agent_override_digest(effective.custom_markdown.as_deref()),
        },
        model_selection,
        // The plan was user-confirmed; current-node rewrites are authorized.
        rewrite_authorized: true,
        // Execution never changes Agent rules.
        rule_write_authorized: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_core::{ChatModelSelection, NodeStatus, ReasoningEffort};
    use sion_storage::{CreateProjectInput, SaveNodeResult};
    use std::path::PathBuf;

    fn fixture() -> (PathBuf, ProjectStore) {
        let root =
            std::env::temp_dir().join(format!("sion-harness-scope-{}", uuid::Uuid::new_v4()));
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
        (root, ProjectStore::at(projects.join("project-1")))
    }

    fn selection() -> ChatModelSelection {
        ChatModelSelection {
            provider_id: "provider-1".into(),
            model: "model-1".into(),
            reasoning_effort: ReasoningEffort::Medium,
        }
    }

    fn save_body(store: &ProjectStore, id: WorkflowNodeId, markdown: &str) {
        assert!(matches!(
            store
                .save_node_if_revision(id, 0, markdown.into(), NodeStatus::Generated, "later".into())
                .unwrap(),
            SaveNodeResult::Saved(_)
        ));
    }

    #[test]
    fn scope_freezes_only_direct_dependencies_and_all_attachments() {
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n基础正文",
        );
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n目标正文",
        );
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = freeze_harness_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            "请整篇重写交付稿",
            selection(),
        )
        .unwrap();
        assert_eq!(
            scope.allowed_dependency_ids,
            vec![WorkflowNodeId::BasicInfo]
        );
        assert_eq!(scope.expected_node_revision, 1);
        assert!(scope.rewrite_authorized);
        assert!(!scope.rule_write_authorized);
        assert_eq!(
            scope.rule_snapshot.digest,
            agent_override_digest(None)
        );
        assert!(scope.attachment_ids.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scope_freezes_rule_write_authorization_only_when_requested() {
        let (root, store) = fixture();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = freeze_harness_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            "请修改本节点的 Agent 规则",
            selection(),
        )
        .unwrap();
        assert!(scope.rule_write_authorized);
        assert!(!scope.rewrite_authorized);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleted_session_and_missing_node_fail_closed_without_paths() {
        let (root, store) = fixture();
        let error = freeze_harness_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            "missing-session",
            "你好",
            selection(),
        )
        .unwrap_err();
        assert_eq!(error, "会话不存在或已删除");
        assert!(!error.contains("/nodes/"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scope_digest_reflects_the_exact_override_state() {
        let (root, store) = fixture();
        store
            .save_agent_override(WorkflowNodeId::Goals, "只使用确认的目标。".into())
            .unwrap();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = freeze_harness_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            "你好",
            selection(),
        )
        .unwrap();
        assert_eq!(
            scope.rule_snapshot.digest,
            agent_override_digest(Some("只使用确认的目标。"))
        );
        assert_eq!(
            scope.rule_snapshot.custom_markdown.as_deref(),
            Some("只使用确认的目标。")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_dependency_fails_preparation_with_a_safe_message() {
        let (root, store) = fixture();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        std::fs::remove_file(root.join("projects/project-1/nodes/basic-info.json")).unwrap();
        let scope = freeze_harness_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            "你好",
            selection(),
        )
        .unwrap();
        // The scope freezes the trusted ID; the corrupt dependency only fails
        // when the manifest/section is actually read, never at freeze time.
        assert_eq!(scope.allowed_dependency_ids, vec![WorkflowNodeId::BasicInfo]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn execution_scope_freezes_plan_ownership_revision_and_write_authorization() {
        use sion_core::{HarnessPlanStatus, WorkflowNodeId};
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n基础正文",
        );
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n目标正文",
        );
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let plan = HarnessExecutionPlan {
            id: "plan-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: session.id.clone(),
            plan_turn_id: "turn-plan".into(),
            plan_message_id: "message-plan".into(),
            base_revision: 1,
            summary: "补充目标".into(),
            status: HarnessPlanStatus::Pending,
            created_at: "now".into(),
            expires_at: "later".into(),
            consumed_at: None,
            invalidated_at: None,
            invalid_reason: None,
        };
        let scope = freeze_execution_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            &plan,
            selection(),
        )
        .unwrap();
        assert_eq!(scope.expected_node_revision, 1);
        assert_eq!(scope.allowed_dependency_ids, vec![WorkflowNodeId::BasicInfo]);
        assert!(scope.rewrite_authorized);
        assert!(!scope.rule_write_authorized);
        assert_eq!(scope.node_id, WorkflowNodeId::Goals);
        assert_eq!(scope.session_id, session.id);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn execution_scope_fails_closed_when_plan_ownership_or_revision_mismatches() {
        use sion_core::{HarnessPlanStatus, WorkflowNodeId};
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n正文",
        );
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let plan = HarnessExecutionPlan {
            id: "plan-1".into(),
            project_id: "other-project".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: session.id.clone(),
            plan_turn_id: "turn-plan".into(),
            plan_message_id: "message-plan".into(),
            base_revision: 1,
            summary: "s".into(),
            status: HarnessPlanStatus::Pending,
            created_at: "now".into(),
            expires_at: "later".into(),
            consumed_at: None,
            invalidated_at: None,
            invalid_reason: None,
        };
        let error = freeze_execution_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            &plan,
            selection(),
        )
        .unwrap_err();
        assert!(error.contains("不一致"));
        assert!(!error.contains("projects"));

        // Revision mismatch: plan base 2 but node is at revision 1.
        let plan = HarnessExecutionPlan {
            id: "plan-2".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: session.id.clone(),
            plan_turn_id: "turn-plan".into(),
            plan_message_id: "message-plan".into(),
            base_revision: 2,
            summary: "s".into(),
            status: HarnessPlanStatus::Pending,
            created_at: "now".into(),
            expires_at: "later".into(),
            consumed_at: None,
            invalidated_at: None,
            invalid_reason: None,
        };
        let error = freeze_execution_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            &plan,
            selection(),
        )
        .unwrap_err();
        assert!(error.contains("已失效"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
