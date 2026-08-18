//! Tauri-side orchestration for the bounded Harness loop.
//!
//! Starting a new node conversation schedules one `AgentRunKind::Harness` run,
//! freezes the trusted scope, persists only the approved start/end checkpoints,
//! streams dynamic public state through the existing transient events, and
//! never enqueues a fixed `DeliveryDecision` run. Proposal review after the
//! turn does not retain the model-run reservation; CAS/digest checks protect
//! later apply.

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use sion_agent::harness::{
    HarnessModelClient, HarnessModelStep, HarnessObserver, HarnessRunInput, HarnessRunner,
    HarnessStepError, HarnessToolBatchError, HarnessToolExecutor, HarnessToolResult,
    HarnessTurnResult,
};
use sion_agent::model_protocol::ModelRequest;
use sion_agent::model_stream::{ProviderProtocol, StreamDelta};
use sion_core::{
    ChatMessage, ChatRole, ConversationTurn, HarnessDiagnostics, HarnessLimits,
    HarnessExecutionPlan, HarnessExecutionRecord, HarnessExecutionStatus, HarnessExecutionWrite,
    HarnessModelStepReason, HarnessProposal, HarnessToolCall, HarnessToolDefinition,
    HarnessToolStatus, HarnessTurnState, ReasoningEffort, TurnActivity, TurnActivityKind,
    TurnActivityStatus, TurnStatus, WorkflowNodeId,
};
use tauri::Emitter;
use sion_storage::ProjectStore;
use tokio_util::sync::CancellationToken;

use crate::harness_proposals::ProposalService;
use crate::harness_scope::HarnessScope;
use crate::harness_tools::{HarnessToolRegistry, ToolError};
use crate::harness_execution::HarnessExecutionService;
use crate::provider_settings::ResolvedModel;
use crate::{
    AgentFinishedEvent, AgentReasoningSummaryEvent, AgentState, AgentTokenEvent,
    ConversationTurnEvent, elapsed_ms, utc_now,
};

fn is_read_tool(name: &str) -> bool {
    matches!(
        name,
        "list_project_attachments"
            | "read_attachment"
            | "list_dependency_sections"
            | "read_dependency_section"
            | "search_allowed_context"
            | "read_current_delivery"
            | "read_effective_agent_rule"
    )
}

fn is_proposal_tool(name: &str) -> bool {
    matches!(
        name,
        "request_delivery_execution"
            | "propose_agent_rule_override"
            | "revise_agent_rule_proposal"
            | "discard_agent_rule_proposal"
    )
}

fn is_execution_tool(name: &str) -> bool {
    crate::harness_execution::is_execution_write_tool(name)
}

fn tool_error_message(error: &ToolError) -> String {
    match error {
        ToolError::InvalidArguments(message) => format!("参数无效：{message}"),
        ToolError::Unauthorized(message) => format!("无权访问：{message}"),
        ToolError::NotFound(message) => format!("未找到：{message}"),
        ToolError::ReadFailed(message) => format!("读取失败：{message}"),
    }
}

/// Provider adapter that normalizes Chat Completions and OpenAI Responses
/// streams into the Harness loop's step model. Secret values never cross this
/// boundary; provider failures map to safe public messages.
pub(crate) struct HarnessProviderAdapter {
    client: reqwest::Client,
    resolved: ResolvedModel,
    protocol: ProviderProtocol,
}

impl HarnessModelClient for HarnessProviderAdapter {
    fn step<'a>(
        &'a self,
        request: &'a ModelRequest,
        cancellation: CancellationToken,
        on_delta: &'a mut (dyn FnMut(StreamDelta) + Send),
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<HarnessModelStep, HarnessStepError>> + Send + 'a,
        >,
    > {
        Box::pin(async move {
            let stream_request = sion_agent::model_stream::StreamRequest {
                endpoint: self.resolved.endpoint.clone(),
                api_key: self.resolved.api_key.clone(),
                protocol: self.protocol,
                request: request.clone(),
            };
            let outcome = sion_agent::model_stream::stream_text_with(
                &self.client,
                &stream_request,
                cancellation,
                &mut |delta: &StreamDelta| on_delta(delta.clone()),
            )
            .await;
            match outcome {
                Ok(sion_agent::model_stream::StreamOutcome::Completed(content)) => {
                    let reason = if content.tool_calls.is_empty() {
                        HarnessModelStepReason::FinalResponse
                    } else {
                        HarnessModelStepReason::ToolCalls
                    };
                    Ok(HarnessModelStep {
                        reason,
                        output: content.output.join(""),
                        reasoning_summary: content.reasoning_summary,
                        tool_calls: content.tool_calls,
                        usage: content.usage,
                    })
                }
                Ok(sion_agent::model_stream::StreamOutcome::Cancelled(_)) => {
                    Ok(HarnessModelStep {
                        reason: HarnessModelStepReason::Cancelled,
                        output: String::new(),
                        reasoning_summary: Vec::new(),
                        tool_calls: Vec::new(),
                        usage: None,
                    })
                }
                Err(error) => Err(HarnessStepError {
                    message: crate::turn_runtime::public_model_failure(&error),
                }),
            }
        })
    }
}

/// In-memory live state for a running Harness turn: dynamic activities and
/// reviewable proposals, emitted as turn snapshots but never persisted
/// mid-turn.
#[derive(Default)]
struct HarnessLiveState {
    activities: Vec<TurnActivity>,
    proposals: Vec<HarnessProposal>,
}

/// Bridges normalized loop events to the frontend: visible tokens and public
/// reasoning go to the existing transient streams; tool activities and ready
/// proposals are emitted as in-memory `ConversationTurn` snapshots.
struct HarnessEventBridge {
    app: tauri::AppHandle,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: String,
    turn_id: String,
    run_id: String,
    started_at: String,
    now: Arc<dyn Fn() -> String + Send + Sync>,
    live: Arc<Mutex<HarnessLiveState>>,
}

