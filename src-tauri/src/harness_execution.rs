//! Execution-scoped current-node write tool for a confirmed Harness run.
//!
//! A confirmed execution turn receives exactly one typed write capability:
//! `apply_current_delivery_change`. It reuses the existing delivery
//! patch/rewrite validators and complete-rewrite authorization, then sequences
//! the write through the storage execution-write journal and revision CAS.
//! The service keeps a trusted expected revision and current Markdown snapshot
//! that advance with each successful save, so the shared read registry stays
//! synchronized with the newly saved document. Model-visible responses contain
//! only bounded validation feedback, the saved revision, and safe summaries.

// The execution runtime gains its orchestration caller in Task 4.
#![allow(dead_code)]

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use sion_core::{
    DeliveryProposalChange, HarnessToolDefinition, HarnessToolStatus, resolve_delivery_proposal,
};
use sion_storage::{ExecutionWriteOutcome, ProjectStore};

use crate::harness_scope::HarnessScope;
use crate::harness_tools::ToolError;
use crate::semantic_review::{review_candidate, SemanticReviewRequest};

/// Maximum characters for the model-provided change reason.
const MAX_EXECUTION_REASON_CHARS: usize = 400;

fn tool(
    name: &str,
    description: &str,
    parameters: serde_json::Value,
) -> HarnessToolDefinition {
    HarnessToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        parameters,
    }
}

/// The single execution-write tool definition exposed only to execution runs.
pub(crate) fn execution_tool_definitions() -> Vec<HarnessToolDefinition> {
    vec![tool(
        "apply_current_delivery_change",
        "把确认过的 Markdown 修改直接应用到确认计划中的一个节点。优先提供 nodeId + markdown（模型可自由生成完整 Markdown）；Rust 会先做结构校验、受限差异检查、语义审阅和 revision CAS。旧的 changes patch/rewrite 形状仅为历史单节点计划兼容。不得修改计划之外的节点。",
        serde_json::json!({
            "type": "object",
            "properties": {
                "changes": { "type": "object" },
                "nodeId": { "type": "string" },
                "markdown": { "type": "string", "maxLength": 200000 },
                "reason": { "type": "string", "maxLength": 400 }
            },
            "required": [],
            "additionalProperties": false
        }),
    )]
}

/// Whether a tool name is the sole execution write tool.
pub(crate) fn is_execution_write_tool(name: &str) -> bool {
    name == "apply_current_delivery_change"
}

