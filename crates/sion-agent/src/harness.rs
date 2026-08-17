//! Bounded, provider-neutral multi-step Harness loop.
//!
//! The loop drives `Model -> Tool -> Result -> Model` steps through an injected
//! provider adapter and injected typed tool executor, so `sion-agent` stays
//! independent of Tauri/storage paths. It enforces model-step, tool-call,
//! validation-retry, token, wall-clock, duplicate-call, and cancellation limits;
//! when a limit is reached it makes one final no-tools completion request and
//! never applies any proposal itself.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use sion_core::{
    HarnessDiagnostics, HarnessLimitKind, HarnessModelStepReason, HarnessProposal, HarnessToolCall,
    HarnessToolDefinition, HarnessToolStatus, ModelCallCategory, ModelCallStatus, ModelCallUsage,
    ProviderTokenUsage, ReasoningEffort, SanitizedToolTrace, TokenUsageSource, TurnTokenUsage,
    estimate_input_tokens,
};
use tokio_util::sync::CancellationToken;

use crate::model_protocol::{ModelRequest, ProtocolMessage, ToolChoice};

/// Normalized result of one executed tool call. `ready_proposal` is set when a
/// proposal tool produced a reviewable candidate.
#[derive(Debug, Clone)]
pub struct HarnessToolResult {
    pub call_id: String,
    pub name: String,
    pub content: String,
    pub summary: String,
    pub status: HarnessToolStatus,
    pub ready_proposal: Option<HarnessProposal>,
}

/// A safe, bounded batch-validation error. Never contains raw tool JSON, paths,
/// or internal details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessToolBatchError {
    pub message: String,
}

/// Injected typed tool executor. `validate_batch` checks every call in a batch
/// against the frozen scope before any executes; write-proposal calls run
/// sequentially, independent reads may run concurrently. The loop never calls
/// a save function itself.
pub trait HarnessToolExecutor: Send + Sync {
    fn tool_definitions(&self) -> Vec<HarnessToolDefinition>;
    fn validate_batch(&self, calls: &[HarnessToolCall]) -> Result<(), HarnessToolBatchError>;
    fn is_write_proposal(&self, call: &HarnessToolCall) -> bool;
    fn execute(&self, call: &HarnessToolCall) -> HarnessToolResult;
    fn validation_retries(&self) -> u32;
}

/// Normalized outcome of one provider step.
#[derive(Debug, Clone)]
pub struct HarnessModelStep {
    pub reason: HarnessModelStepReason,
    pub output: String,
    pub reasoning_summary: Vec<String>,
    pub tool_calls: Vec<HarnessToolCall>,
    pub usage: Option<ProviderTokenUsage>,
}

/// Safe provider-step failure (never raw provider bodies or headers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessStepError {
    pub message: String,
}

/// Injected provider adapter. Both Chat Completions and OpenAI Responses are
/// normalized to this shape; the loop never branches on the provider protocol.
/// The boxed future keeps the trait dyn-compatible.
pub trait HarnessModelClient: Send + Sync {
    fn step<'a>(
        &'a self,
        request: &'a ModelRequest,
        cancellation: CancellationToken,
        on_delta: &'a mut (dyn FnMut(StreamDelta) + Send),
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HarnessModelStep, HarnessStepError>> + Send + 'a>,
    >;
}

use crate::model_stream::StreamDelta;

/// Observer for visible/public events emitted during a turn. Only safe public
/// values cross this boundary: text deltas, public reasoning summaries, and
/// sanitized tool activities.
pub trait HarnessObserver: Send + Sync {
    fn on_text_delta(&self, delta: &str);
    fn on_reasoning_delta(&self, delta: &str);
    fn on_tool_activity(&self, call_id: &str, name: &str, status: HarnessToolStatus, summary: &str);
}

/// Inputs for one Harness turn run.
pub struct HarnessRunInput {
    pub model: String,
    pub context_window_tokens: u64,
    pub initial_messages: Vec<ProtocolMessage>,
    pub reasoning_effort: ReasoningEffort,
    pub request_public_reasoning_summary: bool,
}

/// Outcome of a completed Harness turn.
#[derive(Debug, Clone)]
pub struct HarnessRunOutcome {
    pub assistant_message: String,
    pub reasoning_summary: Option<String>,
    pub model_steps: u32,
    pub tool_calls: u32,
    pub ready_proposals: Vec<HarnessProposal>,
    pub usage: TurnTokenUsage,
    pub diagnostics: HarnessDiagnostics,
}