impl HarnessEventBridge {
    fn emit_turn_snapshot(&self) {
        let live = self.live.lock().unwrap();
        let turn = ConversationTurn {
            id: self.turn_id.clone(),
            project_id: self.project_id.clone(),
            node_id: self.node_id,
            session_id: self.session_id.clone(),
            run_id: self.run_id.clone(),
            user_message_id: String::new(),
            assistant_message_id: None,
            status: TurnStatus::Running,
            activities: live.activities.clone(),
            reasoning_summary: None,
            delivery_outcome: None,
            delivery_inspection: None,
            harness: Some(HarnessTurnState {
                proposals: live.proposals.clone(),
                diagnostics: None,
                execution_plan: None,
                execution: None,
            }),
            started_at: self.started_at.clone(),
            finished_at: None,
        };
        let _ = self.app.emit(
            "conversation-turn-updated",
            ConversationTurnEvent {
                turn,
                saved_node: None,
            },
        );
    }

    fn record_activity(&self, kind: TurnActivityKind, status: TurnActivityStatus, label: &str, summary: Option<&str>) {
        let now = (self.now)();
        let mut live = self.live.lock().unwrap();
        let activity_id = format!("{}-{}", kind.as_str(), live.activities.len());
        live.activities.push(TurnActivity {
            id: activity_id,
            kind,
            status,
            label: label.to_string(),
            public_summary: summary.map(ToString::to_string),
            started_at: Some(now.clone()),
            finished_at: (!matches!(
                status,
                TurnActivityStatus::Pending | TurnActivityStatus::Running
            ))
            .then_some(now),
        });
    }
}

impl HarnessObserver for HarnessEventBridge {
    fn on_text_delta(&self, delta: &str) {
        let _ = self.app.emit(
            "agent-token",
            AgentTokenEvent {
                run_id: self.run_id.clone(),
                project_id: self.project_id.clone(),
                node_id: self.node_id,
                session_id: self.session_id.clone(),
                delta: delta.to_string(),
            },
        );
    }

    fn on_reasoning_delta(&self, delta: &str) {
        let _ = self.app.emit(
            "agent-reasoning-summary",
            AgentReasoningSummaryEvent {
                run_id: self.run_id.clone(),
                project_id: self.project_id.clone(),
                node_id: self.node_id,
                session_id: self.session_id.clone(),
                delta: delta.to_string(),
            },
        );
    }

    fn on_tool_activity(
        &self,
        _call_id: &str,
        name: &str,
        status: HarnessToolStatus,
        summary: &str,
    ) {
        let (kind, label, activity_status) = if is_execution_tool(name) {
            (
                TurnActivityKind::DeliverySave,
                if status == HarnessToolStatus::Completed {
                    "已保存当前节点交付稿"
                } else {
                    "当前节点交付稿保存失败"
                },
                if status == HarnessToolStatus::Completed {
                    TurnActivityStatus::Completed
                } else {
                    TurnActivityStatus::Failed
                },
            )
        } else if is_proposal_tool(name) {
            (
                TurnActivityKind::Proposal,
                if status == HarnessToolStatus::Error {
                    "准备交付提案（校验失败，修正中）"
                } else {
                    "正在准备交付提案"
                },
                if status == HarnessToolStatus::Completed {
                    TurnActivityStatus::Completed
                } else if status == HarnessToolStatus::Error {
                    TurnActivityStatus::Failed
                } else {
                    TurnActivityStatus::Running
                },
            )
        } else if name == "search_allowed_context" {
            (
                TurnActivityKind::Search,
                "正在搜索授权的项目上下文",
                if status == HarnessToolStatus::Completed {
                    TurnActivityStatus::Completed
                } else {
                    TurnActivityStatus::Failed
                },
            )
        } else {
            (
                TurnActivityKind::ToolRead,
                "正在读取项目文档",
                if status == HarnessToolStatus::Completed {
                    TurnActivityStatus::Completed
                } else {
                    TurnActivityStatus::Failed
                },
            )
        };
        self.record_activity(kind, activity_status, label, Some(summary));
        self.emit_turn_snapshot();
    }
}

/// Typed tool executor that combines the read registry and the proposal
/// service behind the loop's trait. `ProposalService` mutates candidates, so it
/// is held behind a mutex; the loop never persists anything itself.
struct HarnessToolExecutorImpl<'a> {
    registry: Mutex<HarnessToolRegistry<'a>>,
    proposals: Option<Mutex<ProposalService<'a>>>,
    execution: Option<Mutex<HarnessExecutionService<'a>>>,
    store: &'a ProjectStore,
    execution_writes: Mutex<Vec<HarnessExecutionWrite>>,
    now: Arc<dyn Fn() -> String + Send + Sync>,
}

impl<'a> HarnessToolExecutorImpl<'a> {
    fn durable_proposals(&self, now: &str) -> Vec<HarnessProposal> {
        self.proposals
            .as_ref()
            .map(|proposals| proposals.lock().unwrap().durable_proposals(now))
            .unwrap_or_default()
    }

    fn execution_plan_candidate(
        &self,
        turn_id: &str,
        message_id: &str,
    ) -> Option<HarnessExecutionPlan> {
        self.proposals.as_ref()?.lock().unwrap().execution_plan_candidate(turn_id, message_id)
    }

    fn execution_writes(&self) -> Vec<HarnessExecutionWrite> {
        self.execution_writes.lock().unwrap().clone()
    }
}