/// Result of one execution write: the safe content returned to the model and
/// the saved node (when the write landed) so the caller can sync read state.
#[derive(Debug, Clone)]
pub(crate) struct ExecutionToolWrite {
    pub(crate) status: HarnessToolStatus,
    pub(crate) content: String,
    pub(crate) summary: String,
    /// Set when the write atomically saved; carries the new node revision.
    pub(crate) saved_revision: Option<u64>,
    pub(crate) node_id: Option<sion_core::WorkflowNodeId>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictExecutionChangeArgs {
    #[serde(default)]
    node_id: Option<sion_core::WorkflowNodeId>,
    #[serde(default)]
    changes: Option<StrictExecutionChange>,
    #[serde(default)]
    markdown: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// Parses the sole execution-write payload without accepting schema extensions
/// that could introduce another target or an unvalidated change shape.
fn parse_execution_change(
    args: &str,
) -> Result<(Option<sion_core::WorkflowNodeId>, DeliveryProposalChange, String), ToolError> {
    let payload: StrictExecutionChangeArgs = serde_json::from_str(args)
        .map_err(|_| ToolError::InvalidArguments("参数必须符合执行写入格式".to_string()))?;
    let reason = payload.reason.unwrap_or_default().trim().to_string();
    if reason.chars().count() > MAX_EXECUTION_REASON_CHARS {
        return Err(ToolError::InvalidArguments("reason 过长".to_string()));
    }
    let change = match (payload.changes, payload.markdown) {
        (Some(_), Some(_)) | (None, None) => {
            return Err(ToolError::InvalidArguments(
                "必须且只能提供 markdown 或 changes".to_string(),
            ));
        }
        (Some(changes), None) => changes.into(),
        (None, Some(markdown)) => {
            if markdown.trim().is_empty() {
                return Err(ToolError::InvalidArguments("markdown 不能为空".to_string()));
            }
            DeliveryProposalChange::Rewrite { markdown }
        }
    };
    Ok((payload.node_id, change, reason))
}

/// Strict mirror of `DeliveryProposalChange` that rejects unknown fields at
/// every level, so the model can never smuggle a second target or an arbitrary
/// payload into the execution write.
#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum StrictExecutionChange {
    Patch { sections: Vec<StrictExecutionSection> },
    Rewrite { markdown: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictExecutionSection {
    title: String,
    content: String,
}

impl From<StrictExecutionChange> for DeliveryProposalChange {
    fn from(change: StrictExecutionChange) -> Self {
        match change {
            StrictExecutionChange::Patch { sections } => DeliveryProposalChange::Patch {
                sections: sections
                    .into_iter()
                    .map(|section| sion_core::AgentDeliverySection {
                        title: section.title,
                        content: section.content,
                    })
                    .collect(),
            },
            StrictExecutionChange::Rewrite { markdown } => {
                DeliveryProposalChange::Rewrite { markdown }
            }
        }
    }
}

/// Per-run execution-write service frozen against the execution scope. It
/// tracks the trusted expected revision and current Markdown, and persists each
/// validated change through the storage journal/CAS.
pub(crate) struct HarnessExecutionService<'a> {
    scope: &'a HarnessScope,
    store: &'a ProjectStore,
    plan_id: String,
    turn_id: String,
    plan_summary: String,
    targets: HashMap<sion_core::WorkflowNodeId, TargetExecutionState>,
    target_order: Vec<sion_core::WorkflowNodeId>,
    completed_targets: HashSet<sion_core::WorkflowNodeId>,
    stopped_target: Option<sion_core::WorkflowNodeId>,
    stopped_reason: Option<String>,
    validation_retries: u32,
}

struct TargetExecutionState {
    expected_revision: u64,
    current_markdown: String,
}

impl<'a> HarnessExecutionService<'a> {
    pub(crate) fn new(
        scope: &'a HarnessScope,
        store: &'a ProjectStore,
        plan_id: String,
        turn_id: String,
    ) -> Result<Self, String> {
        Self::new_with_summary(scope, store, plan_id, turn_id, String::new())
    }

    pub(crate) fn new_with_summary(
        scope: &'a HarnessScope,
        store: &'a ProjectStore,
        plan_id: String,
        turn_id: String,
        plan_summary: String,
    ) -> Result<Self, String> {
        let mut targets = HashMap::new();
        let mut target_order = Vec::new();
        for target in &scope.target_scopes {
            let node = store
                .node(target.node_id)
                .map_err(|_| "计划目标节点交付稿读取失败".to_string())?;
            if node.revision != target.expected_revision {
                return Err("计划目标节点已变化，执行已停止".to_string());
            }
            targets.insert(
                target.node_id,
                TargetExecutionState {
                    expected_revision: target.expected_revision,
                    current_markdown: node.markdown,
                },
            );
            target_order.push(target.node_id);
        }
        if targets.is_empty() {
            let node = store
                .node(scope.node_id)
                .map_err(|_| "当前节点交付稿读取失败".to_string())?;
            targets.insert(
                scope.node_id,
                TargetExecutionState {
                    expected_revision: node.revision,
                    current_markdown: node.markdown,
                },
            );
            target_order.push(scope.node_id);
        }
        Ok(Self {
            scope,
            store,
            plan_id,
            turn_id,
            plan_summary,
            targets,
            target_order,
            completed_targets: HashSet::new(),
            stopped_target: None,
            stopped_reason: None,
            validation_retries: 0,
        })
    }

    /// The current trusted revision (advanced after each successful write).
    pub(crate) fn expected_revision(&self) -> u64 {
        self.targets
            .get(&self.scope.node_id)
            .map(|state| state.expected_revision)
            .unwrap_or_default()
    }

    /// The current trusted Markdown snapshot (advanced after each write).
    pub(crate) fn current_markdown(&self) -> &str {
        self.targets
            .get(&self.scope.node_id)
            .map(|state| state.current_markdown.as_str())
            .unwrap_or("")
    }

    pub(crate) fn validation_retries(&self) -> u32 {
        self.validation_retries
    }

    pub(crate) fn completed_targets(&self) -> Vec<sion_core::WorkflowNodeId> {
        self.target_order
            .iter()
            .copied()
            .filter(|node_id| self.completed_targets.contains(node_id))
            .collect()
    }

    pub(crate) fn stopped_target(&self) -> Option<sion_core::WorkflowNodeId> {
        self.stopped_target
    }

    pub(crate) fn stopped_reason(&self) -> Option<String> {
        self.stopped_reason.clone()
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.completed_targets.len() == self.target_order.len()
    }

    /// Validates one execution-write call (schema + patch shape) without
    /// executing it, so the whole provider batch can be refused up front.
    pub(crate) fn validate(&self, call: &sion_core::HarnessToolCall) -> Result<(), ToolError> {
        if !is_execution_write_tool(&call.name) {
            return Err(ToolError::InvalidArguments(format!(
                "未知执行工具：{}",
                call.name
            )));
        }
        let (node_id, _, _) = parse_execution_change(&call.arguments)?;
        if self.target_order.len() > 1 && node_id.is_none() {
            return Err(ToolError::InvalidArguments(
                "多节点执行必须显式提供 nodeId".to_string(),
            ));
        }
        Ok(())
    }

    /// Applies one confirmed current-node change. Reuses the delivery
    /// patch/rewrite validators; rejects empty patches, malformed changes,
    /// unauthorized rewrites, stale revisions, and any second target. Returns
    /// only bounded, redacted feedback to the model.
    pub(crate) fn apply(&mut self, args: &str, now: &str) -> Result<ExecutionToolWrite, ToolError> {
        let (requested_node, change, reason) = parse_execution_change(args)?;
        if self.stopped_reason.is_some() {
            return Err(ToolError::Unauthorized(
                "执行已停止，不能继续修改其他节点".to_string(),
            ));
        }
        if self.target_order.len() > 1 && requested_node.is_none() {
            return Err(ToolError::InvalidArguments(
                "多节点执行必须显式提供 nodeId".to_string(),
            ));
        }
        let node_id = requested_node.unwrap_or(self.scope.node_id);
        let expected_target = self
            .target_order
            .iter()
            .copied()
            .find(|target| !self.completed_targets.contains(target));
        let single_target_follow_up = self.target_order.len() == 1
            && self.completed_targets.contains(&node_id);
        if expected_target != Some(node_id) && !single_target_follow_up {
            return Err(ToolError::Unauthorized(
                "必须按已确认计划中的目标顺序逐节点修改".to_string(),
            ));
        }
        let state = self.targets.get(&node_id).ok_or_else(|| {
            ToolError::Unauthorized("该节点不在已确认执行计划中".to_string())
        })?;
        let proposed = match resolve_delivery_proposal(
            &change,
            node_id,
            &state.current_markdown,
            // The plan was user-confirmed; current-node rewrites are authorized.
            true,
        ) {
            Ok(markdown) => markdown,
            Err(error) => {
                self.validation_retries += 1;
                return Ok(ExecutionToolWrite {
                    status: HarnessToolStatus::Error,
                    content: format!("校验未通过，未保存：{error}"),
                    summary: "执行写入校验失败".to_string(),
                    saved_revision: None,
                    node_id: Some(node_id),
                });
            }
        };
        let review = review_candidate(&SemanticReviewRequest {
            summary: self.plan_summary.clone(),
            node_id,
            original_markdown: state.current_markdown.clone(),
            candidate_markdown: proposed.clone(),
            saved_target_summaries: Vec::new(),
        });
        if review.verdict != sion_core::SemanticReviewVerdict::Pass {
            self.validation_retries += 1;
            let feedback = review
                .missing_requirements
                .iter()
                .chain(review.out_of_plan_content.iter())
                .chain(review.cross_node_conflicts.iter())
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
                .join("；");
            if self.validation_retries >= crate::harness_proposals::MAX_VALIDATION_RETRIES {
                self.stopped_target = Some(node_id);
                self.stopped_reason = Some("语义审阅重试次数已用尽".to_string());
            }
            return Ok(ExecutionToolWrite {
                status: HarnessToolStatus::Error,
                content: format!("语义审阅未通过，未保存：{}", if feedback.is_empty() { "请按确认计划修正候选文稿" } else { &feedback }),
                summary: "语义审阅要求修正".to_string(),
                saved_revision: None,
                node_id: Some(node_id),
            });
        }
        let summary = if reason.is_empty() {
            "应用确认的修改".to_string()
        } else {
            format!("保存：{reason}")
        };
        let result = self.store.apply_execution_write_for_owner(
            node_id,
            self.scope.node_id,
            &self.scope.session_id,
            &self.turn_id,
            &self.plan_id,
            state.expected_revision,
            proposed,
            summary,
            now.to_string(),
        );
        match result {
            Ok(ExecutionWriteOutcome::Saved { node, write }) => {
                if let Some(state) = self.targets.get_mut(&node_id) {
                    state.expected_revision = node.revision;
                    state.current_markdown = node.markdown.clone();
                }
                self.completed_targets.insert(node_id);
                Ok(ExecutionToolWrite {
                    status: HarnessToolStatus::Completed,
                    content: format!(
                        "已保存：{}\n新的 revision = {}",
                        write.summary, write.revision
                    ),
                    summary: write.summary,
                    saved_revision: Some(node.revision),
                    node_id: Some(node_id),
                })
            }
            Ok(ExecutionWriteOutcome::Conflict {
                expected_revision,
                actual_revision,
            }) => {
                self.stopped_target = Some(node_id);
                self.stopped_reason = Some("节点 revision 冲突".to_string());
                Ok(ExecutionToolWrite {
                    status: HarnessToolStatus::Error,
                    content: format!(
                        "保存冲突：节点已变化（期望 revision {expected_revision}，当前 {actual_revision}）。未写入任何内容，请停止修改。"
                    ),
                    summary: "执行写入冲突".to_string(),
                    saved_revision: None,
                    node_id: Some(node_id),
                })
            }
            Ok(ExecutionWriteOutcome::ValidationFailed { public_error }) => {
                self.validation_retries += 1;
                if self.validation_retries >= crate::harness_proposals::MAX_VALIDATION_RETRIES {
                    self.stopped_target = Some(node_id);
                    self.stopped_reason = Some("文稿校验重试次数已用尽".to_string());
                }
                Ok(ExecutionToolWrite {
                    status: HarnessToolStatus::Error,
                    content: format!("校验未通过，未保存：{public_error}"),
                    summary: "执行写入校验失败".to_string(),
                    saved_revision: None,
                    node_id: Some(node_id),
                })
            }
            Err(error) => {
                self.stopped_target = Some(node_id);
                self.stopped_reason = Some("本地保存失败".to_string());
                Ok(ExecutionToolWrite {
                    status: HarnessToolStatus::Error,
                    content: format!("保存失败，未写入：{}", public_storage_error(&error)),
                    summary: "执行写入失败".to_string(),
                    saved_revision: None,
                    node_id: Some(node_id),
                })
            }
        }
    }
}

fn public_storage_error(error: &sion_storage::StorageError) -> String {
    // Never leak paths or internal details; map to a safe public label.
    match error {
        sion_storage::StorageError::NodeUnavailable
        | sion_storage::StorageError::SessionNotFound(_) => "本地状态不可用".to_string(),
        _ => "本地保存失败".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_core::{
        ChatModelSelection, HarnessExecutionPlan, HarnessPlanStatus, NodeStatus, ReasoningEffort,
        WorkflowNodeId,
    };
    use sion_storage::{CreateProjectInput, SaveNodeResult};
    use std::path::PathBuf;

    const GOALS: &str =
        "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界";

    fn fixture() -> (PathBuf, ProjectStore) {
        let root =
            std::env::temp_dir().join(format!("sion-harness-execution-{}", uuid::Uuid::new_v4()));
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
                    GOALS.into(),
                    NodeStatus::Generated,
                    "now".into(),
                )
                .unwrap(),
            SaveNodeResult::Saved(_)
        ));
        (root, store)
    }

