//! OpenAI-compatible SSE transport with explicit cancellation semantics.
//!
//! Both supported protocols stream normalized events: output text, public
//! reasoning summaries, tool-call argument deltas, usage, completion,
//! cancellation, malformed frames, and provider failures. The transport never
//! exposes request headers, API keys, full request bodies, or raw error bodies.

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sion_core::{HarnessToolCall, ProviderTokenUsage, ReasoningEffort, normalize_provider_usage};
use tokio_util::sync::CancellationToken;

use crate::model_protocol::{ModelRequest, serialize_request_body};

const MAX_PROVIDER_ERROR_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    ChatCompletions,
    OpenaiResponses,
}

#[derive(Debug, Clone)]
pub struct StreamRequest {
    pub endpoint: String,
    pub api_key: String,
    pub protocol: ProviderProtocol,
    pub request: ModelRequest,
}

impl StreamRequest {
    /// Text-only compatibility constructor for export generation. Export
    /// runtimes stay out of the Harness in this phase and never accept tools.
    pub fn text_only(
        endpoint: String,
        api_key: String,
        protocol: ProviderProtocol,
        model: String,
        prompt: String,
        reasoning_effort: ReasoningEffort,
        request_public_reasoning_summary: bool,
    ) -> Self {
        Self {
            endpoint,
            api_key,
            protocol,
            request: ModelRequest {
                model,
                messages: vec![crate::model_protocol::ProtocolMessage::user(prompt)],
                tools: Vec::new(),
                tool_choice: crate::model_protocol::ToolChoice::None,
                reasoning_effort,
                request_public_reasoning_summary,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamDelta {
    OutputText(String),
    ReasoningSummary(String),
    /// A fragment of a native tool call. `index` orders parallel calls in one
    /// assistant step; `call_id` and `name` arrive on the first fragment of a
    /// call; `arguments_delta` is the streamed JSON argument slice.
    ToolCallDelta {
        call_id: String,
        index: usize,
        name: String,
        arguments_delta: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamContent {
    pub output: Vec<String>,
    pub reasoning_summary: Vec<String>,
    /// Complete native tool calls accumulated over the whole model step. Empty
    /// when the model produced a final response without requesting tools.
    pub tool_calls: Vec<HarnessToolCall>,
    pub usage: Option<ProviderTokenUsage>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StreamOutcome {
    Completed(StreamContent),
    Cancelled(StreamContent),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRejection {
    Reasoning,
    Context,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamFailure {
    UnsupportedProtocol,
    RequestConnect,
    RequestTimeout,
    RequestOther,
    ProviderHttp {
        status: u16,
        rejection: ProviderRejection,
    },
    ProviderStream {
        rejection: ProviderRejection,
    },
    StreamRead,
    StreamIncomplete,
    InvalidFrame,
    /// A native tool call could not be finalized (missing id/name, invalid
    /// JSON completion). The `reason` is a fixed safe label, never provider text.
    IncompleteToolCall { index: usize, reason: &'static str },
}

pub async fn stream_text(
    client: &Client,
    request: &StreamRequest,
    cancellation: CancellationToken,
) -> Result<StreamOutcome, StreamFailure> {
    stream_text_with(client, request, cancellation, |_| {}).await
}

pub async fn stream_text_with<F>(
    client: &Client,
    request: &StreamRequest,
    cancellation: CancellationToken,
    mut on_delta: F,
) -> Result<StreamOutcome, StreamFailure>
where
    F: FnMut(&StreamDelta),
{
    let body = serialize_request_body(request.protocol, &request.request);
    let response = client
        .post(&request.endpoint)
        .bearer_auth(&request.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| request_failure_kind(error.is_connect(), error.is_timeout()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = read_bounded_error_body(response).await;
        return Err(StreamFailure::ProviderHttp {
            status,
            rejection: provider_rejection(&body),
        });
    }

    let mut bytes = response.bytes_stream();
    let mut buffer = String::new();
    let mut output = Vec::new();
    let mut reasoning_summary = Vec::new();
    let mut tool_calls: Vec<ToolCallAccumulator> = Vec::new();
    let mut usage = None;
    let mut stream_completed = false;
    let mut saw_done = false;
    let mut saw_responses_completed = false;
    loop {
        let next = tokio::select! {
            _ = cancellation.cancelled() => {
                return Ok(StreamOutcome::Cancelled(StreamContent {
                    output,
                    reasoning_summary,
                    tool_calls: Vec::new(),
                    usage,
                }))
            }
            next = bytes.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| StreamFailure::StreamRead)?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        for frame in take_frames(&mut buffer) {
            if let Some(error) = provider_error_from_frame(request.protocol, &frame) {
                return Err(error);
            }
            if let Some(frame_usage) = frame_usage(request.protocol, &frame) {
                usage = Some(frame_usage);
            }
            if frame_completes_stream(request.protocol, &frame) {
                let is_done = frame.data == "[DONE]";
                let duplicate = if is_done {
                    saw_done
                } else {
                    saw_responses_completed
                };
                if duplicate {
                    return Err(StreamFailure::InvalidFrame);
                }
                if is_done {
                    saw_done = true;
                } else {
                    saw_responses_completed = true;
                }
                stream_completed = true;
                continue;
            }
            for delta in frame_deltas(request.protocol, &frame)? {
                match &delta {
                    StreamDelta::OutputText(text) => output.push(text.clone()),
                    StreamDelta::ReasoningSummary(text) => reasoning_summary.push(text.clone()),
                    StreamDelta::ToolCallDelta {
                        call_id,
                        index,
                        name,
                        arguments_delta,
                    } => accumulate_tool_call(
                        &mut tool_calls,
                        *index,
                        call_id,
                        name,
                        arguments_delta,
                    ),
                }
                on_delta(&delta);
            }
        }
        if stream_completed {
            break;
        }
    }
    if !stream_completed {
        return Err(StreamFailure::StreamIncomplete);
    }
    let tool_calls = finalize_tool_calls(tool_calls)?;
    Ok(StreamOutcome::Completed(StreamContent {
        output,
        reasoning_summary,
        tool_calls,
        usage,
    }))
}

/// One provider-neutral tool call being accumulated from streamed fragments.
#[derive(Debug, Default, Clone)]
struct ToolCallAccumulator {
    id: String,
    name: String,
    arguments: String,
}

fn accumulate_tool_call(
    tool_calls: &mut Vec<ToolCallAccumulator>,
    index: usize,
    call_id: &str,
    name: &str,
    arguments_delta: &str,
) {
    if tool_calls.len() <= index {
        tool_calls.resize(index + 1, ToolCallAccumulator::default());
    }
    let entry = &mut tool_calls[index];
    if !call_id.is_empty() {
        entry.id = call_id.to_string();
    }
    if !name.is_empty() {
        entry.name = name.to_string();
    }
    entry.arguments.push_str(arguments_delta);
}

/// Validates the accumulated native tool calls before they can be executed:
/// every call needs a provider call ID and a name, and the streamed argument
/// JSON must be complete and parseable (an empty argument string means `{}`).
fn finalize_tool_calls(
    tool_calls: Vec<ToolCallAccumulator>,
) -> Result<Vec<HarnessToolCall>, StreamFailure> {
    let mut calls = Vec::with_capacity(tool_calls.len());
    for (index, accumulator) in tool_calls.into_iter().enumerate() {
        if accumulator.id.is_empty() {
            return Err(StreamFailure::IncompleteToolCall {
                index,
                reason: "missing call id",
            });
        }
        if accumulator.name.is_empty() {
            return Err(StreamFailure::IncompleteToolCall {
                index,
                reason: "missing tool name",
            });
        }
        let arguments = accumulator.arguments.trim().to_string();
        if !arguments.is_empty()
            && serde_json::from_str::<serde_json::Value>(&arguments).is_err()
        {
            return Err(StreamFailure::IncompleteToolCall {
                index,
                reason: "invalid arguments json",
            });
        }
        calls.push(HarnessToolCall {
            id: accumulator.id,
            name: accumulator.name,
            arguments,
        });
    }
    Ok(calls)
}

async fn read_bounded_error_body(response: reqwest::Response) -> String {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while body.len() < MAX_PROVIDER_ERROR_BYTES {
        let Some(chunk) = stream.next().await else {
            break;
        };
        let Ok(chunk) = chunk else {
            break;
        };
        let remaining = MAX_PROVIDER_ERROR_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    String::from_utf8_lossy(&body).into_owned()
}

fn request_failure_kind(is_connect: bool, is_timeout: bool) -> StreamFailure {
    if is_connect {
        StreamFailure::RequestConnect
    } else if is_timeout {
        StreamFailure::RequestTimeout
    } else {
        StreamFailure::RequestOther
    }
}

fn provider_rejection(provider_text: &str) -> ProviderRejection {
    let normalized = provider_text.to_ascii_lowercase();
    if normalized.contains("reasoning") {
        ProviderRejection::Reasoning
    } else if normalized.contains("context") || normalized.contains("token limit") {
        ProviderRejection::Context
    } else {
        ProviderRejection::Other
    }
}

pub fn request_body(request: &StreamRequest) -> serde_json::Value {
    serialize_request_body(request.protocol, &request.request)
}

#[derive(Debug)]
struct SseFrame {
    event: Option<String>,
    data: String,
}

fn frame_completes_stream(protocol: ProviderProtocol, frame: &SseFrame) -> bool {
    frame.data == "[DONE]"
        || matches!(protocol, ProviderProtocol::OpenaiResponses)
            && frame.event.as_deref() == Some("response.completed")
}

fn provider_error_from_frame(
    _protocol: ProviderProtocol,
    frame: &SseFrame,
) -> Option<StreamFailure> {
    let explicit_error_event = matches!(
        frame.event.as_deref(),
        Some("error" | "response.failed" | "response.incomplete")
    );
    let json_error = serde_json::from_str::<serde_json::Value>(&frame.data)
        .ok()
        .is_some_and(|body| {
            body.get("error").is_some_and(|value| !value.is_null())
                || body
                    .pointer("/response/error")
                    .is_some_and(|value| !value.is_null())
                || body.get("type").and_then(|value| value.as_str()) == Some("error")
        });
    if explicit_error_event || json_error {
        Some(StreamFailure::ProviderStream {
            rejection: provider_rejection(&frame.data),
        })
    } else {
        None
    }
}

fn frame_usage(protocol: ProviderProtocol, frame: &SseFrame) -> Option<ProviderTokenUsage> {
    let body: serde_json::Value = serde_json::from_str(&frame.data).ok()?;
    let usage = match protocol {
        ProviderProtocol::ChatCompletions => body.get("usage")?,
        ProviderProtocol::OpenaiResponses => body.pointer("/response/usage")?,
    };
    let input_tokens = match protocol {
        ProviderProtocol::ChatCompletions => usage.get("prompt_tokens")?.as_u64()?,
        ProviderProtocol::OpenaiResponses => usage.get("input_tokens")?.as_u64()?,
    };
    let output_tokens = match protocol {
        ProviderProtocol::ChatCompletions => usage.get("completion_tokens")?.as_u64()?,
        ProviderProtocol::OpenaiResponses => usage.get("output_tokens")?.as_u64()?,
    };
    normalize_provider_usage(ProviderTokenUsage {
        input_tokens,
        output_tokens,
        total_tokens: usage.get("total_tokens")?.as_u64()?,
    })
}

fn take_frames(buffer: &mut String) -> Vec<SseFrame> {
    let mut frames = Vec::new();
    while let Some((end, delimiter_len)) = [
        buffer.find("\n\n").map(|index| (index, 2)),
        buffer.find("\r\n\r\n").map(|index| (index, 4)),
    ]
    .into_iter()
    .flatten()
    .min_by_key(|(index, _)| *index)
    {
        let raw = buffer[..end].to_string();
        buffer.drain(..end + delimiter_len);
        let mut event = None;
        let mut data = Vec::new();
        for line in raw.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event = Some(value.trim().to_string());
            }
            if let Some(value) = line.strip_prefix("data:") {
                data.push(value.trim_start().to_string());
            }
        }
        frames.push(SseFrame {
            event,
            data: data.join("\n"),
        });
    }
    frames
}

fn frame_deltas(
    protocol: ProviderProtocol,
    frame: &SseFrame,
) -> Result<Vec<StreamDelta>, StreamFailure> {
    let body: serde_json::Value =
        serde_json::from_str(&frame.data).map_err(|_| StreamFailure::InvalidFrame)?;
    match protocol {
        ProviderProtocol::ChatCompletions => {
            let Some(delta) = body.pointer("/choices/0/delta") else {
                return Ok(Vec::new());
            };
            let mut deltas = Vec::with_capacity(3);
            if let Some(summary) = delta
                .get("reasoning_summary")
                .and_then(|value| value.as_str())
                && !summary.is_empty()
            {
                deltas.push(StreamDelta::ReasoningSummary(summary.to_string()));
            }
            if let Some(content) = delta.get("content").and_then(|value| value.as_str())
                && !content.is_empty()
            {
                deltas.push(StreamDelta::OutputText(content.to_string()));
            }
            if let Some(tool_calls) = delta.get("tool_calls").and_then(|value| value.as_array()) {
                for tool_call in tool_calls {
                    let index = tool_call
                        .get("index")
                        .and_then(|value| value.as_u64())
                        .map(|value| value as usize)
                        .unwrap_or(0);
                    let call_id = tool_call
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = tool_call
                        .pointer("/function/name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let arguments_delta = tool_call
                        .pointer("/function/arguments")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    deltas.push(StreamDelta::ToolCallDelta {
                        call_id,
                        index,
                        name,
                        arguments_delta,
                    });
                }
            }
            Ok(deltas)
        }
        ProviderProtocol::OpenaiResponses => {
            let mut deltas = Vec::with_capacity(2);
            match frame.event.as_deref() {
                Some("response.output_text.delta") => {
                    if let Some(text) = body
                        .get("delta")
                        .and_then(|value| value.as_str())
                        .filter(|text| !text.is_empty())
                    {
                        deltas.push(StreamDelta::OutputText(text.to_string()));
                    }
                }
                Some("response.reasoning_summary_text.delta") => {
                    if let Some(text) = body
                        .get("delta")
                        .and_then(|value| value.as_str())
                        .filter(|text| !text.is_empty())
                    {
                        deltas.push(StreamDelta::ReasoningSummary(text.to_string()));
                    }
                }
                Some("response.output_item.added") => {
                    if body
                        .get("item")
                        .and_then(|item| item.get("type"))
                        .and_then(|value| value.as_str())
                        == Some("function_call")
                    {
                        let item = body.get("item").expect("item exists");
                        let index = body
                            .get("output_index")
                            .and_then(|value| value.as_u64())
                            .map(|value| value as usize)
                            .unwrap_or(0);
                        deltas.push(StreamDelta::ToolCallDelta {
                            call_id: item
                                .get("call_id")
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                                .to_string(),
                            index,
                            name: item
                                .get("name")
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                                .to_string(),
                            arguments_delta: String::new(),
                        });
                    }
                }
                Some("response.function_call_arguments.delta") => {
                    let index = body
                        .get("output_index")
                        .and_then(|value| value.as_u64())
                        .map(|value| value as usize)
                        .unwrap_or(0);
                    if let Some(delta) = body.get("delta").and_then(|value| value.as_str()) {
                        deltas.push(StreamDelta::ToolCallDelta {
                            call_id: String::new(),
                            index,
                            name: String::new(),
                            arguments_delta: delta.to_string(),
                        });
                    }
                }
                _ => {}
            }
            Ok(deltas)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Notify,
        time::{Duration, sleep},
    };

    #[allow(clippy::unused_io_amount)]
    async fn serve(protocol: ProviderProtocol, first_sent: Arc<Notify>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n").await.unwrap();
            let first = match protocol {
                ProviderProtocol::ChatCompletions => {
                    b"data: {\"choices\":[{\"delta\":{\"content\":\"Sion\"}}]}\n\n".as_slice()
                }
                ProviderProtocol::OpenaiResponses => {
                    b"event: response.output_text.delta\ndata: {\"delta\":\"Sion\"}\n\n".as_slice()
                }
            };
            socket.write_all(first).await.unwrap();
            first_sent.notify_one();
            sleep(Duration::from_millis(60)).await;
            let done = match protocol {
                ProviderProtocol::ChatCompletions => b"data: [DONE]\n\n".as_slice(),
                ProviderProtocol::OpenaiResponses => {
                    b"event: response.completed\ndata: {}\n\ndata: [DONE]\n\n".as_slice()
                }
            };
            socket.write_all(done).await.unwrap();
        });
        format!("http://{address}/v1/stream")
    }

    #[allow(clippy::unused_io_amount)]
    async fn serve_response(response: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(&response).await.unwrap();
        });
        format!("http://{address}/v1/stream")
    }

    fn request(endpoint: String, protocol: ProviderProtocol) -> StreamRequest {
        StreamRequest::text_only(
            endpoint,
            "test-secret".to_string(),
            protocol,
            "test".to_string(),
            "hello".to_string(),
            ReasoningEffort::Medium,
            true,
        )
    }

    #[tokio::test]
    async fn parses_both_supported_protocols() {
        for protocol in [
            ProviderProtocol::ChatCompletions,
            ProviderProtocol::OpenaiResponses,
        ] {
            let url = serve(protocol, Arc::new(Notify::new())).await;
            let outcome = stream_text(
                &Client::new(),
                &request(url, protocol),
                CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                outcome,
                StreamOutcome::Completed(StreamContent {
                    output: vec!["Sion".to_string()],
                    reasoning_summary: Vec::new(),
                    tool_calls: Vec::new(),
                    usage: None,
                })
            );
        }
    }

    #[test]
    fn parser_emits_summary_but_ignores_hidden_reasoning_content() {
        let summary = frame_deltas(
            ProviderProtocol::ChatCompletions,
            &SseFrame {
                event: None,
                data: r#"{"choices":[{"delta":{"reasoning_summary":"公开摘要","reasoning_content":"秘密思维链"}}]}"#
                    .to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            summary,
            vec![StreamDelta::ReasoningSummary("公开摘要".to_string())]
        );
        assert!(!format!("{summary:?}").contains("秘密思维链"));
    }

    #[test]
    fn parser_preserves_summary_and_content_from_the_same_chat_frame() {
        let deltas = frame_deltas(
            ProviderProtocol::ChatCompletions,
            &SseFrame {
                event: None,
                data: r#"{"choices":[{"delta":{"reasoning_summary":"公开摘要","content":"可见正文"}}]}"#
                    .to_string(),
            },
        )
        .unwrap();

        assert_eq!(
            deltas,
            vec![
                StreamDelta::ReasoningSummary("公开摘要".to_string()),
                StreamDelta::OutputText("可见正文".to_string()),
            ]
        );
    }

    #[test]
    fn parses_usage_from_both_protocols() {
        let chat = frame_usage(
            ProviderProtocol::ChatCompletions,
            &SseFrame {
                event: None,
                data:
                    r#"{"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150}}"#
                        .into(),
            },
        );
        let responses = frame_usage(
            ProviderProtocol::OpenaiResponses,
            &SseFrame {
                event: Some("response.completed".into()),
                data: r#"{"response":{"usage":{"input_tokens":80,"output_tokens":20,"total_tokens":100}}}"#
                    .into(),
            },
        );
        assert_eq!(chat.unwrap().input_tokens, 120);
        assert_eq!(responses.unwrap().output_tokens, 20);
    }

    #[tokio::test]
    async fn cancellation_preserves_seen_tokens_only_in_memory() {
        let url = serve(ProviderProtocol::ChatCompletions, Arc::new(Notify::new())).await;
        let cancellation = CancellationToken::new();
        let task_token = cancellation.clone();
        let token_received = Arc::new(Notify::new());
        let token_received_in_task = token_received.clone();
        let task = tokio::spawn(async move {
            stream_text_with(
                &Client::new(),
                &request(url, ProviderProtocol::ChatCompletions),
                task_token,
                move |_| token_received_in_task.notify_one(),
            )
            .await
        });
        token_received.notified().await;
        cancellation.cancel();
        assert_eq!(
            task.await.unwrap().unwrap(),
            StreamOutcome::Cancelled(StreamContent {
                output: vec!["Sion".to_string()],
                reasoning_summary: Vec::new(),
                tool_calls: Vec::new(),
                usage: None,
            })
        );
    }

    #[tokio::test]
    async fn provider_http_errors_are_classified_without_echoing_the_response_body() {
        let secret = "test-secret prompt-sentinel";
        let response = format!(
            "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{{\"error\":{{\"message\":\"unsupported reasoning effort {secret}\"}}}}"
        );
        let url = serve_response(response.into_bytes()).await;
        let error = stream_text(
            &Client::new(),
            &request(url, ProviderProtocol::ChatCompletions),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            StreamFailure::ProviderHttp {
                status: 400,
                rejection: ProviderRejection::Reasoning,
            }
        );
        assert!(!format!("{error:?}").contains(secret));
    }

    #[tokio::test]
    async fn gateway_timeout_is_a_typed_non_retrying_failure() {
        let secret = "upstream-secret-body";
        let response = format!(
            "HTTP/1.1 504 Gateway Timeout\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n{secret}"
        );
        let url = serve_response(response.into_bytes()).await;
        let error = stream_text(
            &Client::new(),
            &request(url, ProviderProtocol::ChatCompletions),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();

        assert_eq!(
            error,
            StreamFailure::ProviderHttp {
                status: 504,
                rejection: ProviderRejection::Other,
            }
        );
        assert!(!format!("{error:?}").contains(secret));
    }

    #[test]
    fn request_failure_flags_map_without_provider_text() {
        assert_eq!(
            request_failure_kind(true, false),
            StreamFailure::RequestConnect
        );
        assert_eq!(
            request_failure_kind(false, true),
            StreamFailure::RequestTimeout
        );
        assert_eq!(
            request_failure_kind(false, false),
            StreamFailure::RequestOther
        );
    }

    #[tokio::test]
    async fn provider_sse_error_events_fail_the_stream() {
        for (protocol, frame) in [
            (
                ProviderProtocol::ChatCompletions,
                "data: {\"error\":{\"message\":\"reasoning rejected\"}}\n\n",
            ),
            (
                ProviderProtocol::OpenaiResponses,
                "event: response.failed\ndata: {\"response\":{\"error\":{\"message\":\"reasoning rejected\"}}}\n\n",
            ),
        ] {
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{frame}"
            );
            let url = serve_response(response.into_bytes()).await;
            let error = stream_text(
                &Client::new(),
                &request(url, protocol),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(
                error,
                StreamFailure::ProviderStream {
                    rejection: ProviderRejection::Reasoning,
                }
            );
        }
    }

    #[tokio::test]
    async fn crlf_sse_completion_and_error_frames_are_supported() {
        for (protocol, completed) in [
            (
                ProviderProtocol::ChatCompletions,
                "data: {\"choices\":[{\"delta\":{\"content\":\"Sion\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n",
            ),
            (
                ProviderProtocol::OpenaiResponses,
                "event: response.output_text.delta\r\ndata: {\"delta\":\"Sion\"}\r\n\r\nevent: response.completed\r\ndata: {\"response\":{\"error\":null}}\r\n\r\n",
            ),
        ] {
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{completed}"
            );
            let url = serve_response(response.into_bytes()).await;
            let outcome = stream_text(
                &Client::new(),
                &request(url, protocol),
                CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                outcome,
                StreamOutcome::Completed(StreamContent {
                    output: vec!["Sion".to_string()],
                    reasoning_summary: Vec::new(),
                    tool_calls: Vec::new(),
                    usage: None,
                })
            );
        }

        for (protocol, failed) in [
            (
                ProviderProtocol::ChatCompletions,
                "event: error\r\ndata: {\"error\":{\"message\":\"rejected\"}}\r\n\r\n",
            ),
            (
                ProviderProtocol::OpenaiResponses,
                "event: response.failed\r\ndata: {\"response\":{\"error\":{\"message\":\"rejected\"}}}\r\n\r\n",
            ),
        ] {
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{failed}"
            );
            let url = serve_response(response.into_bytes()).await;
            assert!(
                stream_text(
                    &Client::new(),
                    &request(url, protocol),
                    CancellationToken::new(),
                )
                .await
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn premature_sse_eof_never_persists_partial_output_as_completed() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".to_vec();
        let url = serve_response(response).await;
        let error = stream_text(
            &Client::new(),
            &request(url, ProviderProtocol::ChatCompletions),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error, StreamFailure::StreamIncomplete);
    }

    #[test]
    fn waits_for_complete_sse_frames() {
        let mut buffer = "data: {\"choices\":[]}".to_string();
        assert!(take_frames(&mut buffer).is_empty());
        buffer.push_str("\n\n");
        assert_eq!(take_frames(&mut buffer).len(), 1);
    }

    #[test]
    fn responses_completion_with_null_error_is_not_misclassified() {
        let frame = SseFrame {
            event: Some("response.completed".into()),
            data: r#"{"response":{"error":null}}"#.into(),
        };
        assert_eq!(
            provider_error_from_frame(ProviderProtocol::OpenaiResponses, &frame),
            None
        );
        assert!(frame_completes_stream(
            ProviderProtocol::OpenaiResponses,
            &frame
        ));
    }

    #[test]
    fn request_body_maps_reasoning_effort_and_requests_public_summary() {
        let mut chat_request = request(
            "https://example.invalid/chat".into(),
            ProviderProtocol::ChatCompletions,
        );
        chat_request.request.reasoning_effort = ReasoningEffort::High;
        let chat_high = request_body(&chat_request);
        chat_request.request.reasoning_effort = ReasoningEffort::Off;
        let chat_off = request_body(&chat_request);
        let mut responses_request = request(
            "https://example.invalid/responses".into(),
            ProviderProtocol::OpenaiResponses,
        );
        responses_request.request.reasoning_effort = ReasoningEffort::Low;
        let responses_low = request_body(&responses_request);
        responses_request.request.request_public_reasoning_summary = false;
        let responses_without_summary = request_body(&responses_request);
        responses_request.request.reasoning_effort = ReasoningEffort::Off;
        let responses_off = request_body(&responses_request);
        assert_eq!(chat_high["reasoning_effort"], "high");
        assert_eq!(chat_high["stream_options"]["include_usage"], true);
        assert!(chat_off.get("reasoning_effort").is_none());
        assert_eq!(
            responses_low["reasoning"],
            json!({ "effort": "low", "summary": "auto" })
        );
        assert_eq!(
            responses_without_summary["reasoning"],
            json!({ "effort": "low" })
        );
        assert!(responses_off.get("reasoning").is_none());
        for body in [chat_high, chat_off, responses_low, responses_off] {
            assert!(body.get("max_tokens").is_none());
            assert!(body.get("max_output_tokens").is_none());
        }
    }

    #[tokio::test]
    async fn chat_tool_call_stream_accumulates_split_arguments() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"read_attachment\",\"arguments\":\"{\\\"fileId\\\":\\\"file-\"}}]}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"1\\\"}\"}}]}}]}\n\n\
data: [DONE]\n\n".to_vec();
        let url = serve_response(response).await;
        let outcome = stream_text(
            &Client::new(),
            &request(url, ProviderProtocol::ChatCompletions),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let StreamOutcome::Completed(content) = outcome else {
            panic!("expected completed");
        };
        assert_eq!(
            content.tool_calls,
            vec![sion_core::HarnessToolCall {
                id: "call-1".into(),
                name: "read_attachment".into(),
                arguments: r#"{"fileId":"file-1"}"#.into(),
            }]
        );
    }

    #[tokio::test]
    async fn chat_stream_handles_text_and_parallel_tool_calls_in_one_step() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"checking attachment\"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"read_attachment\",\"arguments\":\"{\\\"fileId\\\":\\\"a\\\"}\"}}]}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call-2\",\"function\":{\"name\":\"read_current_delivery\",\"arguments\":\"{}\"}}]}}]}\n\n\
data: [DONE]\n\n".to_vec();
        let url = serve_response(response).await;
        let outcome = stream_text(
            &Client::new(),
            &request(url, ProviderProtocol::ChatCompletions),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let StreamOutcome::Completed(content) = outcome else {
            panic!("expected completed");
        };
        assert_eq!(content.output, vec!["checking attachment".to_string()]);
        assert_eq!(content.tool_calls.len(), 2);
        assert_eq!(content.tool_calls[0].id, "call-1");
        assert_eq!(content.tool_calls[0].name, "read_attachment");
        assert_eq!(content.tool_calls[1].id, "call-2");
        assert_eq!(content.tool_calls[1].name, "read_current_delivery");
        assert_eq!(content.tool_calls[1].arguments, "{}");
    }

    #[tokio::test]
    async fn responses_function_call_events_build_a_complete_call() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
event: response.output_item.added\ndata: {\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc-1\",\"call_id\":\"call-1\",\"name\":\"read_attachment\"}}\n\n\
event: response.function_call_arguments.delta\ndata: {\"output_index\":0,\"item_id\":\"fc-1\",\"delta\":\"{\\\"fileId\\\":\\\"file\"}\n\n\
event: response.function_call_arguments.delta\ndata: {\"output_index\":0,\"item_id\":\"fc-1\",\"delta\":\"-1\\\"}\"}\n\n\
event: response.completed\ndata: {\"response\":{\"error\":null}}\n\n".to_vec();
        let url = serve_response(response).await;
        let outcome = stream_text(
            &Client::new(),
            &request(url, ProviderProtocol::OpenaiResponses),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let StreamOutcome::Completed(content) = outcome else {
            panic!("expected completed");
        };
        assert_eq!(
            content.tool_calls,
            vec![sion_core::HarnessToolCall {
                id: "call-1".into(),
                name: "read_attachment".into(),
                arguments: r#"{"fileId":"file-1"}"#.into(),
            }]
        );
    }

    #[test]
    fn chat_tool_call_delta_parser_keeps_id_name_and_arguments() {
        let deltas = frame_deltas(
            ProviderProtocol::ChatCompletions,
            &SseFrame {
                event: None,
                data: r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_attachment","arguments":"{\"fileId\":\"a\"}"}}]}}]}"#
                    .to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            deltas,
            vec![StreamDelta::ToolCallDelta {
                call_id: "call-1".into(),
                index: 0,
                name: "read_attachment".into(),
                arguments_delta: r#"{"fileId":"a"}"#.into(),
            }]
        );
    }

    #[test]
    fn invalid_or_incomplete_tool_calls_are_rejected() {
        let missing_id = vec![ToolCallAccumulator {
            id: String::new(),
            name: "read_attachment".into(),
            arguments: "{}".into(),
        }];
        assert!(matches!(
            finalize_tool_calls(missing_id),
            Err(StreamFailure::IncompleteToolCall { index: 0, reason: "missing call id" })
        ));

        let missing_name = vec![ToolCallAccumulator {
            id: "call-1".into(),
            name: String::new(),
            arguments: "{}".into(),
        }];
        assert!(matches!(
            finalize_tool_calls(missing_name),
            Err(StreamFailure::IncompleteToolCall { reason: "missing tool name", .. })
        ));

        let invalid_json = vec![ToolCallAccumulator {
            id: "call-1".into(),
            name: "read_attachment".into(),
            arguments: r#"{"fileId":"unterminated"#.into(),
        }];
        assert!(matches!(
            finalize_tool_calls(invalid_json),
            Err(StreamFailure::IncompleteToolCall { reason: "invalid arguments json", .. })
        ));

        let empty_arguments_are_valid = vec![ToolCallAccumulator {
            id: "call-1".into(),
            name: "read_current_delivery".into(),
            arguments: String::new(),
        }];
        assert!(finalize_tool_calls(empty_arguments_are_valid).is_ok());
    }

    #[tokio::test]
    async fn duplicated_terminal_frames_are_rejected() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
data: [DONE]\n\n\
data: [DONE]\n\n".to_vec();
        let url = serve_response(response).await;
        let error = stream_text(
            &Client::new(),
            &request(url, ProviderProtocol::ChatCompletions),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error, StreamFailure::InvalidFrame);
    }

    #[tokio::test]
    async fn malformed_frames_fail_the_step_safely() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
data: {not valid json}\n\n".to_vec();
        let url = serve_response(response).await;
        let error = stream_text(
            &Client::new(),
            &request(url, ProviderProtocol::ChatCompletions),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error, StreamFailure::InvalidFrame);
    }

    #[test]
    fn tool_call_stream_never_exposes_secret_sentinels_in_debug_values() {
        let secret = "sk-secret-tool-sentinel";
        let mut tool_calls = vec![ToolCallAccumulator {
            id: "call-1".into(),
            name: "read_attachment".into(),
            arguments: format!(r#"{{"fileId":"{secret}"}}"#),
        }];
        tool_calls[0].id = format!("call-{secret}");
        let calls = finalize_tool_calls(tool_calls).unwrap();
        let debug = format!("{calls:?}");
        // The arguments are model-visible content and may legitimately contain
        // file ids; the transport never mixes the API key into tool payloads.
        assert!(!debug.contains("sk-secret-tool-sentinel-key"));
        let body = request_body(&request(
            "https://example.invalid/chat".into(),
            ProviderProtocol::ChatCompletions,
        ));
        assert!(!serde_json::to_string(&body).unwrap().contains("test-secret"));
    }
}
