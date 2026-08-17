//! Validated delivery and Agent-rule proposal services.
//!
//! Proposal tools create deterministic, reviewable candidates without ever
//! persisting the delivery or Agent override. Tool execution cannot call
//! `save_node_if_revision` or `save_agent_override_if_digest`; only user-approved
//! proposal resolution may persist document content. Candidates stay in memory
//! during the active loop and become durable `HarnessProposal` records only for
//! valid ready proposals or explicit discards needed for audit.

// The harness runtime gains its orchestration callers in Tasks 7 and 8.
#![allow(dead_code)]

use std::collections::HashMap;

use serde::Deserialize;
use sion_core::{
    DeliveryProposalChange, DeliveryProposalError, HarnessProposal, HarnessProposalKind,
    HarnessProposalStatus, HarnessToolCall, HarnessToolDefinition, HarnessToolStatus,
    WorkflowNode, document_diff_summary, resolve_delivery_proposal, validate_agent_rule_override,
};
use sion_storage::ProjectStore;

use crate::harness_scope::HarnessScope;
use crate::harness_tools::{ToolError, ToolExecution, validate_tool_arguments};

/// Maximum lines in a proposal diff summary returned to the model.
const MAX_DIFF_SUMMARY_LINES: usize = 40;
/// Maximum length of a proposal reason sent by the model.
const MAX_REASON_CHARS: usize = 400;

/// The maximum automatic validation retries per proposal lineage.
pub(crate) const MAX_VALIDATION_RETRIES: u32 = 2;

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

fn delivery_propose_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "changes": { "type": "object" },
            "reason": { "type": "string", "maxLength": 400 }
        },
        "required": ["changes"],
        "additionalProperties": false
    })
}

fn delivery_revise_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "proposalId": { "type": "string", "maxLength": 64 },
            "changes": { "type": "object" },
            "reason": { "type": "string", "maxLength": 400 }
        },
        "required": ["proposalId", "changes"],
        "additionalProperties": false
    })
}

fn delivery_discard_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": { "proposalId": { "type": "string", "maxLength": 64 } },
        "required": ["proposalId"],
        "additionalProperties": false
    })
}

fn rule_propose_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "markdown": { "type": "string", "maxLength": 4000 },
            "reason": { "type": "string", "maxLength": 400 }
        },
        "required": ["markdown"],
        "additionalProperties": false
    })
}

fn rule_revise_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "proposalId": { "type": "string", "maxLength": 64 },
            "markdown": { "type": "string", "maxLength": 4000 },
            "reason": { "type": "string", "maxLength": 400 }
        },
        "required": ["proposalId", "markdown"],
        "additionalProperties": false
    })
}

fn rule_discard_schema() -> serde_json::Value {
    delivery_discard_schema()
}

/// Proposal tool definitions. Delivery tools are always advertised; Agent-rule
/// tools appear only when the frozen turn authorization grants rule writes.
pub(crate) fn proposal_definitions(rule_authorized: bool) -> Vec<HarnessToolDefinition> {
    let mut definitions = vec![
        tool(
            "propose_delivery_change",
            "当讨论得出明确、值得写入当前交付稿的结论时，创建交付补丁提案。changes.mode 为 patch 时按现有章节补丁；为 rewrite 时整篇重写（仅在用户明确要求时可用）。工具不会保存交付稿；创建的是待你审阅的提案。",
            delivery_propose_schema(),
        ),
        tool(
            "revise_delivery_proposal",
            "按 proposalId 修改一个已创建的交付提案的 changes 与 reason。",
            delivery_revise_schema(),
        ),
        tool(
            "discard_delivery_proposal",
            "按 proposalId 放弃一个交付提案，不再提交审阅。",
            delivery_discard_schema(),
        ),
    ];
    if rule_authorized {
        definitions.push(tool(
            "propose_agent_rule_override",
            "创建当前节点 Agent 规则的项目覆盖提案（仅当用户明确要求修改规则时可用）。该规则只影响当前节点未来的对话，不能声称修改内置规则、安全策略、工具、浏览器/网络/文件系统访问或 provider 配置。",
            rule_propose_schema(),
        ));
        definitions.push(tool(
            "revise_agent_rule_proposal",
            "按 proposalId 修改 Agent 规则覆盖提案的 markdown 与 reason。",
            rule_revise_schema(),
        ));
        definitions.push(tool(
            "discard_agent_rule_proposal",
            "按 proposalId 放弃一个 Agent 规则覆盖提案。",
            rule_discard_schema(),
        ));
    }
    definitions
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateStatus {
    Ready,
    Discarded,
}

#[derive(Debug, Clone)]
struct ProposalCandidate {
    id: String,
    kind: HarnessProposalKind,
    base_content: String,
    proposed_content: String,
    reason: String,
    validation_summary: String,
    status: CandidateStatus,
}

/// Per-turn in-memory proposal service. `&mut self` methods enforce one active
/// delivery candidate and one active Agent-rule candidate per turn, plus the
/// validation-retry budget.
pub(crate) struct ProposalService<'a> {
    scope: &'a HarnessScope,
    store: &'a ProjectStore,
    node: WorkflowNode,
    candidates: HashMap<String, ProposalCandidate>,
    delivery_retries: u32,
    rule_retries: u32,
}