impl HarnessToolExecutor for HarnessToolExecutorImpl<'_> {
    fn tool_definitions(&self) -> Vec<HarnessToolDefinition> {
        let mut tools = crate::harness_tools::tool_definitions();
        if self.execution.is_some() {
            tools.extend(crate::harness_execution::execution_tool_definitions());
        } else if let Some(proposals) = &self.proposals {
            let rule_authorized = proposals.lock().unwrap().rule_authorized();
            tools.extend(crate::harness_proposals::proposal_definitions(rule_authorized));
        }
        tools
    }

    fn validate_batch(&self, calls: &[HarnessToolCall]) -> Result<(), HarnessToolBatchError> {
        for call in calls {
            let result = if is_read_tool(&call.name) {
                self.registry.lock().unwrap().validate(call)
            } else if is_execution_tool(&call.name) {
                self.execution
                    .as_ref()
                    .ok_or_else(|| ToolError::Unauthorized("执行权限未启用".to_string()))
                    .and_then(|execution| execution.lock().unwrap().validate(call))
            } else if is_proposal_tool(&call.name) {
                self.proposals
                    .as_ref()
                    .ok_or_else(|| ToolError::Unauthorized("当前运行不支持提案工具".to_string()))
                    .and_then(|proposals| proposals.lock().unwrap().validate(call))
            } else {
                Err(ToolError::InvalidArguments(format!("未知工具：{}", call.name)))
            };
            if let Err(error) = result {
                return Err(HarnessToolBatchError {
                    message: tool_error_message(&error),
                });
            }
        }
        Ok(())
    }

    fn is_write_proposal(&self, call: &HarnessToolCall) -> bool {
        is_proposal_tool(&call.name) || is_execution_tool(&call.name)
    }

    fn execute(&self, call: &HarnessToolCall) -> HarnessToolResult {
        let (execution, ready) = if is_read_tool(&call.name) {
            (self.registry.lock().unwrap().execute(call), None)
        } else if is_execution_tool(&call.name) {
            let now = (self.now)();
            let result = self
                .execution
                .as_ref()
                .ok_or_else(|| ToolError::Unauthorized("执行权限未启用".to_string()))
                .and_then(|execution| execution.lock().unwrap().apply(&call.arguments, &now));
            let execution = match result {
                Ok(write) => {
                    if let Some(revision) = write.saved_revision {
                        if let Ok(node) = self.store.node(self.registry.lock().unwrap().node_id()) {
                            self.registry.lock().unwrap().update_node_snapshot(node);
                        }
                        if let Ok(mut writes) = self.execution_writes.lock() {
                            writes.push(HarnessExecutionWrite {
                                revision,
                                summary: write.summary.clone(),
                                saved_at: now,
                            });
                        }
                    }
                    crate::harness_tools::ToolExecution {
                        status: write.status,
                        content: write.content,
                        summary: write.summary,
                    }
                }
                Err(error) => error.into_execution(),
            };
            (execution, None)
        } else {
            let now = (self.now)();
            let Some(proposals) = &self.proposals else {
                return HarnessToolResult {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    content: "当前运行不支持提案工具".to_string(),
                    summary: "提案工具不可用".to_string(),
                    status: HarnessToolStatus::Unauthorized,
                    ready_proposal: None,
                };
            };
            let mut proposals = proposals.lock().unwrap();
            let before: Vec<String> = proposals
                .ready_proposals(&now)
                .into_iter()
                .map(|proposal| proposal.id)
                .collect();
            let execution = proposals.execute(call, &now);
            let ready = proposals
                .ready_proposals(&now)
                .into_iter()
                .find(|proposal| !before.contains(&proposal.id));
            (execution, ready)
        };
        HarnessToolResult {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: execution.content,
            summary: execution.summary,
            status: execution.status,
            ready_proposal: ready,
        }
    }

    fn validation_retries(&self) -> u32 {
        self.execution
            .as_ref()
            .map(|execution| execution.lock().unwrap().validation_retries())
            .unwrap_or_else(|| {
                self.proposals
                    .as_ref()
                    .map(|proposals| proposals.lock().unwrap().validation_retries())
                    .unwrap_or_default()
            })
    }
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub(crate) enum HarnessRunMode {
    Planning,
    Execution { plan: HarnessExecutionPlan },
}

/// Turn-scoped state for one Harness run, kept in `AgentState::harness_jobs`
/// so cancellation can stop the whole turn.
#[derive(Clone)]
pub(crate) struct HarnessJob {
    pub(crate) project_root: PathBuf,
    pub(crate) project_id: String,
    pub(crate) node_id: WorkflowNodeId,
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) user_message_id: String,
    pub(crate) run_id: String,
    pub(crate) scope: HarnessScope,
    pub(crate) model: ResolvedModel,
    pub(crate) reasoning_effort: ReasoningEffort,
    pub(crate) cancellation: CancellationToken,
    pub(crate) started_instant: Instant,
    pub(crate) mode: HarnessRunMode,
    pub(crate) initial_messages: Vec<sion_agent::model_protocol::ProtocolMessage>,
    pub(crate) limits: HarnessLimits,
}

