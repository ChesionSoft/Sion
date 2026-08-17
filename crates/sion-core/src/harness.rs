//! Provider-neutral Harness contracts for Sion's document Agent runtime.
//!
//! This module is the single serde-stable vocabulary shared by the agent
//! protocol layer, the Tauri tool registry, and the storage layer. It contains
//! no Tauri, HTTP, or filesystem dependency.
//!
//! Model-visible values are deliberately bounded: durable records never carry
//! prompts, raw provider frames, hidden reasoning, absolute paths, API keys, or
//! raw tool JSON. The types here are additive and backward-compatible so
//! historical conversation documents and run kinds keep loading unchanged.

use serde::{Deserialize, Serialize};

use crate::WorkflowNodeId;

/// A provider-neutral tool definition used to build protocol-specific
/// `tools`/`function` payloads. `parameters` is a JSON-schema object whose
/// `additionalProperties` is false at the registry boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// A normalized, provider-neutral tool call emitted by the model in one step.
/// `arguments` is the raw JSON argument string as streamed by the provider; the
/// executing registry parses and validates it against the frozen tool schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// How a single model step ended. Used to normalize terminal step handling so
/// the Harness loop never branches on a provider protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessModelStepReason {
    /// The step ended with one or more tool calls to execute.
    ToolCalls,
    /// The step ended with a final assistant response and no pending tool call.
    FinalResponse,
    /// The step was cancelled before producing a result.
    Cancelled,
    /// A step/tool/token/time/duplicate limit stopped the turn.
    LimitReached,
    /// The provider step failed.
    Failed,
}

/// Outcome of executing one tool call. Read tools succeed or fail; proposal
/// tools may also be rejected for being unauthorized or out of scope. The
/// `summary` on the durable trace is always a safe, capped public label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessToolStatus {
    Completed,
    Error,
    Unauthorized,
    Skipped,
}

/// Sanitized, durable record of one executed tool call. It never contains the
/// tool's raw JSON, the document excerpt returned to the model, storage paths,
/// or internal error details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedToolTrace {
    pub call_id: String,
    pub name: String,
    pub status: HarnessToolStatus,
    /// Capped public label/summary for run details; never raw tool JSON.
    pub summary: String,
    pub started_at: String,
    pub finished_at: String,
}

/// Which bounded limit terminated a Harness turn. Public diagnostics report the
/// limit without exposing prompts, frames, or hidden reasoning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessLimitKind {
    ModelSteps,
    ToolCalls,
    ValidationRetries,
    Tokens,
    WallClock,
    DuplicateCall,
}

/// Bounded public diagnostics for a completed Harness turn. Fields are counts
/// and safe summaries only; no prompt, raw provider frame, partial assistant
/// output, path, or secret may ever appear here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDiagnostics {
    pub model_steps: u32,
    pub tool_calls: u32,
    pub validation_retries: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_reached: Option<HarnessLimitKind>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_traces: Vec<SanitizedToolTrace>,
}

impl HarnessDiagnostics {
    pub fn new() -> Self {
        Self {
            model_steps: 0,
            tool_calls: 0,
            validation_retries: 0,
            limit_reached: None,
            tool_traces: Vec::new(),
        }
    }
}

impl Default for HarnessDiagnostics {
    fn default() -> Self {
        Self::new()
    }
}

/// Bounded budget defaults enforced by the Harness loop. The runtime may lower
/// these (shared token/time budget) but never raises them from a model input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessLimits {
    pub max_model_steps: u32,
    pub max_tool_calls: u32,
    pub max_validation_retries: u32,
    pub max_wall_clock_ms: u64,
}

impl Default for HarnessLimits {
    fn default() -> Self {
        Self {
            max_model_steps: 8,
            max_tool_calls: 12,
            max_validation_retries: 2,
            max_wall_clock_ms: 15 * 60 * 1000,
        }
    }
}

/// What kind of document change a proposal targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessProposalKind {
    Delivery,
    AgentRule,
}

/// Lifecycle of a durable proposal. Proposals are never persisted as content
/// until the model has finished a valid candidate; resolution is independent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessProposalStatus {
    Ready,
    Rejected,
    Applied,
    Stale,
}