impl<'a> ProposalService<'a> {
    pub(crate) fn new(scope: &'a HarnessScope, store: &'a ProjectStore) -> Result<Self, String> {
        let node = store
            .node(scope.node_id)
            .map_err(|_| "当前节点交付稿读取失败".to_string())?;
        Ok(Self {
            scope,
            store,
            node,
            candidates: HashMap::new(),
            delivery_retries: 0,
            rule_retries: 0,
        })
    }

    /// Executes one proposal tool call. Rule tools fail closed when the frozen
    /// turn authorization does not grant rule writes.
    pub(crate) fn execute(&mut self, call: &HarnessToolCall) -> ToolExecution {
        let result = match call.name.as_str() {
            "propose_delivery_change" => self.propose_delivery(&call.arguments),
            "revise_delivery_proposal" => self.revise_delivery(&call.arguments),
            "discard_delivery_proposal" => self.discard_delivery(&call.arguments),
            "propose_agent_rule_override" => self.propose_rule(&call.arguments),
            "revise_agent_rule_proposal" => self.revise_rule(&call.arguments),
            "discard_agent_rule_proposal" => self.discard_rule(&call.arguments),
            other => Err(ToolError::InvalidArguments(format!("未知提案工具：{other}"))),
        };
        match result {
            Ok(execution) => execution,
            Err(error) => error.into_execution(),
        }
    }

    fn propose_delivery(&mut self, args: &str) -> Result<ToolExecution, ToolError> {
        let arguments =
            validate_tool_arguments(&tool_by_name("propose_delivery_change"), args)?;
        let payload: DeliveryProposeArgs = serde_json::from_value(arguments)
            .map_err(|error| ToolError::InvalidArguments(format!("changes 结构无效：{error}")))?;
        let reason = payload.reason.unwrap_or_default();
        if reason.chars().count() > MAX_REASON_CHARS {
            return Err(ToolError::InvalidArguments("reason 过长".to_string()));
        }
        if self.active_delivery_id().is_some() {
            return Err(ToolError::InvalidArguments(
                "已有待处理的交付提案，请用 revise_delivery_proposal 修改或先 discard".to_string(),
            ));
        }
        match resolve_delivery_proposal(
            &payload.changes,
            self.scope.node_id,
            &self.node.markdown,
            self.scope.rewrite_authorized,
        ) {
            Ok(proposed) => {
                self.insert_delivery_candidate(&payload.changes, proposed, reason);
                Ok(self.ready_execution("delivery"))
            }
            Err(error) => self.delivery_validation_failure(error),
        }
    }

    fn revise_delivery(&mut self, args: &str) -> Result<ToolExecution, ToolError> {
        if self.delivery_retries > MAX_VALIDATION_RETRIES {
            return Err(self.retry_budget_exceeded());
        }
        let arguments =
            validate_tool_arguments(&tool_by_name("revise_delivery_proposal"), args)?;
        let payload: DeliveryReviseArgs = serde_json::from_value(arguments)
            .map_err(|error| ToolError::InvalidArguments(format!("changes 结构无效：{error}")))?;
        let reason = payload.reason.unwrap_or_default();
        if reason.chars().count() > MAX_REASON_CHARS {
            return Err(ToolError::InvalidArguments("reason 过长".to_string()));
        }
        let node_id = self.scope.node_id;
        let node_markdown = self.node.markdown.clone();
        let rewrite_authorized = self.scope.rewrite_authorized;
        let proposal_id = payload.proposal_id.clone();
        let resolved = {
            let candidate = self.mutable_delivery(&proposal_id)?;
            match resolve_delivery_proposal(
                &payload.changes,
                node_id,
                &node_markdown,
                rewrite_authorized,
            ) {
                Ok(proposed) => {
                    candidate.base_content = node_markdown;
                    candidate.proposed_content = proposed;
                    candidate.reason = reason;
                    candidate.validation_summary = document_diff_summary(
                        &candidate.base_content,
                        &candidate.proposed_content,
                        MAX_DIFF_SUMMARY_LINES,
                    );
                    candidate.status = CandidateStatus::Ready;
                    Ok(())
                }
                Err(error) => Err(error),
            }
        };
        match resolved {
            Ok(()) => {
                self.delivery_retries = 0;
                Ok(self.ready_execution("delivery"))
            }
            Err(error) => self.delivery_validation_failure(error),
        }
    }

