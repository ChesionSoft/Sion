//! Validated Agent-rule proposal and execution-plan request services.
//!
//! A normal planning Harness turn may create one durable pending execution
//! plan candidate (`request_delivery_execution`) and, only when the user
//! explicitly asks, review-only Agent-rule proposal candidates. Tool execution
//! never calls `save_node_if_revision` or `save_agent_override_if_digest`;
//! only user-approved resolution (or the confirmed execution turn) may persist
//! document content. Candidates stay in memory during the active loop and
//! become durable records only at the terminal checkpoint.

// The harness runtime gains its orchestration callers in Tasks 7 and 8.
#![allow(dead_code)]

use std::collections::HashMap;

use serde::Deserialize;
use sion_core::{
    HarnessProposal, HarnessProposalKind, HarnessProposalStatus, HarnessToolCall,
    HarnessToolDefinition, HarnessToolStatus, WorkflowNode, document_diff_summary,
    validate_agent_rule_override,
};
use sion_storage::ProjectStore;

use crate::harness_scope::HarnessScope;
use crate::harness_tools::{ToolError, ToolExecution, validate_tool_arguments};

/// Maximum lines in a proposal diff summary returned to the model.
const MAX_DIFF_SUMMARY_LINES: usize = 40;
/// Maximum length of a proposal reason or execution-plan summary.
const MAX_REASON_CHARS: usize = 400;
/// How long a pending execution plan stays confirmable (ISO duration addition).
const PLAN_EXPIRY_SECONDS: u64 = 30 * 60;

/// The maximum automatic validation retries per proposal lineage.
pub(crate) const MAX_VALIDATION_RETRIES: u32 = 2;

/// Adds an ISO-8601 offset (seconds) to an ISO timestamp and returns the new
/// ISO string. Inputs use the app's fixed UTC ISO format, so naive string
/// arithmetic on the date components is sufficient for the bounded expiry.
fn expiry_from_now(now: &str) -> String {
    let offset = std::time::Duration::from_secs(PLAN_EXPIRY_SECONDS);
    let parsed = iso_parse(now);
    let expanded = parsed + offset.as_secs();
    iso_format(now, expanded)
}

/// Parses `YYYY-MM-DDTHH:MM:SS(.fff)?Z` into a seconds-since-epoch estimate
/// using pure arithmetic; returns 0 for unparseable input (expiry then fails
/// closed at the next comparison).
fn iso_parse(now: &str) -> u64 {
    let digits: Vec<u64> = now
        .chars()
        .filter(|c| c.is_ascii_digit())
        .map(|c| c.to_digit(10).unwrap_or(0) as u64)
        .collect();
    if digits.len() < 14 {
        return 0;
    }
    let year = digits[0] * 1000 + digits[1] * 100 + digits[2] * 10 + digits[3];
    let month = digits[4] * 10 + digits[5];
    let day = digits[6] * 10 + digits[7];
    let hour = digits[8] * 10 + digits[9];
    let minute = digits[10] * 10 + digits[11];
    let second = digits[12] * 10 + digits[13];
    let days = days_from_civil(year, month, day);
    (days as u64) * 86_400 + hour * 3_600 + minute * 60 + second
}

fn iso_format(now: &str, seconds: u64) -> String {
    // Preserve fractional seconds from the original input when present;
    // otherwise emit a plain second resolution.
    let base = format_iso(seconds);
    if let Some(fraction) = now
        .split_once('.')
        .and_then(|(_, rest)| rest.split('Z').next())
    {
        format!("{base}.{fraction}Z")
    } else {
        format!("{base}Z")
    }
}

fn format_iso(seconds: u64) -> String {
    let days = seconds / 86_400;
    let rem = seconds % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}"
    )
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: u64, month: u64, day: u64) -> i64 {
    let year = year as i64;
    let month = month as i64;
    let day = day as i64;
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
fn civil_from_days(z: u64) -> (u64, u64, u64) {
    let z = z as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y } as u64, m as u64, d as u64)
}

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
    serde_json::json!({
        "type": "object",
        "properties": { "proposalId": { "type": "string", "maxLength": 64 } },
        "required": ["proposalId"],
        "additionalProperties": false
    })
}