/// A durable, reviewable document change candidate created by Harness tools.
/// `base_revision` is set for delivery proposals (expected node revision);
/// `base_rule_digest` is set for Agent-rule proposals (SHA-256 of the exact
/// override state). The node or override is never changed by tool execution;
/// only user-approved proposal resolution may persist document content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessProposal {
    pub id: String,
    pub kind: HarnessProposalKind,
    pub status: HarnessProposalStatus,
    pub project_id: String,
    pub node_id: WorkflowNodeId,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_rule_digest: Option<String>,
    pub base_content: String,
    pub proposed_content: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_summary: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    /// Latest node revision at the time the proposal was marked stale, needed
    /// for the UI to explain the revision mismatch and show the latest source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_revision: Option<u64>,
    /// Latest override digest when an Agent-rule proposal was marked stale.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_rule_digest: Option<String>,
}

/// Lifecycle of a durable pending execution plan. A plan is created by a
/// completed planning Harness turn and authorizes exactly one execution turn
/// after a valid natural-language confirmation. Consumption and invalidation
/// are terminal; a plan is never recreated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessPlanStatus {
    /// Published with the planning turn; may still be confirmed.
    Pending,
    /// Atomically consumed by a valid confirmation; the execution turn started.
    Consumed,
    /// Terminal invalidation (expiry, node change, cancel, restart, ambiguity).
    Invalidated,
}

/// Why a pending execution plan can no longer be consumed. Kept as a public,
/// safe label for the audit card; never a raw error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessPlanInvalidReason {
    /// The plan outlived its bounded expiry window.
    Expired,
    /// The current node revision moved after the plan was recorded.
    NodeChanged,
    /// The owning session was deleted.
    SessionDeleted,
    /// The user cancelled the pending plan.
    Cancelled,
    /// The application restarted; an active plan is never replayed.
    Restarted,
    /// The reply was not a narrow affirmative (ambiguous confirmation).
    AmbiguousConfirmation,
    /// Another successful node save invalidated the plan.
    ManualEdit,
}

/// A durable pending execution plan created by a completed planning Harness
/// turn. It pins the ownership (project/node/session), the plan's own turn and
/// assistant message, the base node revision the plan was recorded against, and
/// a bounded public summary. The summary is the only model-authored content;
/// prompts, raw tool arguments, thinking, paths, and secrets never appear here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessExecutionPlan {
    /// Opaque generated plan ID; never supplied by the model or frontend.
    pub id: String,
    pub project_id: String,
    pub node_id: WorkflowNodeId,
    pub session_id: String,
    /// The completed planning turn that published this plan.
    pub plan_turn_id: String,
    /// The assistant message id that explicitly requested confirmation.
    pub plan_message_id: String,
    /// Node revision the plan was recorded against; the confirmation must see
    /// the same revision or the plan is invalidated.
    pub base_revision: u64,
    /// Bounded public summary of the intended document changes.
    pub summary: String,
    pub status: HarnessPlanStatus,
    pub created_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalidated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid_reason: Option<HarnessPlanInvalidReason>,
}

/// Status of one execution run, persisted as a public audit record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessExecutionStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    /// Interrupted by restart; never replayed and never reported as success.
    Interrupted,
}

/// Public summary of one saved current-node write during an execution run.
/// Contains only the saved revision, a bounded summary, and the save time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessExecutionWrite {
    pub revision: u64,
    pub summary: String,
    pub saved_at: String,
}

/// Durable public audit of a completed, failed, cancelled, or interrupted
/// execution run. It carries public status, saved write summaries, and a safe
/// public error label; never prompts, raw tool arguments, or document bodies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessExecutionRecord {
    pub run_id: String,
    pub turn_id: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub status: HarnessExecutionStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub writes: Vec<HarnessExecutionWrite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_error: Option<String>,
}

/// Result of one `apply_current_delivery_change` execution write. This is the
/// safe, bounded outcome sent back to the model; it carries only the new
/// revision or a public failure label, never paths or internal errors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum HarnessExecutionWriteResult {
    /// The node was atomically saved with the given revision.
    Saved { revision: u64 },
    /// CAS conflict: the node changed since the plan; no write occurred.
    Conflict { expected_revision: u64, actual_revision: u64 },
    /// The validated change produced no document difference.
    Unchanged,
    /// The change failed Markdown validation; nothing was written.
    ValidationFailed { public_error: String },
    /// The execution turn was cancelled before the write could be attempted.
    Cancelled,
}