/// Runs the Harness loop for one turn and persists the terminal checkpoint.
pub(crate) fn spawn_harness_run(
    app: tauri::AppHandle,
    state: Arc<AgentState>,
    run: sion_agent::AgentRun,
    job: HarnessJob,
    initial_messages: Vec<sion_agent::model_protocol::ProtocolMessage>,
    limits: HarnessLimits,
) {
    tauri::async_runtime::spawn(async move {
        let protocol = match job.model.protocol.as_str() {
            "chat_completions" => ProviderProtocol::ChatCompletions,
            "openai_responses" => ProviderProtocol::OpenaiResponses,
            _ => {
                complete_harness_run(
                    &app,
                    &state,
                    &run,
                    &job,
                    HarnessTurnResult::Failed {
                        error: "接口协议不受支持，请检查模型配置".to_string(),
                        usage: empty_usage(&job.turn_id),
                        diagnostics: HarnessDiagnostics::new(),
                    },
                    Vec::new(),
                    Vec::new(),
                    None,
                    Vec::new(),
                    None,
                );
                return;
            }
        };
        let store = ProjectStore::at(&job.project_root);
        let now: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(utc_now);
        let registry = match HarnessToolRegistry::new(&job.scope, &store) {
            Ok(registry) => registry,
            Err(message) => {
                complete_harness_run(
                    &app,
                    &state,
                    &run,
                    &job,
                    HarnessTurnResult::Failed {
                        error: message,
                        usage: empty_usage(&job.turn_id),
                        diagnostics: HarnessDiagnostics::new(),
                    },
                    Vec::new(),
                    Vec::new(),
                    None,
                    Vec::new(),
                    None,
                );
                return;
            }
        };
        let (proposals, execution) = match &job.mode {
            HarnessRunMode::Planning => match ProposalService::new(&job.scope, &store) {
                Ok(proposals) => (Some(Mutex::new(proposals)), None),
                Err(message) => {
                    complete_harness_run(
                        &app,
                        &state,
                        &run,
                        &job,
                        HarnessTurnResult::Failed {
                            error: message,
                            usage: empty_usage(&job.turn_id),
                            diagnostics: HarnessDiagnostics::new(),
                        },
                        Vec::new(),
                        Vec::new(),
                        None,
                        Vec::new(),
                        None,
                    );
                    return;
                }
            },
            HarnessRunMode::Execution { plan } => {
                match HarnessExecutionService::new(
                    &job.scope,
                    &store,
                    plan.id.clone(),
                    job.turn_id.clone(),
                ) {
                    Ok(execution) => (None, Some(Mutex::new(execution))),
                    Err(message) => {
                        complete_harness_run(
                            &app,
                            &state,
                            &run,
                            &job,
                            HarnessTurnResult::Failed {
                                error: message,
                                usage: empty_usage(&job.turn_id),
                                diagnostics: HarnessDiagnostics::new(),
                            },
                            Vec::new(),
                            Vec::new(),
                            None,
                            Vec::new(),
                            None,
                        );
                        return;
                    }
                }
            }
        };
        let tools = Arc::new(HarnessToolExecutorImpl {
            registry: Mutex::new(registry),
            proposals,
            execution,
            store: &store,
            execution_writes: Mutex::new(Vec::new()),
            now: now.clone(),
        });
        let provider = HarnessProviderAdapter {
            client: state.client.clone(),
            resolved: job.model.clone(),
            protocol,
        };
        let live = Arc::new(Mutex::new(HarnessLiveState {
            activities: vec![running_response_activity(&run.created_at)],
            proposals: Vec::new(),
        }));
        let bridge = HarnessEventBridge {
            app: app.clone(),
            project_id: job.project_id.clone(),
            node_id: job.node_id,
            session_id: job.session_id.clone(),
            turn_id: job.turn_id.clone(),
            run_id: job.run_id.clone(),
            started_at: run.created_at.clone(),
            now: now.clone(),
            live: live.clone(),
        };
        // Advertise the initial turn snapshot (queued/running activities).
        bridge.emit_turn_snapshot();
        let input = HarnessRunInput {
            model: job.model.model.clone(),
            context_window_tokens: job.model.context_window_tokens,
            initial_messages,
            reasoning_effort: job.reasoning_effort,
            request_public_reasoning_summary: true,
        };
        let result = HarnessRunner::new(
            &provider,
            tools.clone(),
            input,
            limits,
            job.cancellation.clone(),
            now.clone(),
        )
        .run(&bridge, &job.turn_id)
        .await;
        let durable_proposals = tools.durable_proposals(&(now)());
        let assistant_message_id = match &result {
            HarnessTurnResult::Completed(_) => Some(uuid::Uuid::new_v4().to_string()),
            _ => None,
        };
        let execution_plan = match (&job.mode, assistant_message_id.as_deref()) {
            (HarnessRunMode::Planning, Some(message_id)) => {
                tools.execution_plan_candidate(&job.turn_id, message_id)
            }
            _ => None,
        };
        let execution_writes = tools.execution_writes();
        let live_activities = live
            .lock()
            .map(|state| state.activities.clone())
            .unwrap_or_default();
        complete_harness_run(
            &app,
            &state,
            &run,
            &job,
            result,
            durable_proposals,
            live_activities,
            execution_plan,
            execution_writes,
            assistant_message_id,
        );
    });
}

fn empty_usage(turn_id: &str) -> sion_core::TurnTokenUsage {
    sion_core::TurnTokenUsage {
        turn_id: turn_id.to_string(),
        source: sion_core::TokenUsageSource::Estimated,
        call_count: 0,
        calls: Vec::new(),
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
    }
}

/// Prepared inputs for a Harness turn start.
#[derive(Debug)]
pub(crate) struct PreparedHarnessSend {
    pub(crate) resolved: ResolvedModel,
    pub(crate) selection: sion_core::ChatModelSelection,
    pub(crate) initial_messages: Vec<sion_agent::model_protocol::ProtocolMessage>,
    pub(crate) snapshot: sion_core::ConversationContextSnapshot,
    pub(crate) user_message: ChatMessage,
    pub(crate) file_ids: Vec<String>,
    pub(crate) turn_id: String,
    pub(crate) session_id: String,
    pub(crate) scope: HarnessScope,
    pub(crate) limits: HarnessLimits,
    pub(crate) mode: HarnessRunMode,
}