    fn execution_scope(store: &ProjectStore, root: &PathBuf, session_id: &str) -> HarnessScope {
        let plan = HarnessExecutionPlan {
            id: "plan-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: session_id.into(),
            plan_turn_id: "turn-plan".into(),
            plan_message_id: "message-plan".into(),
            base_revision: 1,
            targets: Vec::new(),
            summary: "补充建设目标".into(),
            status: HarnessPlanStatus::Consumed,
            created_at: "now".into(),
            expires_at: "later".into(),
            consumed_at: Some("consumed".into()),
            invalidated_at: None,
            invalid_reason: None,
        };
        crate::harness_scope::freeze_execution_scope(
            store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            session_id,
            &plan,
            ChatModelSelection {
                provider_id: "provider-1".into(),
                model: "model-1".into(),
                reasoning_effort: ReasoningEffort::Medium,
            },
        )
        .unwrap()
    }

    #[test]
    fn direct_patch_write_saves_and_advances_revision() {
        let (root, store) = fixture();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = execution_scope(&store, &root, &session.id);
        let mut service = HarnessExecutionService::new(&scope, &store, "plan-1".into(), "turn-exec".into())
            .unwrap();
        assert_eq!(service.expected_revision(), 1);
        let write = service
            .apply(
                r#"{"changes":{"mode":"patch","sections":[{"title":"建设目标","content":"新目标"}]},"reason":"补充建设目标"}"#,
                "now",
            )
            .unwrap();
        assert_eq!(write.status, HarnessToolStatus::Completed);
        assert_eq!(write.saved_revision, Some(2));
        assert_eq!(service.expected_revision(), 2);
        assert!(service.current_markdown().contains("新目标"));
        assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 2);
        // A second sequential write advances again.
        let write = service
            .apply(
                r#"{"changes":{"mode":"patch","sections":[{"title":"范围边界","content":"新边界"}]}}"#,
                "now",
            )
            .unwrap();
        assert_eq!(write.saved_revision, Some(3));
        assert_eq!(service.expected_revision(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rewrite_is_authorized_after_confirmation() {
        let (root, store) = fixture();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = execution_scope(&store, &root, &session.id);
        let mut service = HarnessExecutionService::new(&scope, &store, "plan-1".into(), "turn-exec".into())
            .unwrap();
        let full = "# 需求背景与建设目标\n\n## 需求背景\n全部新背景\n\n## 建设目标\n全部新目标\n\n## 范围边界\n全部新边界";
        let write = service
            .apply(
                &format!(
                    r#"{{"changes":{{"mode":"rewrite","markdown":{}}}}}"#,
                    serde_json::to_string(full).unwrap()
                ),
                "now",
            )
            .unwrap();
        assert_eq!(write.status, HarnessToolStatus::Completed);
        assert_eq!(write.saved_revision, Some(2));
        assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn multi_target_execution_writes_in_order_and_rejects_returning_to_saved_target() {
        let (root, store) = fixture();
        let basic_info = store.node(WorkflowNodeId::BasicInfo).unwrap();
        store
            .save_node_if_revision(
                WorkflowNodeId::BasicInfo,
                basic_info.revision,
                basic_info.markdown,
                NodeStatus::Generated,
                "now".into(),
            )
            .unwrap();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let execution_plan = HarnessExecutionPlan {
            id: "plan-multi".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: session.id.clone(),
            plan_turn_id: "turn-plan".into(),
            plan_message_id: "message-plan".into(),
            base_revision: 1,
            targets: vec![
                sion_core::HarnessExecutionTarget {
                    node_id: WorkflowNodeId::Goals,
                    base_revision: 1,
                    display_name: None,
                },
                sion_core::HarnessExecutionTarget {
                    node_id: WorkflowNodeId::BasicInfo,
                    base_revision: 1,
                    display_name: None,
                },
            ],
            summary: "补充建设目标".into(),
            status: HarnessPlanStatus::Consumed,
            created_at: "now".into(),
            expires_at: "later".into(),
            consumed_at: Some("now".into()),
            invalidated_at: None,
            invalid_reason: None,
        };
        let scope = crate::harness_scope::freeze_execution_scope(
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            &execution_plan,
            ChatModelSelection {
                provider_id: "provider-1".into(),
                model: "model-1".into(),
                reasoning_effort: ReasoningEffort::Medium,
            },
        )
        .unwrap();
        let mut service = HarnessExecutionService::new_with_summary(
            &scope,
            &store,
            execution_plan.id.clone(),
            "turn-exec".into(),
            execution_plan.summary.clone(),
        )
        .unwrap();
        let first = service
            .apply(
                r#"{"nodeId":"goals","changes":{"mode":"patch","sections":[{"title":"建设目标","content":"新目标"}]}}"#,
                "now",
            )
            .unwrap();
        assert_eq!(first.status, HarnessToolStatus::Completed);
        let duplicate = service.apply(
            r#"{"nodeId":"goals","changes":{"mode":"patch","sections":[{"title":"建设目标","content":"重复写入"}]}}"#,
            "now",
        );
        assert!(matches!(duplicate, Err(ToolError::Unauthorized(_))));
        let basic_markdown = store.node(WorkflowNodeId::BasicInfo).unwrap().markdown;
        let second = service
            .apply(
                &format!(
                    r#"{{"nodeId":"basic-info","markdown":{}}}"#,
                    serde_json::to_string(&basic_markdown).unwrap()
                ),
                "now",
            )
            .unwrap();
        assert_eq!(second.status, HarnessToolStatus::Completed);
        assert_eq!(
            service.completed_targets(),
            vec![WorkflowNodeId::Goals, WorkflowNodeId::BasicInfo]
        );
        assert!(service.is_complete());
        let back = service.apply(
            r#"{"nodeId":"goals","changes":{"mode":"patch","sections":[{"title":"建设目标","content":"回头写"}]}}"#,
            "now",
        );
        assert!(matches!(back, Err(ToolError::Unauthorized(_))));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manual_cas_conflict_blocks_the_write_without_overwriting() {
        let (root, store) = fixture();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = execution_scope(&store, &root, &session.id);
        let mut service = HarnessExecutionService::new(&scope, &store, "plan-1".into(), "turn-exec".into())
            .unwrap();
        // External manual save bumps revision 1 -> 2.
        store
            .save_node_if_revision(
                WorkflowNodeId::Goals,
                1,
                "# 需求背景与建设目标\n\n## 需求背景\n外部背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界".into(),
                NodeStatus::Generated,
                "manual".into(),
            )
            .unwrap();
        let write = service
            .apply(
                r#"{"changes":{"mode":"patch","sections":[{"title":"建设目标","content":"新目标"}]}}"#,
                "now",
            )
            .unwrap();
        assert_eq!(write.status, HarnessToolStatus::Error);
        assert!(write.content.contains("冲突"));
        assert!(write.saved_revision.is_none());
        assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn execution_service_rejects_target_changed_after_scope_freeze() {
        let (root, store) = fixture();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = execution_scope(&store, &root, &session.id);
        let current = store.node(WorkflowNodeId::Goals).unwrap();
        store
            .save_node_if_revision(
                WorkflowNodeId::Goals,
                current.revision,
                current.markdown,
                NodeStatus::Generated,
                "external".into(),
            )
            .unwrap();
        let error = match HarnessExecutionService::new(&scope, &store, "plan-1".into(), "turn-exec".into()) {
            Ok(_) => panic!("changed execution target must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error, "计划目标节点已变化，执行已停止");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_patch_and_malformed_changes_are_rejected() {
        let (root, store) = fixture();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = execution_scope(&store, &root, &session.id);
        let mut service = HarnessExecutionService::new(&scope, &store, "plan-1".into(), "turn-exec".into())
            .unwrap();
        // Empty patches and malformed payloads are refused before any write.
        let empty = service
            .apply(r#"{"changes":{"mode":"patch","sections":[]}}"#, "now")
            .unwrap();
        assert_eq!(empty.status, HarnessToolStatus::Error);
        for args in [
            r#"{"changes":123}"#,
            r#"{"changes":{"mode":"patch","sections":[{"title":"建设目标","content":"新"}],"extra":1}}"#,
            r#"not json"#,
        ] {
            let error = service.apply(args, "now").unwrap_err();
            assert!(!format!("{error:?}").contains("secret"));
        }
        // A patch targeting an unsupported section fails validation gracefully.
        let invalid = service
            .apply(
                r#"{"changes":{"mode":"patch","sections":[{"title":"不存在","content":"x"}]}}"#,
                "now",
            )
            .unwrap();
        assert_eq!(invalid.status, HarnessToolStatus::Error);
        assert!(invalid.saved_revision.is_none());
        assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn execution_write_tool_is_the_only_write_route() {
        assert!(is_execution_write_tool("apply_current_delivery_change"));
        assert!(!is_execution_write_tool("read_current_delivery"));
        assert!(!is_execution_write_tool("propose_agent_rule_override"));
        assert!(!is_execution_write_tool("propose_delivery_change"));
        let definitions = execution_tool_definitions();
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].name, "apply_current_delivery_change");
        assert_eq!(definitions[0].parameters["additionalProperties"], false);
    }
}