/// Explicit Harness marker/state stored on a `ConversationTurn`. Legacy turns
/// leave this `None`; new Harness turns carry proposals, bounded diagnostics,
/// an optional pending execution plan, and an optional execution audit record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTurnState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposals: Vec<HarnessProposal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<HarnessDiagnostics>,
    /// Durable pending execution plan published by a completed planning turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_plan: Option<HarnessExecutionPlan>,
    /// Durable public audit of an execution run that this turn participated in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<HarnessExecutionRecord>,
}

impl HarnessTurnState {
    /// Returns a mutable handle to a proposal by id, for resolution transitions.
    pub fn proposal_mut(&mut self, proposal_id: &str) -> Option<&mut HarnessProposal> {
        self.proposals
            .iter_mut()
            .find(|proposal| proposal.id == proposal_id)
    }
}

/// Turn-scoped authorization derived from the latest user message. Both flags
/// fail closed: an ambiguous or unrelated message grants neither capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TurnMessageAuthorization {
    /// User explicitly asked for a complete (whole-document) delivery rewrite.
    pub complete_delivery_rewrite: bool,
    /// User explicitly asked to change the current node's Agent rule/behavior.
    pub agent_rule_proposal: bool,
}

impl TurnMessageAuthorization {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn is_none(&self) -> bool {
        !self.complete_delivery_rewrite && !self.agent_rule_proposal
    }
}

const AGENT_RULE_TERMS: &[&str] = &[
    "规则",
    "rule",
    "agent 行为",
    "agent 配置",
    "agent behavior",
];

const AGENT_RULE_CHANGE_TERMS: &[&str] = &[
    "修改",
    "更改",
    "更新",
    "调整",
    "改为",
    "改成",
    "覆盖",
    "自定义",
    "改一下",
    "重写",
    "改",
    "调",
    "change",
    "update",
    "modify",
    "edit",
    "override",
    "customize",
    "rewrite",
    "adjust",
];

const DELIVERY_REWRITE_TERMS: &[&str] = &["重写", "rewrite", "regenerate", "重新生成"];

const DELIVERY_WHOLE_TERMS: &[&str] = &[
    "整篇",
    "整体",
    "全部",
    "整个",
    "完全",
    "全篇",
    "从头",
    "entire",
    "whole",
    "complete",
    "full",
    "entirely",
    "completely",
    "from scratch",
];

fn requests_agent_rule_change(text: &str) -> bool {
    AGENT_RULE_TERMS
        .iter()
        .any(|term| text.contains(term))
        && AGENT_RULE_CHANGE_TERMS.iter().any(|term| text.contains(term))
}

fn requests_complete_delivery_rewrite(text: &str) -> bool {
    DELIVERY_REWRITE_TERMS
        .iter()
        .any(|term| text.contains(term))
        && DELIVERY_WHOLE_TERMS.iter().any(|term| text.contains(term))
}

/// Auditable predicate over the latest user message that decides turn-scoped
/// authorization for complete delivery rewrites and Agent-rule proposal tools.
///
/// It fails closed: only messages that clearly and explicitly request the
/// capability grant it. A rule change and a complete rewrite may be granted
/// together when the message asks for both; unrelated or merely ambiguous
/// messages grant neither.
pub fn authorize_latest_user_message(message: &str) -> TurnMessageAuthorization {
    let text = message.trim().to_lowercase();
    TurnMessageAuthorization {
        agent_rule_proposal: requests_agent_rule_change(&text),
        complete_delivery_rewrite: requests_complete_delivery_rewrite(&text),
    }
}