/// Prepares a Harness turn start: validates native tool calling, freezes the
/// trusted scope, builds the initial tool-calling messages, and constructs the
/// user message. Fails closed before any write when the model cannot call tools.
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_harness_send(
    app_data_root: &std::path::Path,
    store: &ProjectStore,
    project_root: PathBuf,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: &str,
    message: &str,
    file_ids: &[String],
    now: &str,
) -> Result<PreparedHarnessSend, String> {
    let session = store
        .session(node_id, session_id)
        .map_err(|error| error.to_string())?;
    let selection = match session.model_selection {
        Some(selection) => selection,
        None => crate::provider_settings::default_selection(app_data_root)?,
    };
    let resolved = crate::provider_settings::resolve_model(
        app_data_root,
        &selection.provider_id,
        &selection.model,
    )?;
    if !resolved.tool_calling {
        return Err("所选模型不支持原生工具调用，无法用于节点对话，请切换支持工具调用的模型".to_string());
    }
    let scope = crate::harness_scope::freeze_harness_scope(
        store,
        project_root,
        project_id,
        node_id,
        session_id,
        message,
        selection.clone(),
    )?;
    let mut tool_definitions = crate::harness_tools::tool_definitions();
    tool_definitions.extend(crate::harness_proposals::proposal_definitions(
        scope.rule_write_authorized,
    ));
    let limits = HarnessLimits::default();
    let history = store
        .messages(node_id, session_id)
        .map_err(|error| error.to_string())?;
    let (initial_messages, snapshot) =
        crate::conversation_runtime::build_harness_initial_messages(
            store,
            &scope,
            &history,
            file_ids,
            &tool_definitions,
            limits,
            resolved.context_window_tokens,
            now,
        )?;
    let mut initial_messages = initial_messages;
    initial_messages.push(sion_agent::model_protocol::ProtocolMessage::user(message));
    let turn_id = uuid::Uuid::new_v4().to_string();
    let attachments = crate::conversation_runtime::load_selected_files(store, file_ids)?
        .into_iter()
        .map(|file| sion_core::MessageAttachmentRef {
            file_id: file.file_id,
            original_name: file.original_name,
        })
        .collect();
    let user_message = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: ChatRole::User,
        content: message.to_string(),
        reasoning_content: None,
        sources: None,
        created_at: now.to_string(),
        turn_id: Some(turn_id.clone()),
        reasoning_duration_ms: None,
        usage: None,
        attachments,
        model_execution: None,
    };
    Ok(PreparedHarnessSend {
        resolved,
        selection,
        initial_messages,
        snapshot,
        user_message,
        file_ids: file_ids.to_vec(),
        turn_id,
        session_id: session_id.to_string(),
        scope,
        limits,
        mode: HarnessRunMode::Planning,
    })
}

/// Prepares the second-stage confirmed execution Harness. The plan and scope
/// are trusted storage records; model or frontend arguments cannot widen them.
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_harness_execution_send(
    app_data_root: &std::path::Path,
    store: &ProjectStore,
    project_root: PathBuf,
    project_id: String,
    node_id: WorkflowNodeId,
    session_id: &str,
    message: &str,
    file_ids: &[String],
    plan: HarnessExecutionPlan,
    now: &str,
) -> Result<PreparedHarnessSend, String> {
    let session = store
        .session(node_id, session_id)
        .map_err(|error| error.to_string())?;
    let selection = match session.model_selection {
        Some(selection) => selection,
        None => crate::provider_settings::default_selection(app_data_root)?,
    };
    let resolved = crate::provider_settings::resolve_model(
        app_data_root,
        &selection.provider_id,
        &selection.model,
    )?;
    if !resolved.tool_calling {
        return Err("所选模型不支持原生工具调用，无法执行已确认计划".to_string());
    }
    let scope = crate::harness_scope::freeze_execution_scope(
        store,
        project_root,
        project_id,
        node_id,
        session_id,
        &plan,
        selection.clone(),
    )?;
    let mut tool_definitions = crate::harness_tools::tool_definitions();
    tool_definitions.extend(crate::harness_execution::execution_tool_definitions());
    let limits = HarnessLimits::default();
    let history = store
        .messages(node_id, session_id)
        .map_err(|error| error.to_string())?;
    let (initial_messages, snapshot) =
        crate::conversation_runtime::build_harness_initial_messages(
            store,
            &scope,
            &history,
            file_ids,
            &tool_definitions,
            limits,
            resolved.context_window_tokens,
            now,
        )?;
    let mut initial_messages = initial_messages;
    initial_messages.push(sion_agent::model_protocol::ProtocolMessage::system(format!(
        "本轮是已确认的执行阶段。只能完成以下计划，不得扩展目标：{}。你可以先读取授权上下文，然后仅使用 apply_current_delivery_change 修改当前节点交付稿。每次保存后继续使用新的 revision；遇到冲突、取消或校验失败时停止写入并如实说明。",
        plan.summary
    )));
    initial_messages.push(sion_agent::model_protocol::ProtocolMessage::user(message));
    let turn_id = uuid::Uuid::new_v4().to_string();
    let attachments = crate::conversation_runtime::load_selected_files(store, file_ids)?
        .into_iter()
        .map(|file| sion_core::MessageAttachmentRef {
            file_id: file.file_id,
            original_name: file.original_name,
        })
        .collect();
    let user_message = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: ChatRole::User,
        content: message.to_string(),
        reasoning_content: None,
        sources: None,
        created_at: now.to_string(),
        turn_id: Some(turn_id.clone()),
        reasoning_duration_ms: None,
        usage: None,
        attachments,
        model_execution: None,
    };
    Ok(PreparedHarnessSend {
        resolved,
        selection,
        initial_messages,
        snapshot,
        user_message,
        file_ids: file_ids.to_vec(),
        turn_id,
        session_id: session_id.to_string(),
        scope,
        limits,
        mode: HarnessRunMode::Execution { plan },
    })
}

