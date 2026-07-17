//! OpenAI-compatible SSE transport with explicit cancellation semantics.

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sion_core::ReasoningEffort;
use tokio_util::sync::CancellationToken;

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
    pub model: String,
    pub prompt: String,
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StreamOutcome {
    Completed(Vec<String>),
    Cancelled(Vec<String>),
}

pub async fn stream_text(
    client: &Client,
    request: &StreamRequest,
    cancellation: CancellationToken,
) -> Result<StreamOutcome, String> {
    stream_text_with(client, request, cancellation, |_| {}).await
}

pub async fn stream_text_with<F>(
    client: &Client,
    request: &StreamRequest,
    cancellation: CancellationToken,
    mut on_token: F,
) -> Result<StreamOutcome, String>
where
    F: FnMut(&str),
{
    let body = request_body(request);
    let response = client
        .post(&request.endpoint)
        .bearer_auth(&request.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("model request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "model provider returned HTTP {}",
            response.status()
        ));
    }

    let mut bytes = response.bytes_stream();
    let mut buffer = String::new();
    let mut tokens = Vec::new();
    loop {
        let next = tokio::select! {
            _ = cancellation.cancelled() => return Ok(StreamOutcome::Cancelled(tokens)),
            next = bytes.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|error| format!("model stream read failed: {error}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        for frame in take_frames(&mut buffer) {
            if frame.data == "[DONE]" {
                return Ok(StreamOutcome::Completed(tokens));
            }
            if let Some(token) = token_from_frame(request.protocol, &frame)? {
                on_token(&token);
                tokens.push(token);
            }
        }
    }
    Ok(StreamOutcome::Completed(tokens))
}

pub fn request_body(request: &StreamRequest) -> serde_json::Value {
    let mut body = match request.protocol {
        ProviderProtocol::ChatCompletions => json!({
            "model": request.model,
            "stream": true,
            "messages": [{"role": "user", "content": request.prompt}]
        }),
        ProviderProtocol::OpenaiResponses => json!({
            "model": request.model,
            "stream": true,
            "input": request.prompt
        }),
    };
    if let Some(effort) = request.reasoning_effort.provider_value() {
        match request.protocol {
            ProviderProtocol::ChatCompletions => {
                body["reasoning_effort"] = json!(effort);
            }
            ProviderProtocol::OpenaiResponses => {
                body["reasoning"] = json!({ "effort": effort });
            }
        }
    }
    body
}

#[derive(Debug)]
struct SseFrame {
    event: Option<String>,
    data: String,
}

fn take_frames(buffer: &mut String) -> Vec<SseFrame> {
    let mut frames = Vec::new();
    while let Some(end) = buffer.find("\n\n") {
        let raw = buffer[..end].to_string();
        buffer.drain(..end + 2);
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

fn token_from_frame(
    protocol: ProviderProtocol,
    frame: &SseFrame,
) -> Result<Option<String>, String> {
    let body: serde_json::Value = serde_json::from_str(&frame.data)
        .map_err(|error| format!("invalid model SSE JSON: {error}"))?;
    match protocol {
        ProviderProtocol::ChatCompletions => Ok(body
            .pointer("/choices/0/delta/content")
            .and_then(|value| value.as_str())
            .map(ToString::to_string)),
        ProviderProtocol::OpenaiResponses => {
            if frame.event.as_deref() != Some("response.output_text.delta") {
                return Ok(None);
            }
            Ok(body
                .get("delta")
                .and_then(|value| value.as_str())
                .map(ToString::to_string))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Notify,
        time::{Duration, sleep},
    };

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

    fn request(endpoint: String, protocol: ProviderProtocol) -> StreamRequest {
        StreamRequest {
            endpoint,
            api_key: "test-secret".to_string(),
            protocol,
            model: "test".to_string(),
            prompt: "hello".to_string(),
            reasoning_effort: ReasoningEffort::Medium,
        }
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
            assert_eq!(outcome, StreamOutcome::Completed(vec!["Sion".to_string()]));
        }
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
            StreamOutcome::Cancelled(vec!["Sion".to_string()])
        );
    }

    #[test]
    fn waits_for_complete_sse_frames() {
        let mut buffer = "data: {\"choices\":[]}".to_string();
        assert!(take_frames(&mut buffer).is_empty());
        buffer.push_str("\n\n");
        assert_eq!(take_frames(&mut buffer).len(), 1);
    }

    #[test]
    fn request_body_maps_reasoning_effort_without_output_limits() {
        let mut chat_request = request(
            "https://example.invalid/chat".into(),
            ProviderProtocol::ChatCompletions,
        );
        chat_request.reasoning_effort = ReasoningEffort::High;
        let chat_high = request_body(&chat_request);
        chat_request.reasoning_effort = ReasoningEffort::Off;
        let chat_off = request_body(&chat_request);
        let mut responses_request = request(
            "https://example.invalid/responses".into(),
            ProviderProtocol::OpenaiResponses,
        );
        responses_request.reasoning_effort = ReasoningEffort::Low;
        let responses_low = request_body(&responses_request);
        responses_request.reasoning_effort = ReasoningEffort::Off;
        let responses_off = request_body(&responses_request);
        assert_eq!(chat_high["reasoning_effort"], "high");
        assert!(chat_off.get("reasoning_effort").is_none());
        assert_eq!(responses_low["reasoning"]["effort"], "low");
        assert!(responses_off.get("reasoning").is_none());
        for body in [chat_high, chat_off, responses_low, responses_off] {
            assert!(body.get("max_tokens").is_none());
            assert!(body.get("max_output_tokens").is_none());
        }
    }
}