/// Terms that mark an assistant reply as an explicit request for user
/// confirmation of a planned document execution. Only an assistant message that
/// both carries a durable pending execution plan and matches these terms can
/// put the following user reply into the confirmation window.
const EXPLICIT_CONFIRMATION_REQUEST_TERMS: &[&str] = &[
    "请确认",
    "是否继续",
    "可以继续吗",
    "可以执行吗",
    "确认后",
    "确认执行",
    "回复继续",
    "回复“继续”",
    "回复\"继续\"",
    "请回复",
    "请继续",
    "继续执行",
    "确认后开始",
    "确认后执行",
    "please confirm",
    "confirm before",
    "confirm to execute",
    "reply continue",
    "shall i continue",
    "continue?",
];

/// Returns whether the assistant message explicitly asks the user to confirm a
/// planned document execution. Used only as one input to the trusted
/// confirmation predicate; a durable pending plan is still required.
pub fn requests_execution_confirmation(message: &str) -> bool {
    let text = message.trim();
    if text.is_empty() {
        return false;
    }
    EXPLICIT_CONFIRMATION_REQUEST_TERMS
        .iter()
        .any(|term| text.contains(term))
}

/// Narrow affirmative reply terms. A confirmation is accepted only when the
/// reply consists of one of these exact tokens (ignoring surrounding
/// whitespace/punctuation) and contains no negation. Anything longer or more
/// elaborate fails closed and starts a normal read-only Harness turn.
const AFFIRMATIVE_CONFIRMATION_TERMS: &[&str] = &[
    "继续",
    "可以",
    "确认",
    "执行",
    "同意",
    "好的",
    "好",
    "行",
    "ok",
    "okay",
    "yes",
    "yeah",
    "sure",
    "confirm",
    "proceed",
    "continue",
    "go ahead",
    "do it",
];

/// Negation words that invalidate a confirmation reply even if an affirmative
/// token is present. A reply containing any of these fails closed.
const NEGATIVE_CONFIRMATION_TERMS: &[&str] = &[
    "不要",
    "不用",
    "不行",
    "别",
    "取消",
    "停止",
    "暂缓",
    "等一下",
    "等等",
    "算了",
    "no",
    "not",
    "never",
    "cancel",
    "stop",
    "wait",
    "don't",
    "dont",
];

/// Pure, fail-closed predicate over the latest user reply that decides whether
/// it is a narrow affirmative confirmation of a pending execution plan. It
/// never authorizes anything by itself: the storage layer still requires a
/// live, matching, unconsumed plan and current node revision.
pub fn is_execution_confirmation(reply: &str) -> bool {
    let trimmed = reply.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_lowercase();
    if NEGATIVE_CONFIRMATION_TERMS
        .iter()
        .any(|term| lower.contains(term))
    {
        return false;
    }
    let normalized = lower
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '，' | '。' | '！' | '？' | '、' | ',' | '.' | '!' | '?' | '；' | ';' | '：' | ':'
            )
        })
        .collect::<String>();
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return false;
    }
    AFFIRMATIVE_CONFIRMATION_TERMS
        .iter()
        .any(|term| normalized == *term)
}