    fn discard_delivery(&mut self, args: &str) -> Result<ToolExecution, ToolError> {
        let arguments =
            validate_tool_arguments(&tool_by_name("discard_delivery_proposal"), args)?;
        let payload: DiscardArgs = serde_json::from_value(arguments)
            .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
        let candidate = self.mutable_delivery(&payload.proposal_id)?;
        candidate.status = CandidateStatus::Discarded;
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!("已放弃交付提案 {}", candidate.id),
            summary: "已放弃交付提案".to_string(),
        })
    }

    fn propose_rule(&mut self, args: &str) -> Result<ToolExecution, ToolError> {
        self.require_rule_authorized()?;
        let arguments =
            validate_tool_arguments(&tool_by_name("propose_agent_rule_override"), args)?;
        let payload: RuleProposeArgs = serde_json::from_value(arguments)
            .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
        let reason = payload.reason.unwrap_or_default();
        if reason.chars().count() > MAX_REASON_CHARS {
            return Err(ToolError::InvalidArguments("reason 过长".to_string()));
        }
        if self.active_rule_id().is_some() {
            return Err(ToolError::InvalidArguments(
                "已有待处理的规则提案，请用 revise_agent_rule_proposal 修改或先 discard".to_string(),
            ));
        }
        match self.validate_rule_text(&payload.markdown) {
            Ok(markdown) => {
                self.insert_rule_candidate(markdown, reason);
                Ok(self.ready_execution("agent_rule"))
            }
            Err(message) => self.rule_validation_failure(message),
        }
    }

    fn revise_rule(&mut self, args: &str) -> Result<ToolExecution, ToolError> {
        self.require_rule_authorized()?;
        if self.rule_retries > MAX_VALIDATION_RETRIES {
            return Err(self.retry_budget_exceeded());
        }
        let arguments =
            validate_tool_arguments(&tool_by_name("revise_agent_rule_proposal"), args)?;
        let payload: RuleReviseArgs = serde_json::from_value(arguments)
            .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
        let reason = payload.reason.unwrap_or_default();
        if reason.chars().count() > MAX_REASON_CHARS {
            return Err(ToolError::InvalidArguments("reason 过长".to_string()));
        }
        let proposal_id = payload.proposal_id.clone();
        let base_content = self
            .scope
            .rule_snapshot
            .custom_markdown
            .clone()
            .unwrap_or_default();
        let validation = self.validate_rule_text(&payload.markdown);
        let resolved = {
            let candidate = self.mutable_rule(&proposal_id)?;
            match validation {
                Ok(markdown) => {
                    candidate.proposed_content = markdown;
                    candidate.base_content = base_content;
                    candidate.reason = reason;
                    candidate.validation_summary = document_diff_summary(
                        &candidate.base_content,
                        &candidate.proposed_content,
                        MAX_DIFF_SUMMARY_LINES,
                    );
                    candidate.status = CandidateStatus::Ready;
                    Ok(())
                }
                Err(message) => Err(message),
            }
        };
        match resolved {
            Ok(()) => {
                self.rule_retries = 0;
                Ok(self.ready_execution("agent_rule"))
            }
            Err(message) => self.rule_validation_failure(message),
        }
    }

    fn discard_rule(&mut self, args: &str) -> Result<ToolExecution, ToolError> {
        self.require_rule_authorized()?;
        let arguments =
            validate_tool_arguments(&tool_by_name("discard_agent_rule_proposal"), args)?;
        let payload: DiscardArgs = serde_json::from_value(arguments)
            .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
        let candidate = self.mutable_rule(&payload.proposal_id)?;
        candidate.status = CandidateStatus::Discarded;
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!("已放弃规则提案 {}", candidate.id),
            summary: "已放弃规则提案".to_string(),
        })
    }

    /// Builds the durable proposal records for the terminal checkpoint: ready
    /// candidates keep `Ready`; explicitly discarded candidates are recorded as
    /// `Rejected` for audit.
    pub(crate) fn durable_proposals(&self, now: &str) -> Vec<HarnessProposal> {
        let mut proposals = Vec::new();
        for candidate in self.candidates.values() {
            let (status, resolved_at) = match candidate.status {
                CandidateStatus::Ready => (HarnessProposalStatus::Ready, None),
                CandidateStatus::Discarded => {
                    (HarnessProposalStatus::Rejected, Some(now.to_string()))
                }
            };
            let (base_revision, base_rule_digest) = match candidate.kind {
                HarnessProposalKind::Delivery => {
                    (Some(self.scope.expected_node_revision), None)
                }
                HarnessProposalKind::AgentRule => {
                    (None, Some(self.scope.rule_snapshot.digest.clone()))
                }
            };
            proposals.push(HarnessProposal {
                id: candidate.id.clone(),
                kind: candidate.kind,
                status,
                project_id: self.scope.project_id.clone(),
                node_id: self.scope.node_id,
                turn_id: String::new(),
                base_revision,
                base_rule_digest,
                base_content: candidate.base_content.clone(),
                proposed_content: candidate.proposed_content.clone(),
                reason: candidate.reason.clone(),
                validation_summary: Some(candidate.validation_summary.clone()),
                created_at: now.to_string(),
                resolved_at,
            });
        }
        proposals
    }

    fn insert_delivery_candidate(&mut self, _change: &DeliveryProposalChange, proposed: String, reason: String) {
        let id = format!("delivery-{}", uuid::Uuid::new_v4());
        let candidate = ProposalCandidate {
            id: id.clone(),
            kind: HarnessProposalKind::Delivery,
            base_content: self.node.markdown.clone(),
            proposed_content: proposed,
            reason,
            validation_summary: String::new(),
            status: CandidateStatus::Ready,
        };
        let summary = document_diff_summary(
            &candidate.base_content,
            &candidate.proposed_content,
            MAX_DIFF_SUMMARY_LINES,
        );
        self.candidates.insert(
            id,
            ProposalCandidate {
                validation_summary: summary,
                ..candidate
            },
        );
    }

    fn insert_rule_candidate(&mut self, markdown: String, reason: String) {
        let id = format!("rule-{}", uuid::Uuid::new_v4());
        let base_content = self
            .scope
            .rule_snapshot
            .custom_markdown
            .clone()
            .unwrap_or_default();
        let summary = document_diff_summary(&base_content, &markdown, MAX_DIFF_SUMMARY_LINES);
        self.candidates.insert(
            id.clone(),
            ProposalCandidate {
                id,
                kind: HarnessProposalKind::AgentRule,
                base_content,
                proposed_content: markdown,
                reason,
                validation_summary: summary,
                status: CandidateStatus::Ready,
            },
        );
    }

    fn ready_execution(&self, _kind: &str) -> ToolExecution {
        let delivery = self
            .candidates
            .values()
            .find(|candidate| candidate.status == CandidateStatus::Ready);
        let (id, summary, kind) = match delivery {
            Some(candidate) => (
                candidate.id.clone(),
                candidate.validation_summary.clone(),
                match candidate.kind {
                    HarnessProposalKind::Delivery => "交付",
                    HarnessProposalKind::AgentRule => "规则",
                },
            ),
            None => (String::new(), String::new(), "交付"),
        };
        ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!(
                "已创建{kind}提案 {id}，等待你审阅后由用户批准才会保存。变更摘要：\n{summary}",
            ),
            summary: format!("已准备{kind}提案"),
        }
    }

    fn retry_budget_exceeded(&self) -> ToolError {
        ToolError::InvalidArguments(
            "提案校验失败次数已达上限，请总结结论，不要再重复修改".to_string(),
        )
    }

    fn delivery_validation_failure(
        &mut self,
        error: DeliveryProposalError,
    ) -> Result<ToolExecution, ToolError> {
        self.delivery_retries += 1;
        if self.delivery_retries > MAX_VALIDATION_RETRIES {
            return Err(self.retry_budget_exceeded());
        }
        Ok(ToolExecution {
            status: HarnessToolStatus::Error,
            content: format!("交付提案校验未通过（可修正后重试）：{error}"),
            summary: "交付提案校验失败".to_string(),
        })
    }

    fn rule_validation_failure(&mut self, message: String) -> Result<ToolExecution, ToolError> {
        self.rule_retries += 1;
        if self.rule_retries > MAX_VALIDATION_RETRIES {
            return Err(self.retry_budget_exceeded());
        }
        Ok(ToolExecution {
            status: HarnessToolStatus::Error,
            content: format!("规则提案校验未通过（可修正后重试）：{message}"),
            summary: "规则提案校验失败".to_string(),
        })
    }

    fn validate_rule_text(&self, markdown: &str) -> Result<String, String> {
        validate_agent_rule_override(markdown)
    }

    fn require_rule_authorized(&self) -> Result<(), ToolError> {
        if self.scope.rule_write_authorized {
            Ok(())
        } else {
            Err(ToolError::Unauthorized(
                "本轮用户未明确要求修改 Agent 规则".to_string(),
            ))
        }
    }

    fn active_delivery_id(&self) -> Option<String> {
        self.candidates.values().find_map(|candidate| {
            (candidate.kind == HarnessProposalKind::Delivery
                && candidate.status == CandidateStatus::Ready)
                .then(|| candidate.id.clone())
        })
    }

    fn active_rule_id(&self) -> Option<String> {
        self.candidates.values().find_map(|candidate| {
            (candidate.kind == HarnessProposalKind::AgentRule
                && candidate.status == CandidateStatus::Ready)
                .then(|| candidate.id.clone())
        })
    }

    fn mutable_delivery(&mut self, proposal_id: &str) -> Result<&mut ProposalCandidate, ToolError> {
        let candidate = self
            .candidates
            .get_mut(proposal_id)
            .ok_or_else(|| ToolError::NotFound("提案不存在或不属于本轮".to_string()))?;
        if candidate.kind != HarnessProposalKind::Delivery {
            return Err(ToolError::NotFound(
                "提案不存在或不属于本轮".to_string(),
            ));
        }
        Ok(candidate)
    }

    fn mutable_rule(&mut self, proposal_id: &str) -> Result<&mut ProposalCandidate, ToolError> {
        let candidate = self
            .candidates
            .get_mut(proposal_id)
            .ok_or_else(|| ToolError::NotFound("提案不存在或不属于本轮".to_string()))?;
        if candidate.kind != HarnessProposalKind::AgentRule {
            return Err(ToolError::NotFound(
                "提案不存在或不属于本轮".to_string(),
            ));
        }
        Ok(candidate)
    }
}