/// Terminal result of a Harness turn. Proposals are always left unapplied; only
/// the caller (user-approved resolution) may persist document content.
#[derive(Debug, Clone)]
pub enum HarnessTurnResult {
    Completed(HarnessRunOutcome),
    Cancelled {
        usage: TurnTokenUsage,
        diagnostics: HarnessDiagnostics,
    },
    Failed {
        error: String,
        usage: TurnTokenUsage,
        diagnostics: HarnessDiagnostics,
    },
}

struct TurnBudget {
    model_steps: u32,
    tool_calls: u32,
    estimated_input_tokens: u64,
    wall_clock_ms: u64,
    limit_reached: Option<HarnessLimitKind>,
}

/// Drives one bounded Harness turn. Construct once per turn with the frozen
/// input; `run` returns a terminal result.
pub struct HarnessRunner<'a> {
    provider: &'a dyn HarnessModelClient,
    tools: Arc<dyn HarnessToolExecutor + Send + Sync + 'a>,
    input: HarnessRunInput,
    limits: sion_core::HarnessLimits,
    cancellation: CancellationToken,
    now: Arc<dyn Fn() -> String + Send + Sync>,
    started: Instant,
}

impl<'a> HarnessRunner<'a> {
    pub fn new(
        provider: &'a dyn HarnessModelClient,
        tools: Arc<dyn HarnessToolExecutor + Send + Sync + 'a>,
        input: HarnessRunInput,
        limits: sion_core::HarnessLimits,
        cancellation: CancellationToken,
        now: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            provider,
            tools,
            input,
            limits,
            cancellation,
            now,
            started: Instant::now(),
        }
    }

    pub async fn run(self, observer: &dyn HarnessObserver, turn_id: &str) -> HarnessTurnResult {
        let mut messages = self.input.initial_messages.clone();
        let mut budget = TurnBudget {
            model_steps: 0,
            tool_calls: 0,
            estimated_input_tokens: 0,
            wall_clock_ms: 0,
            limit_reached: None,
        };
        let mut usage_calls: Vec<ModelCallUsage> = Vec::new();
        let mut ready_proposals: Vec<HarnessProposal> = Vec::new();
        let mut tool_traces: Vec<SanitizedToolTrace> = Vec::new();
        let mut executed_calls: HashSet<(String, String)> = HashSet::new();
        let mut reasoning_parts: Vec<String> = Vec::new();

        loop {
            if self.cancellation.is_cancelled() {
                let usage = build_turn_usage(turn_id, usage_calls);
                let diagnostics = self.diagnostics(&budget, tool_traces.clone());
                return HarnessTurnResult::Cancelled { usage, diagnostics };
            }
            budget.wall_clock_ms = self.started.elapsed().as_millis() as u64;
            if budget.wall_clock_ms > self.limits.max_wall_clock_ms {
                budget.limit_reached = Some(HarnessLimitKind::WallClock);
                return self
                    .finish_with_limit(messages.as_mut_slice(), &budget, usage_calls, ready_proposals, observer)
                    .await;
            }
            if budget.model_steps >= self.limits.max_model_steps {
                budget.limit_reached = Some(HarnessLimitKind::ModelSteps);
                return self
                    .finish_with_limit(messages.as_mut_slice(), &budget, usage_calls, ready_proposals, observer)
                    .await;
            }

            let request = ModelRequest::harness(
                self.input.model.clone(),
                messages.clone(),
                self.tools.tool_definitions(),
                ToolChoice::Auto,
                self.input.reasoning_effort,
                self.input.request_public_reasoning_summary,
            );
            let request_input_tokens = estimate_input_tokens(&request_estimate_text(&request));
            if budget.estimated_input_tokens.saturating_add(request_input_tokens)
                > self.input.context_window_tokens
            {
                budget.limit_reached = Some(HarnessLimitKind::Tokens);
                return self
                    .finish_with_limit(messages.as_mut_slice(), &budget, usage_calls, ready_proposals, observer)
                    .await;
            }
            budget.estimated_input_tokens =
                budget.estimated_input_tokens.saturating_add(request_input_tokens);

            budget.model_steps += 1;
            let category = if budget.model_steps <= 1 {
                ModelCallCategory::Answer
            } else {
                ModelCallCategory::ToolPlanning
            };
            let step = self
                .provider
                .step(&request, self.cancellation.clone(), &mut |delta| {
                    match &delta {
                        StreamDelta::OutputText(text) => {
                            observer.on_text_delta(text);
                        }
                        StreamDelta::ReasoningSummary(text) => {
                            reasoning_parts.push(text.clone());
                            observer.on_reasoning_delta(text);
                        }
                        StreamDelta::ToolCallDelta { .. } => {}
                    }
                })
                .await;
            match step {
                Err(error) => {
                    usage_calls.push(model_call_usage(
                        &format!("{}:step-{}", turn_id, budget.model_steps),
                        self.input.model.as_str(),
                        category,
                        ModelCallStatus::Failed,
                        None,
                        "",
                        "",
                    ));
                    let usage = build_turn_usage(turn_id, usage_calls);
                    let diagnostics = self.diagnostics(&budget, tool_traces.clone());
                    return HarnessTurnResult::Failed {
                        error: error.message,
                        usage,
                        diagnostics,
                    };
                }
                Ok(step) => {
                    usage_calls.push(model_call_usage(
                        &format!("{}:step-{}", turn_id, budget.model_steps),
                        self.input.model.as_str(),
                        category,
                        ModelCallStatus::Completed,
                        step.usage,
                        &request_estimate_text(&request),
                        &step.output,
                    ));
                    match step.reason {
                        HarnessModelStepReason::FinalResponse => {
                            let usage = build_turn_usage(turn_id, usage_calls);
                            let diagnostics = self.diagnostics(&budget, tool_traces.clone());
                            let outcome = HarnessRunOutcome {
                                assistant_message: step.output.clone(),
                                reasoning_summary: join_public(&step.reasoning_summary)
                                    .or_else(|| join_public(&reasoning_parts)),
                                model_steps: budget.model_steps,
                                tool_calls: budget.tool_calls,
                                ready_proposals,
                                usage,
                                diagnostics,
                            };
                            return HarnessTurnResult::Completed(outcome);
                        }
                        HarnessModelStepReason::ToolCalls => {
                            let next_tool_total = budget
                                .tool_calls
                                .saturating_add(step.tool_calls.len() as u32);
                            if next_tool_total > self.limits.max_tool_calls {
                                budget.limit_reached = Some(HarnessLimitKind::ToolCalls);
                                return self
                                    .finish_with_limit(
                                        messages.as_mut_slice(),
                                        &budget,
                                        usage_calls,
                                        ready_proposals,
                                        observer,
                                    )
                                    .await;
                            }
                            if let Some(duplicate) = step.tool_calls.iter().find(|call| {
                                executed_calls.contains(&(
                                    call.name.clone(),
                                    canonicalize_arguments(&call.arguments),
                                ))
                            }) {
                                budget.tool_calls = budget
                                    .tool_calls
                                    .saturating_add(step.tool_calls.len() as u32);
                                budget.limit_reached = Some(HarnessLimitKind::DuplicateCall);
                                let _ = duplicate;
                                return self
                                    .finish_with_limit(
                                        messages.as_mut_slice(),
                                        &budget,
                                        usage_calls,
                                        ready_proposals,
                                        observer,
                                    )
                                    .await;
                            }
                            // Record the batch before execution; a batch that
                            // fails validation still counts against the budget.
                            budget.tool_calls =
                                budget.tool_calls.saturating_add(step.tool_calls.len() as u32);
                            // Attach the assistant tool-call message first.
                            messages.push(ProtocolMessage::assistant_with_tool_calls(
                                step.output.clone(),
                                step.tool_calls.clone(),
                            ));
                            // Validate the entire batch before executing any
                            // call; a failed batch is refused as a whole.
                            if let Err(error) = self.tools.validate_batch(&step.tool_calls) {
                                for call in &step.tool_calls {
                                    messages.push(ProtocolMessage::tool(
                                        call.id.clone(),
                                        format!("批量校验未通过：{}", error.message),
                                    ));
                                }
                                continue;
                            }
                            for call in &step.tool_calls {
                                executed_calls.insert((
                                    call.name.clone(),
                                    canonicalize_arguments(&call.arguments),
                                ));
                            }
                            // run_tool_batch returns results in provider order.
                            let results = self.run_tool_batch(&step.tool_calls);
                            for result in &results {
                                if let Some(proposal) = &result.ready_proposal
                                    && !ready_proposals
                                        .iter()
                                        .any(|existing| existing.id == proposal.id)
                                {
                                    ready_proposals.push(proposal.clone());
                                }
                                let trace_at = (self.now)();
                                tool_traces.push(SanitizedToolTrace {
                                    call_id: result.call_id.clone(),
                                    name: result.name.clone(),
                                    status: result.status,
                                    summary: result.summary.clone(),
                                    started_at: trace_at.clone(),
                                    finished_at: trace_at,
                                });
                                observer.on_tool_activity(
                                    &result.call_id,
                                    &result.name,
                                    result.status,
                                    &result.summary,
                                );
                                messages.push(ProtocolMessage::tool(
                                    result.call_id.clone(),
                                    result.content.clone(),
                                ));
                            }
                            continue;
                        }
                        HarnessModelStepReason::Cancelled => {
                            let usage = build_turn_usage(turn_id, usage_calls);
                            let diagnostics = self.diagnostics(&budget, tool_traces.clone());
                            return HarnessTurnResult::Cancelled { usage, diagnostics };
                        }
                        HarnessModelStepReason::LimitReached => {
                            budget.limit_reached = Some(HarnessLimitKind::ModelSteps);
                            return self
                                .finish_with_limit(
                                    messages.as_mut_slice(),
                                    &budget,
                                    usage_calls,
                                    ready_proposals,
                                    observer,
                                )
                                .await;
                        }
                        HarnessModelStepReason::Failed => {
                            let usage = build_turn_usage(turn_id, usage_calls);
                            let diagnostics = self.diagnostics(&budget, tool_traces.clone());
                            return HarnessTurnResult::Failed {
                                error: "模型步骤失败".to_string(),
                                usage,
                                diagnostics,
                            };
                        }
                    }
                }
            }
        }
    }

    /// Executes a validated tool batch. The whole batch has already passed
    /// policy validation; write-proposal calls run sequentially and independent
    /// reads execute in provider order. Results are returned in provider order;
    /// after cancellation no new result is emitted by the caller.
    fn run_tool_batch(&self, calls: &[HarnessToolCall]) -> Vec<HarnessToolResult> {
        calls.iter().map(|call| self.tools.execute(call)).collect()
    }

    /// Issues one final no-tools completion request asking for a concise
    /// conclusion. If it fails, the turn ends with a safe error and all
    /// proposals still unapplied.
    async fn finish_with_limit(
        &self,
        messages: &mut [ProtocolMessage],
        budget: &TurnBudget,
        usage_calls: Vec<ModelCallUsage>,
        ready_proposals: Vec<HarnessProposal>,
        observer: &dyn HarnessObserver,
    ) -> HarnessTurnResult {
        let mut final_messages = messages.to_vec();
        final_messages.push(ProtocolMessage::user(
            "已到达本轮限制，请直接给出简洁的中文结论总结，不要再调用任何工具。",
        ));
        let request = ModelRequest::harness(
            self.input.model.clone(),
            final_messages,
            Vec::new(),
            ToolChoice::None,
            self.input.reasoning_effort,
            self.input.request_public_reasoning_summary,
        );
        let mut reasoning_parts = Vec::new();
        let final_step = self
            .provider
            .step(&request, self.cancellation.clone(), &mut |delta| {
                if let StreamDelta::ReasoningSummary(text) = delta {
                    observer.on_reasoning_delta(&text);
                    reasoning_parts.push(text);
                }
            })
            .await;
        let mut usage_calls = usage_calls;
        usage_calls.push(model_call_usage(
            &format!("{}:limit", request.model),
            self.input.model.as_str(),
            ModelCallCategory::Answer,
            match &final_step {
                Ok(_) => ModelCallStatus::Completed,
                Err(_) => ModelCallStatus::Failed,
            },
            None,
            &request_estimate_text(&request),
            &final_step
                .as_ref()
                .map(|step| step.output.clone())
                .unwrap_or_default(),
        ));
        match final_step {
            Ok(step) => {
                for text in &step.reasoning_summary {
                    observer.on_reasoning_delta(text);
                }
                let usage = build_turn_usage(&request.model, usage_calls);
                let outcome = HarnessRunOutcome {
                    assistant_message: step.output.clone(),
                    reasoning_summary: join_public(&reasoning_parts),
                    model_steps: budget.model_steps,
                    tool_calls: budget.tool_calls,
                    ready_proposals,
                    usage,
                    diagnostics: self.diagnostics(budget, Vec::new()),
                };
                HarnessTurnResult::Completed(outcome)
            }
            Err(error) => {
                let usage = build_turn_usage(&request.model, usage_calls);
                HarnessTurnResult::Failed {
                    error: format!("{}；所有提案均未应用", error.message),
                    usage,
                    diagnostics: self.diagnostics(budget, Vec::new()),
                }
            }
        }
    }

    fn diagnostics(&self, budget: &TurnBudget, tool_traces: Vec<SanitizedToolTrace>) -> HarnessDiagnostics {
        HarnessDiagnostics {
            model_steps: budget.model_steps,
            tool_calls: budget.tool_calls,
            validation_retries: self.tools.validation_retries(),
            limit_reached: budget.limit_reached,
            tool_traces,
        }
    }
}