/// Stable SHA-256 digest of the exact current Agent-override state for the
/// current node. `None` (no override) has a distinct, stable representation so
/// a rule proposal can detect concurrent override changes with a digest CAS.
pub fn agent_override_digest(custom_markdown: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    match custom_markdown {
        Some(markdown) => {
            hasher.update(b"sion-agent-override:");
            hasher.update(markdown.trim());
        }
        None => {
            hasher.update(b"sion-agent-override:absent");
        }
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_limits_defaults_are_bounded() {
        let limits = HarnessLimits::default();
        assert_eq!(limits.max_model_steps, 8);
        assert_eq!(limits.max_tool_calls, 12);
        assert_eq!(limits.max_validation_retries, 2);
        assert!(limits.max_wall_clock_ms > 0);
    }

    #[test]
    fn agent_override_digest_is_stable_and_distinct_for_no_override() {
        let absent = agent_override_digest(None);
        let present = agent_override_digest(Some("只使用确认的目标。"));
        assert_eq!(absent, agent_override_digest(None));
        assert_eq!(present, agent_override_digest(Some("只使用确认的目标。")));
        assert_ne!(absent, present);
        assert_eq!(absent.len(), 64);
        assert!(absent.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn tool_definitions_serialize_stable_wire_names() {
        let definition = HarnessToolDefinition {
            name: "read_current_delivery".into(),
            description: "读取当前交付稿".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        };
        let value = serde_json::to_value(&definition).unwrap();
        assert_eq!(value["name"], "read_current_delivery");
        assert_eq!(value["parameters"]["additionalProperties"], false);

        let call = HarnessToolCall {
            id: "call-1".into(),
            name: "read_attachment".into(),
            arguments: r#"{"fileId":"file-1"}"#.into(),
        };
        let value = serde_json::to_value(&call).unwrap();
        assert_eq!(value["id"], "call-1");
        assert_eq!(value["arguments"], r#"{"fileId":"file-1"}"#);
        assert_eq!(
            serde_json::from_value::<HarnessToolCall>(value).unwrap(),
            call
        );
    }

    #[test]
    fn sanitized_tool_trace_round_trips_without_content() {
        let trace = SanitizedToolTrace {
            call_id: "call-1".into(),
            name: "read_attachment".into(),
            status: HarnessToolStatus::Completed,
            summary: "已读取附件".into(),
            started_at: "start".into(),
            finished_at: "end".into(),
        };
        let value = serde_json::to_value(&trace).unwrap();
        assert_eq!(value["status"], "completed");
        assert_eq!(value["summary"], "已读取附件");
        assert!(value.get("content").is_none());
        assert_eq!(serde_json::from_value::<SanitizedToolTrace>(value).unwrap(), trace);
    }

    #[test]
    fn diagnostics_defaults_serialize_without_absent_fields() {
        let diagnostics = HarnessDiagnostics::new();
        let value = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(value["modelSteps"], 0);
        assert!(value.get("limitReached").is_none());
        assert!(value.get("toolTraces").is_none());
        assert_eq!(
            serde_json::from_value::<HarnessDiagnostics>(value).unwrap(),
            diagnostics
        );
    }

    #[test]
    fn proposal_round_trips_kind_status_and_ownership() {
        let proposal = HarnessProposal {
            id: "proposal-1".into(),
            kind: HarnessProposalKind::Delivery,
            status: HarnessProposalStatus::Ready,
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            turn_id: "turn-1".into(),
            base_revision: Some(7),
            base_rule_digest: None,
            base_content: "# 需求背景与建设目标\n\n## 需求背景\n旧".into(),
            proposed_content: "# 需求背景与建设目标\n\n## 需求背景\n新".into(),
            reason: "用户要求补充背景".into(),
            validation_summary: Some("校验通过".into()),
            created_at: "now".into(),
            resolved_at: None,
            latest_revision: None,
            latest_rule_digest: None,
        };
        let value = serde_json::to_value(&proposal).unwrap();
        assert_eq!(value["kind"], "delivery");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["nodeId"], "goals");
        assert_eq!(value["baseRevision"], 7);
        assert_eq!(
            serde_json::from_value::<HarnessProposal>(value).unwrap(),
            proposal
        );
    }

    #[test]
    fn rule_proposal_uses_digest_instead_of_revision() {
        let proposal = HarnessProposal {
            id: "proposal-2".into(),
            kind: HarnessProposalKind::AgentRule,
            status: HarnessProposalStatus::Ready,
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            turn_id: "turn-1".into(),
            base_revision: None,
            base_rule_digest: Some("deadbeef".into()),
            base_content: String::new(),
            proposed_content: "只使用确认的目标。".into(),
            reason: "用户要求调整规则".into(),
            validation_summary: None,
            created_at: "now".into(),
            resolved_at: None,
            latest_revision: None,
            latest_rule_digest: None,
        };
        let value = serde_json::to_value(&proposal).unwrap();
        assert_eq!(value["kind"], "agent_rule");
        assert_eq!(value["baseRuleDigest"], "deadbeef");
        assert!(value.get("baseRevision").is_none());
    }

    #[test]
    fn chinese_explicit_rule_and_rewrite_requests_are_authorized() {
        let authorization = authorize_latest_user_message("请修改本节点的 Agent 规则");
        assert!(authorization.agent_rule_proposal);
        assert!(!authorization.complete_delivery_rewrite);

        let authorization = authorize_latest_user_message("把规则改成更严格的");
        assert!(authorization.agent_rule_proposal);

        let authorization = authorize_latest_user_message("请整篇重写当前交付稿");
        assert!(authorization.complete_delivery_rewrite);
        assert!(!authorization.agent_rule_proposal);

        let authorization = authorize_latest_user_message("完全重写这份文档");
        assert!(authorization.complete_delivery_rewrite);
    }

    #[test]
    fn english_explicit_requests_are_authorized() {
        let authorization = authorize_latest_user_message("Please update the agent rules for this node");
        assert!(authorization.agent_rule_proposal);

        let authorization = authorize_latest_user_message("Rewrite the whole delivery document");
        assert!(authorization.complete_delivery_rewrite);

        let authorization = authorize_latest_user_message("Can you modify the rule to be stricter?");
        assert!(authorization.agent_rule_proposal);
    }

    #[test]
    fn ambiguous_or_unrelated_messages_fail_closed() {
        for message in [
            "你好",
            "请修改一下交付稿",
            "重写一下",
            "这段可以改",
            "这个规则是什么意思",
            "请遵循规则回答",
            "what are the rules here",
            "can you revise this paragraph",
            "改",
            "重写",
        ] {
            let authorization = authorize_latest_user_message(message);
            assert!(
                authorization.is_none(),
                "must fail closed for {message:?}: {authorization:?}"
            );
        }
    }

    #[test]
    fn rule_and_rewrite_requests_can_be_granted_together() {
        let authorization =
            authorize_latest_user_message("请整篇重写交付稿，并更新本节点的 Agent 规则");
        assert!(authorization.complete_delivery_rewrite);
        assert!(authorization.agent_rule_proposal);
    }

    #[test]
    fn explicit_confirmation_requests_are_detected() {
        for message in [
            "请确认后我将执行上述修改。",
            "是否继续执行？请回复“继续”。",
            "以上修改已就绪，确认执行后开始。",
            "计划如下，请确认。",
            "Please confirm before I execute the changes.",
            "可以执行吗？",
            "回复继续即可开始。",
        ] {
            assert!(
                requests_execution_confirmation(message),
                "must detect confirmation request: {message:?}"
            );
        }
    }

    #[test]
    fn non_confirmation_requests_are_rejected() {
        for message in [
            "我已经完成了分析。",
            "这是当前交付稿的摘要。",
            "hello there",
            "",
            "   ",
            "请告诉我你的想法",
        ] {
            assert!(
                !requests_execution_confirmation(message),
                "must not detect confirmation request: {message:?}"
            );
        }
    }

    #[test]
    fn narrow_affirmatives_are_confirmations() {
        for reply in ["继续", "可以", "确认", "执行", "同意", "好的", "好", "行", "OK", "okay", "yes", "sure", "confirm", "proceed", "go ahead", " 继续 ", "继续。", "可以！"] {
            assert!(
                is_execution_confirmation(reply),
                "must accept narrow affirmative: {reply:?}"
            );
        }
    }

    #[test]
    fn negatives_and_ambiguous_replies_fail_closed() {
        for reply in [
            "不要",
            "不用",
            "不行",
            "取消",
            "停止",
            "等一下",
            "算了",
            "no",
            "not",
            "cancel",
            "stop",
            "wait",
            "don't",
            "可以的，但是等一下",
            "好，先别执行",
            "继续吧，但我还要想想",
            "今天天气不错",
            "好的，我们再讨论一下需求",
            "嗯，我需要更多信息",
            "123",
            "??",
        ] {
            assert!(
                !is_execution_confirmation(reply),
                "must fail closed for {reply:?}"
            );
        }
    }

    #[test]
    fn confirmation_reply_cannot_authorize_agent_rule_or_other_targets() {
        // The predicate only says "this is an affirmative"; authorization still
        // requires a durable plan whose target is exactly the current node.
        assert!(is_execution_confirmation("可以"));
        // A reply that mentions a rule change is not a narrow confirmation.
        assert!(!is_execution_confirmation("可以，修改规则"));
    }

    #[test]
    fn execution_plan_round_trips_with_lifecycle() {
        let plan = HarnessExecutionPlan {
            id: "plan-1".into(),
            project_id: "project-1".into(),
            node_id: WorkflowNodeId::Goals,
            session_id: "session-1".into(),
            plan_turn_id: "turn-1".into(),
            plan_message_id: "message-1".into(),
            base_revision: 3,
            summary: "补充建设目标与验收标准".into(),
            status: HarnessPlanStatus::Pending,
            created_at: "now".into(),
            expires_at: "later".into(),
            consumed_at: None,
            invalidated_at: None,
            invalid_reason: None,
        };
        let value = serde_json::to_value(&plan).unwrap();
        assert_eq!(value["status"], "pending");
        assert_eq!(value["nodeId"], "goals");
        assert_eq!(value["baseRevision"], 3);
        assert!(value.get("consumedAt").is_none());
        assert!(value.get("invalidReason").is_none());
        assert_eq!(
            serde_json::from_value::<HarnessExecutionPlan>(value).unwrap(),
            plan
        );

        let consumed = HarnessExecutionPlan {
            status: HarnessPlanStatus::Consumed,
            consumed_at: Some("consumed".into()),
            invalidated_at: None,
            invalid_reason: None,
            ..plan.clone()
        };
        let value = serde_json::to_value(&consumed).unwrap();
        assert_eq!(value["status"], "consumed");
        assert_eq!(value["consumedAt"], "consumed");

        let invalidated = HarnessExecutionPlan {
            status: HarnessPlanStatus::Invalidated,
            consumed_at: None,
            invalidated_at: Some("invalid".into()),
            invalid_reason: Some(HarnessPlanInvalidReason::NodeChanged),
            ..plan
        };
        let value = serde_json::to_value(&invalidated).unwrap();
        assert_eq!(value["status"], "invalidated");
        assert_eq!(value["invalidReason"], "node_changed");
        assert_eq!(
            serde_json::from_value::<HarnessExecutionPlan>(value).unwrap(),
            invalidated
        );
    }

    #[test]
    fn execution_record_and_write_result_round_trip_without_content() {
        let record = HarnessExecutionRecord {
            run_id: "run-1".into(),
            turn_id: "turn-1".into(),
            started_at: "start".into(),
            finished_at: Some("finish".into()),
            status: HarnessExecutionStatus::Completed,
            writes: vec![HarnessExecutionWrite {
                revision: 4,
                summary: "保存建设目标章节".into(),
                saved_at: "saved".into(),
            }],
            public_error: None,
        };
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["status"], "completed");
        assert_eq!(value["writes"][0]["revision"], 4);
        assert!(value.get("publicError").is_none());
        assert_eq!(
            serde_json::from_value::<HarnessExecutionRecord>(value).unwrap(),
            record
        );

        let saved = HarnessExecutionWriteResult::Saved { revision: 4 };
        let value = serde_json::to_value(&saved).unwrap();
        assert_eq!(value["kind"], "saved");
        assert_eq!(value["revision"], 4);
        assert_eq!(
            serde_json::from_value::<HarnessExecutionWriteResult>(value).unwrap(),
            saved
        );

        let conflict = HarnessExecutionWriteResult::Conflict {
            expected_revision: 3,
            actual_revision: 5,
        };
        let value = serde_json::to_value(&conflict).unwrap();
        assert_eq!(value["kind"], "conflict");
        assert_eq!(value["actualRevision"], 5);
    }

    #[test]
    fn harness_turn_state_defaults_plan_and_execution_to_absent() {
        let state = HarnessTurnState {
            proposals: Vec::new(),
            diagnostics: None,
            execution_plan: None,
            execution: None,
        };
        let value = serde_json::to_value(&state).unwrap();
        assert!(value.get("proposals").is_none());
        assert!(value.get("diagnostics").is_none());
        assert!(value.get("executionPlan").is_none());
        assert!(value.get("execution").is_none());
        // A legacy state with only proposals/diagnostics still loads.
        let legacy = serde_json::json!({
            "proposals": [],
            "diagnostics": { "modelSteps": 1, "toolCalls": 0, "validationRetries": 0 }
        });
        let loaded: HarnessTurnState = serde_json::from_value(legacy).unwrap();
        assert!(loaded.execution_plan.is_none());
        assert!(loaded.execution.is_none());
        assert_eq!(loaded.diagnostics.unwrap().model_steps, 1);
    }
}
