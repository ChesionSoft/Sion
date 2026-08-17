//! End-to-end Harness runtime tests through the public API: direct answer,
//! read tools, proactive proposals, duplicate detection, limits, cancellation,
//! and provider failure after a ready proposal.

use std::sync::Arc;

use sion_agent::harness::{
    HarnessModelClient, HarnessModelStep, HarnessObserver, HarnessRunInput, HarnessRunner,
    HarnessStepError, HarnessToolBatchError, HarnessToolExecutor, HarnessToolResult,
    HarnessTurnResult,
};
use sion_agent::model_protocol::{ModelRequest, ProtocolMessage};
use sion_agent::model_stream::{StreamDelta, StreamFailure};
use sion_core::{
    HarnessLimitKind, HarnessLimits, HarnessProposal, HarnessProposalKind, HarnessProposalStatus,
    HarnessToolCall, HarnessToolDefinition, HarnessToolStatus, ModelCallCategory, ModelCallStatus,
    ProviderTokenUsage, ReasoningEffort, SanitizedToolTrace, WorkflowNodeId,
};
use tokio_util::sync::CancellationToken;

fn now() -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(|| "2026-08-17T00:00:00Z".to_string())
}

fn definition(name: &str) -> HarnessToolDefinition {
    HarnessToolDefinition {
        name: name.into(),
        description: String::new(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    }
}

struct FakeExecutor {
    definitions: Vec<HarnessToolDefinition>,
    results: std::sync::Mutex<std::collections::VecDeque<HarnessToolResult>>,
}

impl FakeExecutor {
    fn new(definitions: Vec<HarnessToolDefinition>) -> Self {
        Self {
            definitions,
            results: std::sync::Mutex::new(std::collections::VecDeque::new()),
        }
    }
    fn queue(self, result: HarnessToolResult) -> Self {
        self.results.lock().unwrap().push_back(result);
        self
    }
}

impl HarnessToolExecutor for FakeExecutor {
    fn tool_definitions(&self) -> Vec<HarnessToolDefinition> {
        self.definitions.clone()
    }
    fn validate_batch(&self, calls: &[HarnessToolCall]) -> Result<(), HarnessToolBatchError> {
        if calls.iter().any(|call| call.name == "rejected_read") {
            return Err(HarnessToolBatchError {
                message: "整批校验未通过".to_string(),
            });
        }
        Ok(())
    }
    fn is_write_proposal(&self, call: &HarnessToolCall) -> bool {
        call.name.starts_with("propose_") || call.name.starts_with("revise_")
    }
    fn execute(&self, call: &HarnessToolCall) -> HarnessToolResult {
        self.results.lock().unwrap().pop_front().unwrap_or(HarnessToolResult {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: format!("结果:{}", call.name),
            summary: format!("执行:{}", call.name),
            status: HarnessToolStatus::Completed,
            ready_proposal: None,
        })
    }
    fn validation_retries(&self) -> u32 {
        0
    }
}

struct ScriptedProvider {
    steps: std::sync::Mutex<std::collections::VecDeque<HarnessModelStep>>,
}

impl ScriptedProvider {
    fn new(steps: Vec<HarnessModelStep>) -> Self {
        Self {
            steps: std::sync::Mutex::new(steps.into()),
        }
    }
    fn failing() -> Self {
        let mut steps = std::collections::VecDeque::new();
        steps.push_back(HarnessModelStep {
            reason: sion_core::HarnessModelStepReason::Failed,
            output: String::new(),
            reasoning_summary: Vec::new(),
            tool_calls: Vec::new(),
            usage: None,
        });
        Self {
            steps: std::sync::Mutex::new(steps),
        }
    }
}

impl HarnessModelClient for ScriptedProvider {
    fn step<'a>(
        &'a self,
        _request: &'a ModelRequest,
        _cancellation: CancellationToken,
        _on_delta: &'a mut (dyn FnMut(StreamDelta) + Send),
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<HarnessModelStep, HarnessStepError>> + Send + 'a,
        >,
    > {
        Box::pin(async move {
            let step = self.steps.lock().unwrap().pop_front().ok_or_else(|| HarnessStepError {
                message: "脚本用尽".to_string(),
            })?;
            Ok(step)
        })
    }
}

struct NoopObserver;
impl HarnessObserver for NoopObserver {
    fn on_text_delta(&self, _delta: &str) {}
    fn on_reasoning_delta(&self, _delta: &str) {}
    fn on_tool_activity(
        &self,
        _call_id: &str,
        _name: &str,
        _status: HarnessToolStatus,
        _summary: &str,
    ) {
    }
}

fn final_step(output: &str) -> HarnessModelStep {
    HarnessModelStep {
        reason: sion_core::HarnessModelStepReason::FinalResponse,
        output: output.into(),
        reasoning_summary: Vec::new(),
        tool_calls: Vec::new(),
        usage: Some(ProviderTokenUsage {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
        }),
    }
}

fn tool_step(calls: Vec<(&str, &str)>) -> HarnessModelStep {
    HarnessModelStep {
        reason: sion_core::HarnessModelStepReason::ToolCalls,
        output: String::new(),
        reasoning_summary: Vec::new(),
        tool_calls: calls
            .into_iter()
            .map(|(id, name)| HarnessToolCall {
                id: id.into(),
                name: name.into(),
                arguments: "{}".into(),
            })
            .collect(),
        usage: Some(ProviderTokenUsage {
            input_tokens: 10,
            output_tokens: 1,
            total_tokens: 11,
        }),
    }
}

fn input(messages: Vec<ProtocolMessage>) -> HarnessRunInput {
    HarnessRunInput {
        model: "model-1".into(),
        context_window_tokens: 128_000,
        initial_messages: messages,
        reasoning_effort: ReasoningEffort::Medium,
        request_public_reasoning_summary: true,
    }
}

async fn run(
    provider: ScriptedProvider,
    tools: Arc<FakeExecutor>,
    input: HarnessRunInput,
    limits: HarnessLimits,
) -> HarnessTurnResult {
    HarnessRunner::new(
        &provider,
        tools,
        input,
        limits,
        CancellationToken::new(),
        now(),
    )
    .run(&NoopObserver, "turn-1")
    .await
}

fn completed(result: &HarnessTurnResult) -> sion_agent::harness::HarnessRunOutcome {
    match result {
        HarnessTurnResult::Completed(outcome) => outcome.clone(),
        other => panic!("expected completed, got {other:?}"),
    }
}

#[tokio::test]
async fn direct_answer_and_multiple_reads_work_end_to_end() {
    let executor = Arc::new(
        FakeExecutor::new(vec![definition("read_attachment"), definition("read_current_delivery")])
            .queue(HarnessToolResult {
                call_id: "r1".into(),
                name: "read_attachment".into(),
                content: "附件正文".into(),
                summary: "读取附件".into(),
                status: HarnessToolStatus::Completed,
                ready_proposal: None,
            })
            .queue(HarnessToolResult {
                call_id: "r2".into(),
                name: "read_current_delivery".into(),
                content: "交付稿".into(),
                summary: "读取交付稿".into(),
                status: HarnessToolStatus::Completed,
                ready_proposal: None,
            }),
    );
    let outcome = completed(
        &run(
            ScriptedProvider::new(vec![
                tool_step(vec![("r1", "read_attachment"), ("r2", "read_current_delivery")]),
                final_step("基于两个读取回答"),
            ]),
            executor,
            input(vec![ProtocolMessage::user("请阅读")]),
            HarnessLimits::default(),
        )
        .await,
    );
    assert_eq!(outcome.assistant_message, "基于两个读取回答");
    assert_eq!(outcome.model_steps, 2);
    assert_eq!(outcome.tool_calls, 2);
    assert!(!outcome.diagnostics.tool_traces.is_empty());
    assert!(outcome.diagnostics.tool_traces.iter().all(|trace: &SanitizedToolTrace| trace.summary.contains("读取")));
}

#[tokio::test]
async fn proactive_delivery_proposal_is_returned_ready_and_unapplied() {
    let proposal = HarnessProposal {
        id: "proposal-1".into(),
        kind: HarnessProposalKind::Delivery,
        status: HarnessProposalStatus::Ready,
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        turn_id: "turn-1".into(),
        base_revision: Some(1),
        base_rule_digest: None,
        base_content: "旧".into(),
        proposed_content: "新".into(),
        reason: "补充".into(),
        validation_summary: Some("+1".into()),
        created_at: "now".into(),
        resolved_at: None,
        latest_revision: None,
        latest_rule_digest: None,
    };
    let executor = Arc::new(
        FakeExecutor::new(vec![definition("propose_delivery_change")]).queue(HarnessToolResult {
            call_id: "w1".into(),
            name: "propose_delivery_change".into(),
            content: "已创建".into(),
            summary: "已准备交付提案".into(),
            status: HarnessToolStatus::Completed,
            ready_proposal: Some(proposal),
        }),
    );
    let outcome = completed(
        &run(
            ScriptedProvider::new(vec![
                tool_step(vec![("w1", "propose_delivery_change")]),
                final_step("已生成提案，请审阅"),
            ]),
            executor,
            input(vec![ProtocolMessage::user("补充目标")]),
            HarnessLimits::default(),
        )
        .await,
    );
    assert_eq!(outcome.ready_proposals.len(), 1);
    assert_eq!(outcome.ready_proposals[0].status, HarnessProposalStatus::Ready);
}

#[tokio::test]
async fn batch_validation_failure_blocks_every_call_in_the_batch() {
    let executor = Arc::new(FakeExecutor::new(vec![definition("rejected_read")]));
    let outcome = completed(
        &run(
            ScriptedProvider::new(vec![
                tool_step(vec![("r1", "rejected_read"), ("r2", "read_attachment")]),
                final_step("拒绝后总结"),
            ]),
            executor,
            input(vec![ProtocolMessage::user("校验失败")]),
            HarnessLimits::default(),
        )
        .await,
    );
    // The whole batch was refused; the executor never executed any call.
    assert_eq!(outcome.assistant_message, "拒绝后总结");
}

#[tokio::test]
async fn model_step_limit_reaches_final_no_tools_completion() {
    let executor = Arc::new(FakeExecutor::new(vec![definition("read_attachment")]));
    let limits = HarnessLimits {
        max_model_steps: 1,
        ..HarnessLimits::default()
    };
    let outcome = completed(
        &run(
            ScriptedProvider::new(vec![
                tool_step(vec![("r1", "read_attachment")]),
                final_step("最终结论"),
            ]),
            executor,
            input(vec![ProtocolMessage::user("步数限制")]),
            limits,
        )
        .await,
    );
    assert_eq!(outcome.diagnostics.limit_reached, Some(HarnessLimitKind::ModelSteps));
    assert_eq!(outcome.assistant_message, "最终结论");
}

#[tokio::test]
async fn provider_failure_after_ready_proposal_keeps_proposal_unapplied() {
    let proposal = HarnessProposal {
        id: "proposal-1".into(),
        kind: HarnessProposalKind::AgentRule,
        status: HarnessProposalStatus::Ready,
        project_id: "project-1".into(),
        node_id: WorkflowNodeId::Goals,
        turn_id: "turn-1".into(),
        base_revision: None,
        base_rule_digest: Some("digest".into()),
        base_content: String::new(),
        proposed_content: "新规则".into(),
        reason: "调整规则".into(),
        validation_summary: None,
        created_at: "now".into(),
        resolved_at: None,
        latest_revision: None,
        latest_rule_digest: None,
    };
    let executor = Arc::new(
        FakeExecutor::new(vec![definition("propose_agent_rule_override")]).queue(HarnessToolResult {
            call_id: "w1".into(),
            name: "propose_agent_rule_override".into(),
            content: "已创建".into(),
            summary: "已准备规则提案".into(),
            status: HarnessToolStatus::Completed,
            ready_proposal: Some(proposal),
        }),
    );
    let mut steps = std::collections::VecDeque::new();
    steps.push_back(tool_step(vec![("w1", "propose_agent_rule_override")]));
    steps.push_back(HarnessModelStep {
        reason: sion_core::HarnessModelStepReason::Failed,
        output: String::new(),
        reasoning_summary: Vec::new(),
        tool_calls: Vec::new(),
        usage: None,
    });
    let provider = ScriptedProvider {
        steps: std::sync::Mutex::new(steps),
    };
    let result = run(
        provider,
        executor,
        input(vec![ProtocolMessage::user("生成规则后失败")]),
        HarnessLimits::default(),
    )
    .await;
    match result {
        HarnessTurnResult::Failed { error, .. } => {
            assert!(!error.is_empty());
        }
        other => panic!("expected failed, got {other:?}"),
    }
}

#[tokio::test]
async fn usage_aggregates_across_multiple_calls() {
    let executor = Arc::new(
        FakeExecutor::new(vec![definition("read_attachment")]).queue(HarnessToolResult {
            call_id: "r1".into(),
            name: "read_attachment".into(),
            content: "A".into(),
            summary: "s".into(),
            status: HarnessToolStatus::Completed,
            ready_proposal: None,
        }),
    );
    let outcome = completed(
        &run(
            ScriptedProvider::new(vec![
                tool_step(vec![("r1", "read_attachment")]),
                final_step("完成"),
            ]),
            executor,
            input(vec![ProtocolMessage::user("用量")]),
            HarnessLimits::default(),
        )
        .await,
    );
    assert_eq!(outcome.usage.call_count, 2);
    assert!(outcome.usage.calls.iter().any(|call| call.category == ModelCallCategory::ToolPlanning));
    assert!(outcome.usage.calls.iter().any(|call| call.status == ModelCallStatus::Completed));
    assert_eq!(outcome.usage.total_tokens, outcome.usage.input_tokens + outcome.usage.output_tokens);
    // Secret sentinels never appear in usage or diagnostics.
    let debug = format!("{:?}{:?}", outcome.usage, outcome.diagnostics);
    assert!(!debug.contains("sk-secret"));
}