fn join_public(parts: &[String]) -> Option<String> {
    let joined = parts.concat();
    (!joined.trim().is_empty()).then_some(joined)
}

fn canonicalize_arguments(arguments: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(arguments) {
        Ok(value) => serde_json::to_string(&value).unwrap_or_else(|_| arguments.to_string()),
        Err(_) => arguments.to_string(),
    }
}

fn request_estimate_text(request: &ModelRequest) -> String {
    request
        .messages
        .iter()
        .map(|message| format!("{}:{}", message.role.as_str(), message.content))
        .collect::<Vec<_>>()
        .join("\n")
}

fn model_call_usage(
    call_id: &str,
    model: &str,
    category: ModelCallCategory,
    status: ModelCallStatus,
    exact: Option<ProviderTokenUsage>,
    input_text: &str,
    output_text: &str,
) -> ModelCallUsage {
    let (source, input_tokens, output_tokens, total_tokens) = exact
        .and_then(sion_core::normalize_provider_usage)
        .map(|usage| {
            (
                TokenUsageSource::Exact,
                usage.input_tokens,
                usage.output_tokens,
                usage.total_tokens,
            )
        })
        .unwrap_or_else(|| {
            let input_tokens = estimate_input_tokens(input_text);
            let output_tokens = estimate_input_tokens(output_text);
            (
                TokenUsageSource::Estimated,
                input_tokens,
                output_tokens,
                input_tokens.saturating_add(output_tokens),
            )
        });
    ModelCallUsage {
        id: call_id.to_string(),
        category,
        provider_id: String::new(),
        model: model.to_string(),
        source,
        status,
        input_tokens,
        output_tokens,
        total_tokens,
    }
}