/// Proposal tool definitions for a normal planning Harness turn.
///
/// Delivery proposal tools are intentionally absent: a planning turn no longer
/// creates direct-apply delivery proposals. Instead the model may request one
/// durable pending execution plan (`request_delivery_execution`) that the user
/// later confirms in natural language; only then does a distinct execution turn
/// write the current node. Agent-rule tools appear only when the frozen turn
/// authorization grants rule proposals (review-only, never direct writes).
/// Historical `HarnessProposal` records and their explicit resolution remain
/// readable and resolvable through the storage layer.
pub(crate) fn proposal_definitions(rule_authorized: bool) -> Vec<HarnessToolDefinition> {
    let mut definitions = vec![tool(
        "request_delivery_execution",
        "当讨论得出明确、值得写入当前交付稿的修改计划时，请求一次用户确认的执行计划。summary 是给用户的简短计划摘要（不超过 200 字）。工具不会保存交付稿；只有用户回复“继续/可以/确认”后，才进入一轮受控执行。",
        execution_request_schema(),
    )];
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

fn execution_request_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string", "maxLength": 400 },
            "targets": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "items": { "type": "string", "enum": sion_core::WorkflowNodeId::ALL.iter().map(|id| id.as_str()).collect::<Vec<_>>() }
            }
        },
        "required": ["summary"],
        "additionalProperties": false
    })
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

/// One in-memory pending execution plan candidate. It is created only after a
/// planning answer has established a clear modification plan; it never writes
/// Markdown. The runtime publishes it durably once the planning turn completes.
#[derive(Debug, Clone)]
struct PendingExecutionCandidate {
    summary: String,
    targets: Vec<sion_core::WorkflowNodeId>,
    created_at: String,
    expires_at: String,
}

