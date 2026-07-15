use futures_util::StreamExt;
use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy)]
pub enum ProviderProtocol {
    ChatCompletions,
    Responses,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StreamOutcome {
    Completed(Vec<String>),
    Cancelled(Vec<String>),
}

pub async fn stream_text(
    client: &Client,
    endpoint: &str,
    protocol: ProviderProtocol,
    cancellation: CancellationToken,
) -> Result<StreamOutcome, String> {
    stream_text_with_observer(client, endpoint, protocol, cancellation, None).await
}

async fn stream_text_with_observer(
    client: &Client,
    endpoint: &str,
    protocol: ProviderProtocol,
    cancellation: CancellationToken,
    token_observer: Option<Arc<Notify>>,
) -> Result<StreamOutcome, String> {
    let body = match protocol {
        ProviderProtocol::ChatCompletions => json!({
            "model": "spike", "stream": true,
            "messages": [{"role": "user", "content": "hello"}]
        }),
        ProviderProtocol::Responses => json!({
            "model": "spike", "stream": true,
            "input": "hello"
        }),
    };
    let response = client
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("provider returned an error: {error}"))?;

    let mut bytes = response.bytes_stream();
    let mut buffer = String::new();
    let mut tokens = Vec::new();
    loop {
        let next = tokio::select! {
            _ = cancellation.cancelled() => return Ok(StreamOutcome::Cancelled(tokens)),
            next = bytes.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|error| format!("stream read failed: {error}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        for frame in take_frames(&mut buffer) {
            if frame.data == "[DONE]" {
                return Ok(StreamOutcome::Completed(tokens));
            }
            if let Some(token) = token_from_frame(protocol, &frame)? {
                tokens.push(token);
                if let Some(observer) = &token_observer {
                    observer.notify_one();
                }
            }
        }
    }
    Ok(StreamOutcome::Completed(tokens))
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
    let body: serde_json::Value =
        serde_json::from_str(&frame.data).map_err(|error| format!("invalid SSE JSON: {error}"))?;
    match protocol {
        ProviderProtocol::ChatCompletions => Ok(body
            .pointer("/choices/0/delta/content")
            .and_then(|value| value.as_str())
            .map(ToString::to_string)),
        ProviderProtocol::Responses => {
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::Notify;
    use tokio::time::{Duration, sleep};

    async fn serve_sse(protocol: ProviderProtocol, first_frame_sent: Arc<Notify>) -> String {
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
                ProviderProtocol::Responses => {
                    b"event: response.output_text.delta\ndata: {\"delta\":\"Sion\"}\n\n".as_slice()
                }
            };
            socket.write_all(first).await.unwrap();
            first_frame_sent.notify_one();
            sleep(Duration::from_millis(60)).await;
            let done = match protocol {
                ProviderProtocol::ChatCompletions => b"data: [DONE]\n\n".as_slice(),
                ProviderProtocol::Responses => {
                    b"event: response.completed\ndata: {}\n\ndata: [DONE]\n\n".as_slice()
                }
            };
            socket.write_all(done).await.unwrap();
        });
        format!("http://{address}/v1/stream")
    }

    #[tokio::test]
    async fn parses_chat_completions_sse() {
        let url = serve_sse(ProviderProtocol::ChatCompletions, Arc::new(Notify::new())).await;
        let result = stream_text(
            &Client::new(),
            &url,
            ProviderProtocol::ChatCompletions,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result, StreamOutcome::Completed(vec!["Sion".to_string()]));
    }

    #[tokio::test]
    async fn parses_responses_sse() {
        let url = serve_sse(ProviderProtocol::Responses, Arc::new(Notify::new())).await;
        let result = stream_text(
            &Client::new(),
            &url,
            ProviderProtocol::Responses,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result, StreamOutcome::Completed(vec!["Sion".to_string()]));
    }

    #[tokio::test]
    async fn cancellation_stops_an_open_stream_without_losing_seen_tokens() {
        let first_frame_sent = Arc::new(Notify::new());
        let token_observed = Arc::new(Notify::new());
        let url = serve_sse(ProviderProtocol::ChatCompletions, first_frame_sent).await;
        let cancellation = CancellationToken::new();
        let cancellation_for_task = cancellation.clone();
        let token_observer_for_task = token_observed.clone();
        let client = Client::new();
        let endpoint = url.clone();
        let reader = tokio::spawn(async move {
            stream_text_with_observer(
                &client,
                &endpoint,
                ProviderProtocol::ChatCompletions,
                cancellation_for_task,
                Some(token_observer_for_task),
            )
            .await
        });
        token_observed.notified().await;
        cancellation.cancel();
        let result = reader.await.unwrap().unwrap();
        assert_eq!(result, StreamOutcome::Cancelled(vec!["Sion".to_string()]));
    }

    #[test]
    fn consumes_only_complete_sse_frames() {
        let mut buffer = "data: {\"choices\":[]}".to_string();
        assert!(take_frames(&mut buffer).is_empty());
        buffer.push_str("\n\n");
        assert_eq!(take_frames(&mut buffer).len(), 1);
    }
}