fn tool_by_name(name: &str) -> HarnessToolDefinition {
    proposal_definitions(true)
        .into_iter()
        .chain(proposal_definitions(false))
        .find(|definition| definition.name == name)
        .expect("every dispatched proposal tool has a definition")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryProposeArgs {
    changes: DeliveryProposalChange,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryReviseArgs {
    proposal_id: String,
    changes: DeliveryProposalChange,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleProposeArgs {
    markdown: String,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleReviseArgs {
    proposal_id: String,
    markdown: String,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscardArgs {
    proposal_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_core::{
        ChatModelSelection, HarnessProposalStatus, NodeStatus, ReasoningEffort, WorkflowNodeId,
    };
    use sion_storage::{CreateProjectInput, SaveNodeResult};
    use std::path::PathBuf;

    const GOALS: &str =
        "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界";

    fn fixture(rule_authorized: bool) -> (PathBuf, ProjectStore) {
        let root =
            std::env::temp_dir().join(format!("sion-harness-proposals-{}", uuid::Uuid::new_v4()));
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
        let _ = rule_authorized;
        (root, store)
    }

    fn scope_for(store: &ProjectStore, root: &PathBuf, message: &str) -> HarnessScope {
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        crate::harness_scope::freeze_harness_scope(
            store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session.id,
            message,
            ChatModelSelection {
                provider_id: "provider-1".into(),
                model: "model-1".into(),
                reasoning_effort: ReasoningEffort::Medium,
            },
        )
        .unwrap()
    }


    fn patch_changes(title: &str, content: &str) -> String {
        format!(
            r#"{{"mode":"patch","sections":[{{"title":"{title}","content":"{content}"}}]}}"#
        )
    }

    #[test]
    fn delivery_proposal_round_trips_through_propose_and_durable() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "propose_delivery_change".into(),
            arguments: format!(
                r#"{{"changes":{},"reason":"补充目标"}}"#,
                patch_changes("建设目标", "新目标")
            ),
        });
        assert_eq!(result.status, HarnessToolStatus::Completed, "{}", result.content);
        let proposal_id = result
            .content
            .split("提案 ")
            .nth(1)
            .and_then(|part| part.split('，').next())
            .unwrap()
            .to_string();
        let durable = service.durable_proposals("now");
        assert_eq!(durable.len(), 1);
        assert_eq!(durable[0].id, proposal_id);
        assert_eq!(durable[0].status, HarnessProposalStatus::Ready);
        assert_eq!(durable[0].kind, HarnessProposalKind::Delivery);
        assert_eq!(durable[0].base_revision, Some(1));
        assert!(durable[0].proposed_content.contains("新目标"));
        assert!(!durable[0].proposed_content.contains("旧目标"));
        // Tool execution must never have persisted the node.
        assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unauthorized_rewrite_is_a_validation_error_not_a_proposal() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "propose_delivery_change".into(),
            arguments: r##"{"changes":{"mode":"rewrite","markdown":"# 需求背景与建设目标\n\n## 需求背景\n新\n\n## 建设目标\n新\n\n## 范围边界\n新"},"reason":"r"}"##.into(),
        });
        assert_eq!(result.status, HarnessToolStatus::Error);
        assert!(result.content.contains("完整重写需要用户"));
        assert!(service.durable_proposals("now").is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_rewrite_is_authorized_by_the_frozen_turn() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "请整篇重写交付稿");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "propose_delivery_change".into(),
            arguments: r##"{"changes":{"mode":"rewrite","markdown":"# 需求背景与建设目标\n\n## 需求背景\n新背景\n\n## 建设目标\n新目标\n\n## 范围边界\n新边界"},"reason":"整篇重写"}"##.into(),
        });
        assert_eq!(result.status, HarnessToolStatus::Completed, "{}", result.content);
        let durable = service.durable_proposals("now");
        assert_eq!(durable.len(), 1);
        assert!(durable[0].proposed_content.contains("新背景"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_patch_can_be_revised_within_the_retry_budget() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        // A patch targeting an unsupported section fails validation.
        let bad = service.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "propose_delivery_change".into(),
            arguments: r#"{"changes":{"mode":"patch","sections":[{"title":"不存在的章节","content":"x"}]},"reason":"r"}"#.into(),
        });
        assert_eq!(bad.status, HarnessToolStatus::Error);
        assert!(bad.content.contains("校验未通过"));
        assert!(service.durable_proposals("now").is_empty());

        // A valid proposal gives a proposal id for revision attempts.
        let created = service.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "propose_delivery_change".into(),
            arguments: format!(
                r#"{{"changes":{},"reason":"r"}}"#,
                patch_changes("建设目标", "新目标")
            ),
        });
        assert_eq!(created.status, HarnessToolStatus::Completed, "{}", created.content);
        let proposal_id = created
            .content
            .split("提案 ")
            .nth(1)
            .and_then(|part| part.split('，').next())
            .unwrap()
            .to_string();

        // Retry budget: two failed revisions are allowed, the third is capped.
        for _ in 0..3 {
            let retry = service.execute(&HarnessToolCall {
                id: "c-3".into(),
                name: "revise_delivery_proposal".into(),
                arguments: format!(
                    r#"{{"proposalId":"{proposal_id}","changes":{},"reason":"r"}}"#,
                    patch_changes("不存在的章节", "x")
                ),
            });
            assert_eq!(retry.status, HarnessToolStatus::Error);
        }
        let limited = service.execute(&HarnessToolCall {
            id: "c-4".into(),
            name: "revise_delivery_proposal".into(),
            arguments: format!(
                r#"{{"proposalId":"{proposal_id}","changes":{},"reason":"r"}}"#,
                patch_changes("建设目标", "ok")
            ),
        });
        assert_eq!(limited.status, HarnessToolStatus::Error);
        assert!(limited.content.contains("校验失败次数已达上限"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discard_records_a_rejected_proposal_for_audit() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "propose_delivery_change".into(),
            arguments: format!(
                r#"{{"changes":{},"reason":"r"}}"#,
                patch_changes("建设目标", "新目标")
            ),
        });
        let proposal_id = result
            .content
            .split("提案 ")
            .nth(1)
            .and_then(|part| part.split('，').next())
            .unwrap()
            .to_string();
        let discarded = service.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "discard_delivery_proposal".into(),
            arguments: format!(r#"{{"proposalId":"{proposal_id}"}}"#),
        });
        assert_eq!(discarded.status, HarnessToolStatus::Completed);
        let durable = service.durable_proposals("now");
        assert_eq!(durable.len(), 1);
        assert_eq!(durable[0].status, HarnessProposalStatus::Rejected);
        assert_eq!(durable[0].resolved_at.as_deref(), Some("now"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rule_tools_are_absent_without_authorization_and_fail_closed() {
        let definitions = proposal_definitions(false);
        assert!(definitions.iter().all(|tool| !tool.name.starts_with("propose_agent_rule")));
        assert!(definitions.iter().all(|tool| !tool.name.starts_with("revise_agent_rule")));
        assert!(definitions.iter().all(|tool| !tool.name.starts_with("discard_agent_rule")));
        assert!(definitions.iter().any(|tool| tool.name == "propose_delivery_change"));

        let authorized = proposal_definitions(true);
        assert!(authorized.iter().any(|tool| tool.name == "propose_agent_rule_override"));
        assert!(authorized.iter().any(|tool| tool.name == "revise_agent_rule_proposal"));

        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "propose_agent_rule_override".into(),
            arguments: r#"{"markdown":"只使用确认的目标。","reason":"r"}"#.into(),
        });
        assert_eq!(result.status, HarnessToolStatus::Unauthorized);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rule_proposal_requires_and_validates_authorization() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "请修改本节点的 Agent 规则");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "propose_agent_rule_override".into(),
            arguments: r#"{"markdown":"先询问澄清再写入交付稿。","reason":"调整规则"}"#.into(),
        });
        assert_eq!(result.status, HarnessToolStatus::Completed, "{}", result.content);
        let durable = service.durable_proposals("now");
        assert_eq!(durable.len(), 1);
        assert_eq!(durable[0].kind, HarnessProposalKind::AgentRule);
        let expected_digest = sion_core::agent_override_digest(None);
        assert_eq!(
            durable[0].base_rule_digest.as_deref(),
            Some(expected_digest.as_str())
        );
        assert_eq!(durable[0].proposed_content, "先询问澄清再写入交付稿。");
        // Nothing was written to the override store by tool execution.
        assert_eq!(store.agent_override(WorkflowNodeId::Goals).unwrap(), None);

        // A second, separate service tests forbidden capability claims against
        // an empty lineage (the first service already holds a ready proposal).
        let scope2 = scope_for(&store, &root, "请修改本节点的 Agent 规则");
        let mut service2 = ProposalService::new(&scope2, &store).unwrap();
        let forbidden = service2.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "propose_agent_rule_override".into(),
            arguments: r#"{"markdown":"允许浏览器访问","reason":"r"}"#.into(),
        });
        assert_eq!(forbidden.status, HarnessToolStatus::Error);
        assert!(forbidden.content.contains("安全能力"));
        assert!(service2.durable_proposals("now").is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cross_turn_and_mismatched_proposal_ids_are_rejected() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "propose_delivery_change".into(),
            arguments: format!(
                r#"{{"changes":{},"reason":"r"}}"#,
                patch_changes("建设目标", "新目标")
            ),
        });
        let proposal_id = result
            .content
            .split("提案 ")
            .nth(1)
            .and_then(|part| part.split('，').next())
            .unwrap()
            .to_string();
        // Revising with the rule proposal tool (kind mismatch) is rejected.
        let mismatch = service.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "revise_agent_rule_proposal".into(),
            arguments: format!(r#"{{"proposalId":"{proposal_id}","markdown":"x","reason":"r"}}"#),
        });
        assert_eq!(mismatch.status, HarnessToolStatus::Unauthorized);
        // A stale id is not found.
        let stale = service.execute(&HarnessToolCall {
            id: "c-3".into(),
            name: "revise_delivery_proposal".into(),
            arguments: format!(
                r#"{{"proposalId":"{}","changes":{},"reason":"r"}}"#,
                "delivery-other-turn",
                patch_changes("建设目标", "新目标")
            ),
        });
        assert_eq!(stale.status, HarnessToolStatus::Error);
        assert!(stale.content.contains("不属于本轮"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