/// Per-turn in-memory proposal service. `&mut self` methods enforce one active
/// Agent-rule candidate per turn, one pending execution plan candidate, plus
/// the validation-retry budget. Delivery proposal tools are intentionally
/// removed from new planning turns.
pub(crate) struct ProposalService<'a> {
    scope: &'a HarnessScope,
    store: &'a ProjectStore,
    node: WorkflowNode,
    candidates: HashMap<String, ProposalCandidate>,
    delivery_retries: u32,
    rule_retries: u32,
    pending_execution: Option<PendingExecutionCandidate>,
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
            pending_execution: None,
        })
    }

    /// Executes one proposal tool call. Rule tools fail closed when the frozen
    /// turn authorization does not grant rule writes.
    pub(crate) fn execute(&mut self, call: &HarnessToolCall, now: &str) -> ToolExecution {
        let result = match call.name.as_str() {
            "request_delivery_execution" => self.request_execution(&call.arguments, now),
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

    /// Validates one proposal tool call (schema + turn authorization) without
    /// executing it, so the whole provider batch can be refused before any
    /// call runs.
    pub(crate) fn validate(&self, call: &HarnessToolCall) -> Result<(), ToolError> {
        match call.name.as_str() {
            "request_delivery_execution" => {
                let arguments = validate_tool_arguments(
                    &tool_by_name("request_delivery_execution"),
                    &call.arguments,
                )?;
                let payload: ExecutionRequestArgs = serde_json::from_value(arguments)
                    .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
                if payload.summary.trim().is_empty() {
                    return Err(ToolError::InvalidArguments(
                        "summary 不能为空".to_string(),
                    ));
                }
                Ok(())
            }
            "propose_agent_rule_override" => {
                self.require_rule_authorized()?;
                let arguments = validate_tool_arguments(
                    &tool_by_name("propose_agent_rule_override"),
                    &call.arguments,
                )?;
                let payload: RuleProposeArgs = serde_json::from_value(arguments)
                    .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
                let _ = validate_agent_rule_override(&payload.markdown)
                    .map_err(ToolError::InvalidArguments)?;
                Ok(())
            }
            "revise_agent_rule_proposal" => {
                self.require_rule_authorized()?;
                let arguments =
                    validate_tool_arguments(&tool_by_name("revise_agent_rule_proposal"), &call.arguments)?;
                let payload: RuleReviseArgs = serde_json::from_value(arguments)
                    .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
                let _ = validate_agent_rule_override(&payload.markdown)
                    .map_err(ToolError::InvalidArguments)?;
                Ok(())
            }
            "discard_agent_rule_proposal" => {
                self.require_rule_authorized()?;
                let arguments = validate_tool_arguments(
                    &tool_by_name("discard_agent_rule_proposal"),
                    &call.arguments,
                )?;
                serde_json::from_value::<DiscardArgs>(arguments)
                    .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
                Ok(())
            }
            other => Err(ToolError::InvalidArguments(format!("未知提案工具：{other}"))),
        }
    }

    /// Number of validation retries consumed this turn, reported in diagnostics.
    pub(crate) fn validation_retries(&self) -> u32 {
        self.delivery_retries.saturating_add(self.rule_retries)
    }

    /// Whether rule proposal tools are advertised this turn.
    pub(crate) fn rule_authorized(&self) -> bool {
        self.scope.rule_write_authorized
    }

    /// Whether a pending execution plan candidate exists this turn.
    pub(crate) fn has_pending_execution(&self) -> bool {
        self.pending_execution.is_some()
    }

    /// Builds the durable pending execution plan from the in-memory candidate,
    /// or `None` when the model never requested execution. The caller supplies
    /// the plan's own turn and assistant message ids after the turn completes.
    pub(crate) fn execution_plan_candidate(
        &self,
        plan_turn_id: &str,
        plan_message_id: &str,
    ) -> Option<sion_core::HarnessExecutionPlan> {
        let candidate = self.pending_execution.as_ref()?;
        let targets = candidate
            .targets
            .iter()
            .map(|node_id| {
                self.store
                    .node(*node_id)
                    .ok()
                    .map(|node| sion_core::HarnessExecutionTarget {
                        node_id: *node_id,
                        base_revision: node.revision,
                        display_name: None,
                    })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(sion_core::HarnessExecutionPlan {
            id: format!("plan-{}", uuid::Uuid::new_v4()),
            project_id: self.scope.project_id.clone(),
            node_id: self.scope.node_id,
            session_id: self.scope.session_id.clone(),
            plan_turn_id: plan_turn_id.to_string(),
            plan_message_id: plan_message_id.to_string(),
            base_revision: self.scope.expected_node_revision,
            targets,
            summary: candidate.summary.clone(),
            status: sion_core::HarnessPlanStatus::Pending,
            created_at: candidate.created_at.clone(),
            expires_at: candidate.expires_at.clone(),
            consumed_at: None,
            invalidated_at: None,
            invalid_reason: None,
        })
    }

    /// Ready (reviewable) proposal records for live turn snapshots during the
    /// loop. These are in-memory only until the terminal checkpoint.
    pub(crate) fn ready_proposals(&self, now: &str) -> Vec<HarnessProposal> {
        self.candidates
            .values()
            .filter(|candidate| candidate.status == CandidateStatus::Ready)
            .map(|candidate| self.build_proposal(candidate, now))
            .collect()
    }

    fn request_execution(&mut self, args: &str, now: &str) -> Result<ToolExecution, ToolError> {
        let arguments =
            validate_tool_arguments(&tool_by_name("request_delivery_execution"), args)?;
        let payload: ExecutionRequestArgs = serde_json::from_value(arguments)
            .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
        let summary = payload.summary.trim().to_string();
        if summary.is_empty() {
            return Err(ToolError::InvalidArguments("summary 不能为空".to_string()));
        }
        if summary.chars().count() > MAX_REASON_CHARS {
            return Err(ToolError::InvalidArguments("summary 过长".to_string()));
        }
        if self.pending_execution.is_some() {
            return Err(ToolError::InvalidArguments(
                "本轮已有一个待确认的执行计划，请不要重复请求".to_string(),
            ));
        }
        let targets = payload.targets.unwrap_or_else(|| vec![self.scope.node_id]);
        if targets.is_empty() || targets.len() > sion_core::WorkflowNodeId::ALL.len() {
            return Err(ToolError::InvalidArguments("目标节点数量无效".to_string()));
        }
        let mut seen = std::collections::HashSet::new();
        for node_id in &targets {
            if !seen.insert(*node_id) {
                return Err(ToolError::InvalidArguments("目标节点不能重复".to_string()));
            }
            self.store
                .node(*node_id)
                .map_err(|_| ToolError::InvalidArguments("目标节点不存在".to_string()))?;
        }
        self.pending_execution = Some(PendingExecutionCandidate {
            summary,
            targets,
            created_at: now.to_string(),
            expires_at: expiry_from_now(now),
        });
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: "已准备好执行计划。请在最终回复中明确向用户说明计划内容，并请求用户回复“继续”或“可以”来确认执行。你尚未保存任何内容。".to_string(),
            summary: "已请求执行计划确认".to_string(),
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
                Ok(self.ready_execution())
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
                Ok(self.ready_execution())
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
            let mut proposal = self.build_proposal(candidate, now);
            proposal.status = status;
            proposal.resolved_at = resolved_at;
            proposals.push(proposal);
        }
        proposals
    }

    fn build_proposal(&self, candidate: &ProposalCandidate, now: &str) -> HarnessProposal {
        let (base_revision, base_rule_digest) = match candidate.kind {
            HarnessProposalKind::Delivery => (Some(self.scope.expected_node_revision), None),
            HarnessProposalKind::AgentRule => {
                (None, Some(self.scope.rule_snapshot.digest.clone()))
            }
        };
        HarnessProposal {
            id: candidate.id.clone(),
            kind: candidate.kind,
            status: HarnessProposalStatus::Ready,
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
            resolved_at: None,
            latest_revision: None,
            latest_rule_digest: None,
        }
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

    fn ready_execution(&self) -> ToolExecution {
        let candidate = self
            .candidates
            .values()
            .find(|candidate| candidate.status == CandidateStatus::Ready);
        let (id, summary) = match candidate {
            Some(candidate) => (
                candidate.id.clone(),
                candidate.validation_summary.clone(),
            ),
            None => (String::new(), String::new()),
        };
        ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!(
                "已创建规则提案 {id}，等待用户批准后才会生效。变更摘要：\n{summary}",
            ),
            summary: "已准备规则提案".to_string(),
        }
    }

    fn retry_budget_exceeded(&self) -> ToolError {
        ToolError::InvalidArguments(
            "提案校验失败次数已达上限，请总结结论，不要再重复修改".to_string(),
        )
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

    fn active_rule_id(&self) -> Option<String> {
        self.candidates.values().find_map(|candidate| {
            (candidate.kind == HarnessProposalKind::AgentRule
                && candidate.status == CandidateStatus::Ready)
                .then(|| candidate.id.clone())
        })
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionRequestArgs {
    summary: String,
    #[serde(default)]
    targets: Option<Vec<sion_core::WorkflowNodeId>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_core::{
        ChatModelSelection, NodeStatus, ReasoningEffort, WorkflowNodeId,
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
    fn request_execution_creates_one_pending_plan_candidate_without_writes() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        assert!(!service.has_pending_execution());
        let result = service.execute(
            &HarnessToolCall {
                id: "c-1".into(),
                name: "request_delivery_execution".into(),
                arguments: r#"{"summary":"补充建设目标与验收标准"}"#.into(),
            },
            "2026-08-17T00:00:00.000Z",
        );
        assert_eq!(result.status, HarnessToolStatus::Completed, "{}", result.content);
        assert!(service.has_pending_execution());
        // The candidate builds a durable plan pinned to the current node and
        // base revision; tool execution never wrote the node.
        let plan = service
            .execution_plan_candidate("turn-plan", "message-plan")
            .unwrap();
        assert!(plan.id.starts_with("plan-"));
        assert_eq!(plan.node_id, WorkflowNodeId::Goals);
        assert_eq!(plan.base_revision, 1);
        assert_eq!(plan.plan_turn_id, "turn-plan");
        assert_eq!(plan.plan_message_id, "message-plan");
        assert_eq!(plan.summary, "补充建设目标与验收标准");
        assert!(plan.expires_at > plan.created_at);
        assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn request_execution_rejects_empty_and_duplicate_requests() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let empty = service.execute(
            &HarnessToolCall {
                id: "c-1".into(),
                name: "request_delivery_execution".into(),
                arguments: r#"{"summary":"   "}"#.into(),
            },
            "now",
        );
        assert_eq!(empty.status, HarnessToolStatus::Error);
        assert!(!service.has_pending_execution());

        let first = service.execute(
            &HarnessToolCall {
                id: "c-2".into(),
                name: "request_delivery_execution".into(),
                arguments: r#"{"summary":"补充目标"}"#.into(),
            },
            "now",
        );
        assert_eq!(first.status, HarnessToolStatus::Completed);
        // A second request is refused: one pending plan per turn.
        let second = service.execute(
            &HarnessToolCall {
                id: "c-3".into(),
                name: "request_delivery_execution".into(),
                arguments: r#"{"summary":"再补充范围边界"}"#.into(),
            },
            "now",
        );
        assert_eq!(second.status, HarnessToolStatus::Error);
        assert!(second.content.contains("已有一个待确认"));
        assert!(service.has_pending_execution());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_pending_execution_yields_no_plan_candidate() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let service = ProposalService::new(&scope, &store).unwrap();
        assert!(service.execution_plan_candidate("turn-plan", "message-plan").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rule_tools_are_absent_without_authorization_and_fail_closed() {
        let definitions = proposal_definitions(false);
        assert!(definitions.iter().all(|tool| !tool.name.starts_with("propose_agent_rule")));
        assert!(definitions.iter().all(|tool| !tool.name.starts_with("revise_agent_rule")));
        assert!(definitions.iter().all(|tool| !tool.name.starts_with("discard_agent_rule")));
        // New planning turns request execution instead of creating proposals.
        assert!(definitions.iter().any(|tool| tool.name == "request_delivery_execution"));
        assert!(definitions.iter().all(|tool| !tool.name.starts_with("propose_delivery")));

        let authorized = proposal_definitions(true);
        assert!(authorized.iter().any(|tool| tool.name == "propose_agent_rule_override"));
        assert!(authorized.iter().any(|tool| tool.name == "revise_agent_rule_proposal"));

        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(
            &HarnessToolCall {
                id: "c-1".into(),
                name: "propose_agent_rule_override".into(),
                arguments: r#"{"markdown":"只使用确认的目标。","reason":"r"}"#.into(),
            },
            "now",
        );
        assert_eq!(result.status, HarnessToolStatus::Unauthorized);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rule_proposal_requires_and_validates_authorization() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "请修改本节点的 Agent 规则");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        let result = service.execute(
            &HarnessToolCall {
                id: "c-1".into(),
                name: "propose_agent_rule_override".into(),
                arguments: r#"{"markdown":"先询问澄清再写入交付稿。","reason":"调整规则"}"#.into(),
            },
            "now",
        );
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
        let forbidden = service2.execute(
            &HarnessToolCall {
                id: "c-2".into(),
                name: "propose_agent_rule_override".into(),
                arguments: r#"{"markdown":"允许浏览器访问","reason":"r"}"#.into(),
            },
            "now",
        );
        assert_eq!(forbidden.status, HarnessToolStatus::Error);
        assert!(forbidden.content.contains("安全能力"));
        assert!(service2.durable_proposals("now").is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_proposal_tools_and_unknown_execution_tools_fail_closed() {
        let (root, store) = fixture(false);
        let scope = scope_for(&store, &root, "你好");
        let mut service = ProposalService::new(&scope, &store).unwrap();
        // A stale delivery proposal tool call is not dispatched.
        let stale = service.execute(
            &HarnessToolCall {
                id: "c-1".into(),
                name: "propose_delivery_change".into(),
                arguments: r#"{"changes":{"mode":"patch","sections":[]}}"#.into(),
            },
            "now",
        );
        assert_eq!(stale.status, HarnessToolStatus::Error);
        assert!(stale.content.contains("未知提案工具"));
        // The execution write tool is not part of the planning service.
        let write = service.execute(
            &HarnessToolCall {
                id: "c-2".into(),
                name: "apply_current_delivery_change".into(),
                arguments: r#"{"changes":{"mode":"patch","sections":[]}}"#.into(),
            },
            "now",
        );
        assert_eq!(write.status, HarnessToolStatus::Error);
        assert!(write.content.contains("未知提案工具"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