/// Enqueues the Harness run and persists the start checkpoint atomically, then
/// returns the run/turn for the caller to store the job and spawn the loop.
pub(crate) fn persist_harness_send(
    store: &ProjectStore,
    scheduler: &mut sion_agent::RunScheduler,
    prepared: &PreparedHarnessSend,
    project_id: String,
    node_id: WorkflowNodeId,
    now: String,
) -> Result<(sion_agent::AgentRun, ConversationTurn), String> {
    let run_request = sion_agent::RunRequest {
        project_id,
        node_id,
        provider_id: prepared.selection.provider_id.clone(),
        model: prepared.selection.model.clone(),
        reasoning_effort: prepared.selection.reasoning_effort,
        file_ids: prepared.file_ids.clone(),
        kind: sion_agent::AgentRunKind::Harness,
        created_at: now.clone(),
        session_id: Some(prepared.session_id.clone()),
        turn_id: Some(prepared.turn_id.clone()),
        context_snapshot: Some(prepared.snapshot.clone()),
    };
    scheduler
        .ensure_available(&run_request.project_id, node_id)
        .map_err(|error| error.to_string())?;
    let run = scheduler.enqueue(run_request).map_err(|error| error.to_string())?;
    let running = run.status == sion_agent::AgentRunStatus::Running;
    let turn = ConversationTurn {
        id: prepared.turn_id.clone(),
        project_id: run.project_id.clone(),
        node_id,
        session_id: prepared.session_id.clone(),
        run_id: run.id.clone(),
        user_message_id: prepared.user_message.id.clone(),
        assistant_message_id: None,
        status: if running {
            TurnStatus::Running
        } else {
            TurnStatus::Queued
        },
        activities: if running {
            vec![running_response_activity(&now)]
        } else {
            Vec::new()
        },
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: Some(HarnessTurnState {
            proposals: Vec::new(),
            diagnostics: None,
            execution_plan: None,
            execution: None,
        }),
        started_at: now.clone(),
        finished_at: None,
    };
    store
        .begin_harness_turn(
            node_id,
            &prepared.session_id,
            prepared.user_message.clone(),
            turn.clone(),
            &run,
            now,
        )
        .map_err(|error| error.to_string())?;
    Ok((run, turn))
}

/// Enqueues and atomically begins a confirmed execution turn. The storage
/// transaction consumes the pending plan while appending the confirmation
/// message and execution turn, so a racing confirmation cannot create a second
/// write-capable run.
pub(crate) fn persist_harness_execution_send(
    store: &ProjectStore,
    scheduler: &mut sion_agent::RunScheduler,
    prepared: &PreparedHarnessSend,
    project_id: String,
    node_id: WorkflowNodeId,
    now: String,
) -> Result<(sion_agent::AgentRun, ConversationTurn), String> {
    let HarnessRunMode::Execution { plan } = &prepared.mode else {
        return Err("执行计划状态无效".to_string());
    };
    let run_request = sion_agent::RunRequest {
        project_id,
        node_id,
        provider_id: prepared.selection.provider_id.clone(),
        model: prepared.selection.model.clone(),
        reasoning_effort: prepared.selection.reasoning_effort,
        file_ids: prepared.file_ids.clone(),
        kind: sion_agent::AgentRunKind::HarnessExecution,
        created_at: now.clone(),
        session_id: Some(prepared.session_id.clone()),
        turn_id: Some(prepared.turn_id.clone()),
        context_snapshot: Some(prepared.snapshot.clone()),
    };
    scheduler
        .ensure_available(&run_request.project_id, node_id)
        .map_err(|error| error.to_string())?;
    let run = scheduler.enqueue(run_request).map_err(|error| error.to_string())?;
    let running = run.status == sion_agent::AgentRunStatus::Running;
    let turn = ConversationTurn {
        id: prepared.turn_id.clone(),
        project_id: run.project_id.clone(),
        node_id,
        session_id: prepared.session_id.clone(),
        run_id: run.id.clone(),
        user_message_id: prepared.user_message.id.clone(),
        assistant_message_id: None,
        status: if running { TurnStatus::Running } else { TurnStatus::Queued },
        activities: if running {
            vec![running_response_activity(&now)]
        } else {
            Vec::new()
        },
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: Some(HarnessTurnState {
            proposals: Vec::new(),
            diagnostics: None,
            execution_plan: None,
            execution: Some(HarnessExecutionRecord {
                run_id: run.id.clone(),
                turn_id: prepared.turn_id.clone(),
                started_at: now.clone(),
                finished_at: None,
                status: HarnessExecutionStatus::Running,
                writes: Vec::new(),
                public_error: None,
            }),
        }),
        started_at: now.clone(),
        finished_at: None,
    };
    match store.consume_execution_plan(
        node_id,
        &prepared.session_id,
        &plan.id,
        &prepared.user_message.content,
        prepared.user_message.clone(),
        turn.clone(),
        &run,
        now,
    )
    .map_err(|error| error.to_string())?
    {
        sion_storage::ConsumeExecutionPlanResult::Consumed { run, turn, .. } => {
            Ok((*run, *turn))
        }
        sion_storage::ConsumeExecutionPlanResult::Unavailable { reason } => {
            let _ = scheduler.cancel(
                &run.id,
                utc_now(),
                Some(format!("执行计划不可用：{reason:?}")),
            );
            Err("执行计划已失效或不可用，请重新进行规划".to_string())
        }
    }
}

fn running_response_activity(now: &str) -> TurnActivity {
    TurnActivity {
        id: "response-0".to_string(),
        kind: TurnActivityKind::Response,
        status: TurnActivityStatus::Running,
        label: "Agent 正在分析并回复".to_string(),
        public_summary: None,
        started_at: Some(now.to_string()),
        finished_at: None,
    }
}