fn build_turn_usage(turn_id: &str, calls: Vec<ModelCallUsage>) -> TurnTokenUsage {
    let mut input_tokens = 0_u64;
    let mut output_tokens = 0_u64;
    let mut total_tokens = 0_u64;
    let mut saw_exact = false;
    let mut saw_estimated = false;
    for call in &calls {
        input_tokens = input_tokens.saturating_add(call.input_tokens);
        output_tokens = output_tokens.saturating_add(call.output_tokens);
        total_tokens = total_tokens.saturating_add(call.total_tokens);
        match call.source {
            TokenUsageSource::Exact => saw_exact = true,
            TokenUsageSource::Estimated => saw_estimated = true,
            TokenUsageSource::Mixed => {
                saw_exact = true;
                saw_estimated = true;
            }
        }
    }
    let source = match (saw_exact, saw_estimated) {
        (true, true) => TokenUsageSource::Mixed,
        (false, true) => TokenUsageSource::Estimated,
        _ => TokenUsageSource::Exact,
    };
    TurnTokenUsage {
        turn_id: turn_id.to_string(),
        source,
        call_count: calls.len() as u32,
        calls,
        input_tokens,
        output_tokens,
        total_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_core::{HarnessLimits, HarnessProposalKind, HarnessProposalStatus, WorkflowNodeId};

    fn now() -> Arc<dyn Fn() -> String + Send + Sync> {
        Arc::new(|| "2026-08-17T00:00:00Z".to_string())
    }

    fn definition(name: &str) -> HarnessToolDefinition {
        HarnessToolDefinition {
            name: name.into(),
            description: String::new(),
            parameters: serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        }
    }

    struct FakeExecutor {
        definitions: Vec<HarnessToolDefinition>,
        results: std::sync::Mutex<std::collections::VecDeque<HarnessToolResult>>,
        retries: u32,
    }

    impl FakeExecutor {
        fn new(definitions: Vec<HarnessToolDefinition>, retries: u32) -> Self {
            Self {
                definitions,
                results: std::sync::Mutex::new(std::collections::VecDeque::new()),
                retries,
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
        fn validate_batch(
            &self,
            calls: &[HarnessToolCall],
        ) -> Result<(), HarnessToolBatchError> {
            if calls.iter().any(|call| call.name == "boom") {
                return Err(HarnessToolBatchError {
                    message: "批量校验失败".to_string(),
                });
            }
            Ok(())
        }
        fn is_write_proposal(&self, call: &HarnessToolCall) -> bool {
            call.name.starts_with("propose_") || call.name.starts_with("revise_")
        }
        fn execute(&self, call: &HarnessToolCall) -> HarnessToolResult {
            if call.name == "boom" {
                return HarnessToolResult {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    content: "校验失败".to_string(),
                    summary: "校验失败".to_string(),
                    status: HarnessToolStatus::Error,
                    ready_proposal: None,
                };
            }
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
            self.retries
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
    }

    impl HarnessModelClient for ScriptedProvider {
        fn step<'a>(
            &'a self,
            _request: &'a ModelRequest,
            _cancellation: CancellationToken,
            on_delta: &'a mut (dyn FnMut(StreamDelta) + Send),
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<HarnessModelStep, HarnessStepError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                let step = self.steps.lock().unwrap().pop_front().ok_or_else(|| {
                    HarnessStepError {
                        message: "没有更多脚本步骤".to_string(),
                    }
                })?;
                for text in &step.output.split_inclusive("…").collect::<Vec<_>>() {
                    if !text.is_empty() {
                        on_delta(StreamDelta::OutputText(text.to_string()));
                    }
                }
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

    fn input(messages: Vec<ProtocolMessage>) -> HarnessRunInput {
        HarnessRunInput {
            model: "model-1".into(),
            context_window_tokens: 128_000,
            initial_messages: messages,
            reasoning_effort: ReasoningEffort::Medium,
            request_public_reasoning_summary: true,
        }
    }

    fn final_step(output: &str) -> HarnessModelStep {
        HarnessModelStep {
            reason: HarnessModelStepReason::FinalResponse,
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
            reason: HarnessModelStepReason::ToolCalls,
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

    async fn run_one(
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

    #[tokio::test]
    async fn direct_answer_completes_in_one_step() {
        let result = run_one(
            ScriptedProvider::new(vec![final_step("直接回答")]),
            Arc::new(FakeExecutor::new(vec![], 0)),
            input(vec![ProtocolMessage::user("你好")]),
            HarnessLimits::default(),
        )
        .await;
        let HarnessTurnResult::Completed(outcome) = result else {
            panic!("expected completed");
        };
        assert_eq!(outcome.assistant_message, "直接回答");
        assert_eq!(outcome.model_steps, 1);
        assert_eq!(outcome.tool_calls, 0);
        assert!(outcome.ready_proposals.is_empty());
        assert_eq!(outcome.usage.calls.len(), 1);
    }

    #[tokio::test]
    async fn one_read_tool_feeds_the_next_model_step() {
        let executor = Arc::new(
            FakeExecutor::new(vec![definition("read_attachment")], 0)
                .queue(HarnessToolResult {
                    call_id: "call-1".into(),
                    name: "read_attachment".into(),
                    content: "附件正文".into(),
                    summary: "已读取附件".into(),
                    status: HarnessToolStatus::Completed,
                    ready_proposal: None,
                }),
        );
        let result = run_one(
            ScriptedProvider::new(vec![tool_step(vec![("call-1", "read_attachment")]), final_step("基于附件回答")]),
            executor,
            input(vec![ProtocolMessage::user("看附件")]),
            HarnessLimits::default(),
        )
        .await;
        let HarnessTurnResult::Completed(outcome) = result else {
            panic!("expected completed");
        };
        assert_eq!(outcome.assistant_message, "基于附件回答");
        assert_eq!(outcome.model_steps, 2);
        assert_eq!(outcome.tool_calls, 1);
    }

    #[tokio::test]
    async fn proactive_proposal_is_collected_but_never_applied() {
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
            reason: "r".into(),
            validation_summary: Some("+1".into()),
            created_at: "now".into(),
            resolved_at: None,
            latest_revision: None,
            latest_rule_digest: None,
        };
        let executor = Arc::new(
            FakeExecutor::new(
                vec![definition("propose_delivery_change")],
                0,
            )
            .queue(HarnessToolResult {
                call_id: "call-1".into(),
                name: "propose_delivery_change".into(),
                content: "已创建提案".into(),
                summary: "已准备交付提案".into(),
                status: HarnessToolStatus::Completed,
                ready_proposal: Some(proposal),
            }),
        );
        let result = run_one(
            ScriptedProvider::new(vec![tool_step(vec![("call-1", "propose_delivery_change")]), final_step("已生成提案")]),
            executor,
            input(vec![ProtocolMessage::user("补充目标")]),
            HarnessLimits::default(),
        )
        .await;
        let HarnessTurnResult::Completed(outcome) = result else {
            panic!("expected completed");
        };
        assert_eq!(outcome.ready_proposals.len(), 1);
        assert_eq!(outcome.ready_proposals[0].id, "proposal-1");
    }

    #[tokio::test]
    async fn parallel_reads_and_sequential_writes_preserve_provider_order() {
        let executor = Arc::new(
            FakeExecutor::new(
                vec![definition("read_attachment"), definition("propose_delivery_change")],
                0,
            )
            .queue(HarnessToolResult {
                call_id: "r1".into(),
                name: "read_attachment".into(),
                content: "A".into(),
                summary: "s".into(),
                status: HarnessToolStatus::Completed,
                ready_proposal: None,
            })
            .queue(HarnessToolResult {
                call_id: "w1".into(),
                name: "propose_delivery_change".into(),
                content: "ok".into(),
                summary: "s".into(),
                status: HarnessToolStatus::Completed,
                ready_proposal: None,
            })
            .queue(HarnessToolResult {
                call_id: "r2".into(),
                name: "read_attachment".into(),
                content: "B".into(),
                summary: "s".into(),
                status: HarnessToolStatus::Completed,
                ready_proposal: None,
            }),
        );
        // The provider emits reads around a write in one batch.
        let result = run_one(
            ScriptedProvider::new(vec![
                tool_step(vec![("r1", "read_attachment"), ("w1", "propose_delivery_change"), ("r2", "read_attachment")]),
                final_step("done"),
            ]),
            executor,
            input(vec![ProtocolMessage::user("并行调用")]),
            HarnessLimits::default(),
        )
        .await;
        let HarnessTurnResult::Completed(outcome) = result else {
            panic!("expected completed");
        };
        assert_eq!(outcome.assistant_message, "done");
        assert_eq!(outcome.tool_calls, 3);
    }

    #[tokio::test]
    async fn duplicate_calls_are_detected_and_counted_against_the_budget() {
        let executor = Arc::new(
            FakeExecutor::new(vec![definition("read_attachment")], 0)
                .queue(HarnessToolResult {
                    call_id: "call-1".into(),
                    name: "read_attachment".into(),
                    content: "A".into(),
                    summary: "s".into(),
                    status: HarnessToolStatus::Completed,
                    ready_proposal: None,
                })
                .queue(HarnessToolResult {
                    call_id: "call-2".into(),
                    name: "read_attachment".into(),
                    content: "B".into(),
                    summary: "s".into(),
                    status: HarnessToolStatus::Completed,
                    ready_proposal: None,
                })
                .queue(HarnessToolResult {
                    call_id: "call-3".into(),
                    name: "read_attachment".into(),
                    content: "C".into(),
                    summary: "s".into(),
                    status: HarnessToolStatus::Completed,
                    ready_proposal: None,
                }),
        );
        // First step reads once; the second step repeats the same call.
        let result = run_one(
            ScriptedProvider::new(vec![
                tool_step(vec![("call-1", "read_attachment")]),
                tool_step(vec![("call-2", "read_attachment")]),
                final_step("never reached"),
            ]),
            executor,
            input(vec![ProtocolMessage::user("重复调用")]),
            HarnessLimits::default(),
        )
        .await;
        let HarnessTurnResult::Completed(outcome) = result else {
            panic!("expected completed (limit final request)");
        };
        assert_eq!(outcome.diagnostics.limit_reached, Some(HarnessLimitKind::DuplicateCall));
        assert_eq!(outcome.diagnostics.tool_calls, 2);
    }

    #[tokio::test]
    async fn tool_budget_exhaustion_triggers_final_no_tools_completion() {
        let executor = Arc::new(FakeExecutor::new(vec![definition("read_attachment")], 0));
        let limits = HarnessLimits {
            max_tool_calls: 1,
            ..HarnessLimits::default()
        };
        let result = run_one(
            ScriptedProvider::new(vec![
                tool_step(vec![("call-1", "read_attachment"), ("call-2", "read_attachment")]),
                final_step("结论"),
            ]),
            executor,
            input(vec![ProtocolMessage::user("超预算")]),
            limits,
        )
        .await;
        let HarnessTurnResult::Completed(outcome) = result else {
            panic!("expected completed");
        };
        assert_eq!(outcome.diagnostics.limit_reached, Some(HarnessLimitKind::ToolCalls));
        assert_eq!(outcome.assistant_message, "结论");
    }

    #[tokio::test]
    async fn provider_failure_after_ready_proposal_keeps_proposals_unapplied() {
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
            reason: "r".into(),
            validation_summary: None,
            created_at: "now".into(),
            resolved_at: None,
            latest_revision: None,
            latest_rule_digest: None,
        };
        let executor = Arc::new(
            FakeExecutor::new(vec![definition("propose_delivery_change")], 0).queue(
                HarnessToolResult {
                    call_id: "call-1".into(),
                    name: "propose_delivery_change".into(),
                    content: "ok".into(),
                    summary: "s".into(),
                    status: HarnessToolStatus::Completed,
                    ready_proposal: Some(proposal),
                },
            ),
        );
        let mut steps = std::collections::VecDeque::new();
        steps.push_back(tool_step(vec![("call-1", "propose_delivery_change")]));
        steps.push_back(HarnessModelStep {
            reason: HarnessModelStepReason::Failed,
            output: String::new(),
            reasoning_summary: Vec::new(),
            tool_calls: Vec::new(),
            usage: None,
        });
        let provider = ScriptedProvider {
            steps: std::sync::Mutex::new(steps),
        };
        let result = run_one(
            provider,
            executor,
            input(vec![ProtocolMessage::user("生成提案后失败")]),
            HarnessLimits::default(),
        )
        .await;
        let HarnessTurnResult::Failed { error, .. } = result else {
            panic!("expected failed");
        };
        assert!(!error.is_empty());
    }

    #[tokio::test]
    async fn cancellation_stops_the_turn_before_tool_results() {
        struct CancellingProvider;
        impl HarnessModelClient for CancellingProvider {
            fn step<'a>(
                &'a self,
                _request: &'a ModelRequest,
                cancellation: CancellationToken,
                _on_delta: &'a mut (dyn FnMut(StreamDelta) + Send),
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<HarnessModelStep, HarnessStepError>,
                        > + Send
                        + 'a,
                >,
            > {
                Box::pin(async move {
                    cancellation.cancelled().await;
                    Ok(HarnessModelStep {
                        reason: HarnessModelStepReason::Cancelled,
                        output: String::new(),
                        reasoning_summary: Vec::new(),
                        tool_calls: Vec::new(),
                        usage: None,
                    })
                })
            }
        }

        let executor = Arc::new(FakeExecutor::new(vec![definition("read_attachment")], 0));
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        let provider = CancellingProvider;
        let task = tokio::spawn(async move {
            HarnessRunner::new(
                &provider,
                executor,
                input(vec![ProtocolMessage::user("取消")]),
                HarnessLimits::default(),
                token,
                now(),
            )
            .run(&NoopObserver, "turn-1")
            .await
        });
        // The provider blocks until cancellation; cancel the whole turn.
        tokio::task::yield_now().await;
        cancellation.cancel();
        let result = task.await.unwrap();
        assert!(matches!(result, HarnessTurnResult::Cancelled { .. }));
    }

    #[test]
    fn canonicalization_ignores_whitespace_and_key_order() {
        assert_eq!(
            canonicalize_arguments(r#"{ "b" : 1, "a" : 2 }"#),
            canonicalize_arguments(r#"{"a":2,"b":1}"#)
        );
        assert_eq!(
            canonicalize_arguments("not json"),
            "not json"
        );
    }

    #[test]
    fn usage_aggregation_marks_mixed_sources() {
        let calls = vec![
            model_call_usage(
                "c1",
                "m",
                ModelCallCategory::Answer,
                ModelCallStatus::Completed,
                None,
                "in",
                "out",
            ),
            model_call_usage(
                "c2",
                "m",
                ModelCallCategory::ToolPlanning,
                ModelCallStatus::Completed,
                Some(ProviderTokenUsage {
                    input_tokens: 5,
                    output_tokens: 2,
                    total_tokens: 7,
                }),
                "in",
                "out",
            ),
        ];
        let usage = build_turn_usage("t", calls);
        assert_eq!(usage.source, TokenUsageSource::Mixed);
        assert_eq!(usage.call_count, 2);
        assert_eq!(usage.total_tokens, usage.input_tokens + usage.output_tokens);
    }
}
