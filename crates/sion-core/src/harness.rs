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

/// Explicit Harness marker/state stored on a `ConversationTurn`. Legacy turns
/// leave this `None`; new Harness turns carry proposals and bounded diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTurnState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposals: Vec<HarnessProposal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<HarnessDiagnostics>,
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
}