/// Terminal checkpoint for a Harness turn. Persists the assistant message (when
/// one exists), the terminal turn with durable proposals/diagnostics, and the
/// terminal run record in one recoverable transaction, then releases the
/// scheduler reservation and emits terminal events.
#[allow(clippy::too_many_arguments)]
fn complete_harness_run(
    app: &tauri::AppHandle,
    state: &Arc<AgentState>,
    run: &sion_agent::AgentRun,
    job: &HarnessJob,
    result: HarnessTurnResult,
    durable_proposals: Vec<HarnessProposal>,
    live_activities: Vec<TurnActivity>,
    execution_plan: Option<HarnessExecutionPlan>,
    execution_writes: Vec<HarnessExecutionWrite>,
    assistant_message_id: Option<String>,
) {
    let finished_at = utc_now();
    let duration_ms = elapsed_ms(job.started_instant);
    let store = ProjectStore::at(&job.project_root);

    let (run_status, run_summary, turn_status, assistant_message, usage, diagnostics, error) =
        match result {
            HarnessTurnResult::Completed(outcome) => {
                let assistant = ChatMessage {
                    id: assistant_message_id
                        .clone()
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    role: ChatRole::Assistant,
                    content: outcome.assistant_message.clone(),
                    reasoning_content: None,
                    sources: None,
                    created_at: finished_at.clone(),
                    turn_id: Some(job.turn_id.clone()),
                    reasoning_duration_ms: None,
                    usage: Some(outcome.usage.clone()),
                    attachments: Vec::new(),
                    model_execution: Some(sion_core::ModelExecution {
                        provider_id: job.model.provider_id.clone(),
                        model: job.model.model.clone(),
                        reasoning_effort: job.reasoning_effort,
                    }),
                };
                (
                    sion_agent::AgentRunStatus::Completed,
                    Some("Harness 对话完成".to_string()),
                    TurnStatus::Completed,
                    Some(assistant),
                    outcome.usage,
                    outcome.diagnostics,
                    None,
                )
            }
            HarnessTurnResult::Cancelled { usage, diagnostics } => (
                sion_agent::AgentRunStatus::Cancelled,
                Some(match job.mode {
                    HarnessRunMode::Execution { .. } => "已取消；已保存的修改保持不变".to_string(),
                    HarnessRunMode::Planning => "已取消；未应用任何提案".to_string(),
                }),
                TurnStatus::Cancelled,
                None,
                usage,
                diagnostics,
                None,
            ),
            HarnessTurnResult::Failed { error, usage, diagnostics } => (
                sion_agent::AgentRunStatus::Failed,
                Some(error.clone()),
                TurnStatus::Failed,
                None,
                usage,
                diagnostics,
                Some(error),
            ),
        };

    let terminal_run = sion_agent::AgentRun {
        status: run_status,
        finished_at: Some(finished_at.clone()),
        summary: run_summary,
        usage: Some(usage.clone()),
        duration_ms: Some(duration_ms),
        ..run.clone()
    };

    let execution = match &job.mode {
        HarnessRunMode::Execution { .. } => Some(HarnessExecutionRecord {
            run_id: job.run_id.clone(),
            turn_id: job.turn_id.clone(),
            started_at: run.created_at.clone(),
            finished_at: Some(finished_at.clone()),
            status: match turn_status {
                TurnStatus::Completed => HarnessExecutionStatus::Completed,
                TurnStatus::Cancelled => HarnessExecutionStatus::Cancelled,
                _ => HarnessExecutionStatus::Failed,
            },
            writes: execution_writes,
            public_error: error.clone(),
        }),
        HarnessRunMode::Planning => None,
    };
    let terminal_turn = ConversationTurn {
        id: job.turn_id.clone(),
        project_id: job.project_id.clone(),
        node_id: job.node_id,
        session_id: job.session_id.clone(),
        run_id: job.run_id.clone(),
        user_message_id: job.user_message_id.clone(),
        assistant_message_id: assistant_message.as_ref().map(|message| message.id.clone()),
        status: turn_status,
        activities: live_activities,
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: Some(HarnessTurnState {
            proposals: durable_proposals,
            diagnostics: Some(diagnostics.clone()),
            execution_plan: execution_plan.clone(),
            execution,
        }),
        started_at: run.created_at.clone(),
        finished_at: Some(finished_at.clone()),
    };

    let persisted = store
        .complete_harness_turn(
            job.node_id,
            &job.session_id,
            assistant_message,
            terminal_turn.clone(),
            &terminal_run,
            finished_at.clone(),
        )
        .is_ok();

    let promoted = {
        let Ok(mut scheduler) = state.scheduler.lock() else {
            return;
        };
        let _ = scheduler.attach_usage(&job.run_id, usage, duration_ms);
        let promoted = if persisted {
            match terminal_run.status {
                sion_agent::AgentRunStatus::Completed => scheduler.complete(
                    &job.run_id,
                    finished_at.clone(),
                    terminal_run.summary.clone(),
                ),
                sion_agent::AgentRunStatus::Cancelled => scheduler.cancel(
                    &job.run_id,
                    finished_at.clone(),
                    terminal_run.summary.clone(),
                ),
                _ => scheduler.fail(
                    &job.run_id,
                    finished_at.clone(),
                    terminal_run.summary.clone().unwrap_or_default(),
                ),
            }
            .unwrap_or_default()
        } else {
            scheduler
                .fail(
                    &job.run_id,
                    finished_at.clone(),
                    "本地会话保存失败".to_string(),
                )
                .unwrap_or_default()
        };
        if let Some(final_run) = scheduler.get(&job.run_id) {
            let _ = store.save_run(final_run);
        }
        promoted
    };
    if let Ok(mut jobs) = state.harness_jobs.lock() {
        jobs.remove(&job.run_id);
    }
    let final_run = state
        .scheduler
        .lock()
        .ok()
        .and_then(|scheduler| scheduler.get(&job.run_id).cloned())
        .unwrap_or_else(|| terminal_run.clone());
    let _ = app.emit(
        "conversation-turn-updated",
        ConversationTurnEvent {
            turn: terminal_turn,
            saved_node: None,
        },
    );
    let _ = app.emit("agent-run-finished", AgentFinishedEvent { run: final_run });
    let _ = error;
    crate::spawn_promoted_runs(app.clone(), state.clone(), promoted);
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_storage::{CreateProjectInput, SaveNodeResult};
    use std::path::PathBuf;

    const GOALS: &str =
        "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界";

    fn fixture() -> (PathBuf, PathBuf, ProjectStore) {
        let root =
            std::env::temp_dir().join(format!("sion-harness-runtime-{}", uuid::Uuid::new_v4()));
        let app_data = root.join("global");
        std::fs::create_dir_all(&app_data).unwrap();
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
                    sion_core::NodeStatus::Generated,
                    "now".into(),
                )
                .unwrap(),
            SaveNodeResult::Saved(_)
        ));
        // providers.json with one tool-calling model and one non-tool model.
        std::fs::write(
            app_data.join("providers.json"),
            r#"{"schemaVersion":2,"providers":[{"id":"p","name":"P","apiBaseUrl":"https://example.invalid/v1","apiUrlMode":"base","protocol":"chat_completions","models":[{"name":"tool-model","isDefault":true,"toolCalling":true,"contextWindowTokens":128000},{"name":"text-model","isDefault":false,"toolCalling":false,"contextWindowTokens":128000}],"isDefault":true,"createdAt":"now","updatedAt":"now","apiKey":"secret"}]}"#,
        )
        .unwrap();
        (root, app_data, store)
    }

    fn session_with(store: &ProjectStore, selection: Option<sion_core::ChatModelSelection>) -> String {
        store
            .create_session(
                WorkflowNodeId::Goals,
                "讨论".into(),
                selection,
                "now".into(),
            )
            .unwrap()
            .id
    }

    fn selection(model: &str) -> sion_core::ChatModelSelection {
        sion_core::ChatModelSelection {
            provider_id: "p".into(),
            model: model.into(),
            reasoning_effort: ReasoningEffort::Medium,
        }
    }

    #[test]
    fn harness_send_enqueues_exactly_one_harness_run_and_no_delivery_decision() {
        let (root, app_data, store) = fixture();
        let session_id = session_with(&store, Some(selection("tool-model")));
        let prepared = prepare_harness_send(
            &app_data,
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session_id,
            "请补充目标",
            &[],
            "started",
        )
        .unwrap();
        assert!(prepared.resolved.tool_calling);
        let mut scheduler = sion_agent::RunScheduler::default();
        let (run, turn) = persist_harness_send(
            &store,
            &mut scheduler,
            &prepared,
            "project-1".into(),
            WorkflowNodeId::Goals,
            "started".into(),
        )
        .unwrap();
        assert_eq!(run.kind, sion_agent::AgentRunKind::Harness);
        assert_eq!(turn.status, TurnStatus::Running);
        // Exactly one run exists, and it is a Harness run (no DeliveryDecision).
        let runs = store.list_runs().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].kind, sion_agent::AgentRunKind::Harness);
        let turns = store.turns(WorkflowNodeId::Goals, &session_id).unwrap();
        assert_eq!(turns.len(), 1);
        assert!(turns[0].harness.is_some());
        assert_eq!(turns[0].delivery_outcome, None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn harness_send_requires_native_tool_calling() {
        let (root, app_data, store) = fixture();
        let session_id = session_with(&store, Some(selection("text-model")));
        let error = prepare_harness_send(
            &app_data,
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session_id,
            "你好",
            &[],
            "started",
        )
        .unwrap_err();
        assert!(error.contains("不支持原生工具调用"));
        assert!(!error.contains("secret"));
        // Nothing was written before the failure.
        assert!(store.list_runs().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn harness_tool_executor_advertises_rule_tools_only_when_authorized() {
        let (root, app_data, store) = fixture();
        let session_id = session_with(&store, Some(selection("tool-model")));
        let prepared = prepare_harness_send(
            &app_data,
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session_id,
            "你好",
            &[],
            "started",
        )
        .unwrap();
        assert!(!prepared.scope.rule_write_authorized);
        let registry = HarnessToolRegistry::new(&prepared.scope, &store).unwrap();
        let proposals = ProposalService::new(&prepared.scope, &store).unwrap();
        let executor = HarnessToolExecutorImpl {
            registry: Mutex::new(registry),
            proposals: Some(Mutex::new(proposals)),
            execution: None,
            store: &store,
            execution_writes: Mutex::new(Vec::new()),
            now: Arc::new(utc_now),
        };
        let definitions = executor.tool_definitions();
        assert!(definitions.iter().any(|tool| tool.name == "read_attachment"));
        assert!(definitions.iter().any(|tool| tool.name == "request_delivery_execution"));
        assert!(definitions
            .iter()
            .all(|tool| !tool.name.starts_with("propose_agent_rule")));
        // A forged rule tool call fails batch validation.
        let batch = vec![HarnessToolCall {
            id: "c-1".into(),
            name: "propose_agent_rule_override".into(),
            arguments: r#"{"markdown":"x","reason":"r"}"#.into(),
        }];
        let error = executor.validate_batch(&batch).unwrap_err();
        assert!(error.message.contains("无权访问"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn harness_tool_executor_refuses_unknown_tools_and_orders_results() {
        let (root, app_data, store) = fixture();
        let session_id = session_with(&store, Some(selection("tool-model")));
        let prepared = prepare_harness_send(
            &app_data,
            &store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            &session_id,
            "你好",
            &[],
            "started",
        )
        .unwrap();
        let registry = HarnessToolRegistry::new(&prepared.scope, &store).unwrap();
        let proposals = ProposalService::new(&prepared.scope, &store).unwrap();
        let executor = HarnessToolExecutorImpl {
            registry: Mutex::new(registry),
            proposals: Some(Mutex::new(proposals)),
            execution: None,
            store: &store,
            execution_writes: Mutex::new(Vec::new()),
            now: Arc::new(utc_now),
        };
        let unknown = executor.validate_batch(&[HarnessToolCall {
            id: "c-1".into(),
            name: "rm_rf".into(),
            arguments: "{}".into(),
        }]);
        assert!(unknown.is_err());
        // read_current_delivery returns the node markdown without any writes.
        let result = executor.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "read_current_delivery".into(),
            arguments: "{}".into(),
        });
        assert_eq!(result.status, HarnessToolStatus::Completed);
        assert!(result.content.contains("旧目标"));
        assert_eq!(store.node(WorkflowNodeId::Goals).unwrap().revision, 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
