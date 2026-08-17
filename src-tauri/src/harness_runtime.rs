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
        "propose_delivery_change"
            | "revise_delivery_proposal"
            | "discard_delivery_proposal"
            | "propose_agent_rule_override"
            | "revise_agent_rule_proposal"
            | "discard_agent_rule_proposal"
    )
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
        let (kind, label, activity_status) = if is_proposal_tool(name) {
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
    registry: HarnessToolRegistry<'a>,
    proposals: Mutex<ProposalService<'a>>,
    now: Arc<dyn Fn() -> String + Send + Sync>,
}

impl<'a> HarnessToolExecutorImpl<'a> {
    fn durable_proposals(&self, now: &str) -> Vec<HarnessProposal> {
        self.proposals.lock().unwrap().durable_proposals(now)
    }
}

impl HarnessToolExecutor for HarnessToolExecutorImpl<'_> {
    fn tool_definitions(&self) -> Vec<HarnessToolDefinition> {
        let rule_authorized = self.proposals.lock().unwrap().rule_authorized();
        let mut tools = crate::harness_tools::tool_definitions();
        tools.extend(crate::harness_proposals::proposal_definitions(rule_authorized));
        tools
    }

    fn validate_batch(&self, calls: &[HarnessToolCall]) -> Result<(), HarnessToolBatchError> {
        for call in calls {
            let result = if is_read_tool(&call.name) {
                self.registry.validate(call)
            } else if is_proposal_tool(&call.name) {
                self.proposals.lock().unwrap().validate(call)
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
        is_proposal_tool(&call.name)
    }

    fn execute(&self, call: &HarnessToolCall) -> HarnessToolResult {
        let (execution, ready) = if is_read_tool(&call.name) {
            (self.registry.execute(call), None)
        } else {
            let now = (self.now)();
            let mut proposals = self.proposals.lock().unwrap();
            let before: Vec<String> = proposals
                .ready_proposals(&now)
                .into_iter()
                .map(|proposal| proposal.id)
                .collect();
            let execution = proposals.execute(call);
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
        self.proposals.lock().unwrap().validation_retries()
    }
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
    pub(crate) run_id: String,
    pub(crate) scope: HarnessScope,
    pub(crate) model: ResolvedModel,
    pub(crate) reasoning_effort: ReasoningEffort,
    pub(crate) cancellation: CancellationToken,
    pub(crate) started_instant: Instant,
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
                );
                return;
            }
        };
        let proposals = match ProposalService::new(&job.scope, &store) {
            Ok(proposals) => proposals,
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
                );
                return;
            }
        };
        let tools = Arc::new(HarnessToolExecutorImpl {
            registry,
            proposals: Mutex::new(proposals),
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
    let tool_definitions = crate::harness_tools::tool_definitions();
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
) {
    let finished_at = utc_now();
    let duration_ms = elapsed_ms(job.started_instant);
    let store = ProjectStore::at(&job.project_root);

    let (run_status, run_summary, turn_status, assistant_message, usage, diagnostics, error) =
        match result {
            HarnessTurnResult::Completed(outcome) => {
                let assistant = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
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
                Some("已取消；未应用任何提案".to_string()),
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

    let terminal_turn = ConversationTurn {
        id: job.turn_id.clone(),
        project_id: job.project_id.clone(),
        node_id: job.node_id,
        session_id: job.session_id.clone(),
        run_id: job.run_id.clone(),
        user_message_id: String::new(),
        assistant_message_id: assistant_message.as_ref().map(|message| message.id.clone()),
        status: turn_status,
        activities: live_activities,
        reasoning_summary: None,
        delivery_outcome: None,
        delivery_inspection: None,
        harness: Some(HarnessTurnState {
            proposals: durable_proposals,
            diagnostics: Some(diagnostics.clone()),
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
            registry,
            proposals: Mutex::new(proposals),
            now: Arc::new(utc_now),
        };
        let definitions = executor.tool_definitions();
        assert!(definitions.iter().any(|tool| tool.name == "read_attachment"));
        assert!(definitions.iter().any(|tool| tool.name == "propose_delivery_change"));
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
            registry,
            proposals: Mutex::new(proposals),
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
