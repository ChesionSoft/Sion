//! Provider-neutral model request/protocol contract.
//!
//! Both supported transports (Chat Completions and OpenAI Responses) accept
//! exactly this request shape and emit the same normalized stream events. The
//! Harness loop consumes normalized events only and never branches on the
//! provider protocol; export runtimes keep a text-only compatibility wrapper
//! so they never enter the Harness in this phase.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sion_core::{HarnessToolCall, HarnessToolDefinition, ReasoningEffort};

use crate::model_stream::ProviderProtocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolMessageRole {
    System,
    User,
    Assistant,
    Tool,
}

impl ProtocolMessageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

/// One provider-neutral conversation message. `tool_calls` is set only on
/// assistant messages that requested tools; `tool_call_id` only on tool-result
/// messages. The transport serializers map this to the protocol's wire format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolMessage {
    pub role: ProtocolMessageRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<HarnessToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ProtocolMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: ProtocolMessageRole::System,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ProtocolMessageRole::User,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ProtocolMessageRole::Assistant,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    pub fn assistant_with_tool_calls(content: impl Into<String>, tool_calls: Vec<HarnessToolCall>) -> Self {
        Self {
            role: ProtocolMessageRole::Assistant,
            content: content.into(),
            tool_calls,
            tool_call_id: None,
        }
    }

    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: ProtocolMessageRole::Tool,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolChoice {
    #[default]
    Auto,
    None,
    Required,
}

impl ToolChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::None => "none",
            Self::Required => "required",
        }
    }
}

/// The full provider-neutral model request: ordered messages, native tool
/// definitions, tool-choice mode, model settings, and the summary flag. The
/// shared cancellation token travels separately with the transport call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    pub model: String,
    pub messages: Vec<ProtocolMessage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<HarnessToolDefinition>,
    #[serde(default)]
    pub tool_choice: ToolChoice,
    pub reasoning_effort: ReasoningEffort,
    pub request_public_reasoning_summary: bool,
}

impl ModelRequest {
    pub fn has_tools(&self) -> bool {
        !self.tools.is_empty()
    }
}

/// Serializes the request body exactly as the transport sends it. This is the
/// provider-neutral contract that both `chat_completions` and `openai_responses`
/// share; the body never contains the API key or any Authorization header.
pub fn serialize_request_body(protocol: ProviderProtocol, request: &ModelRequest) -> serde_json::Value {
    let mut body = match protocol {
        ProviderProtocol::ChatCompletions => json!({
            "model": request.model,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": serialize_chat_messages(request),
        }),
        ProviderProtocol::OpenaiResponses => json!({
            "model": request.model,
            "stream": true,
            "input": serialize_responses_input(request),
        }),
    };
    if request.has_tools() {
        match protocol {
            ProviderProtocol::ChatCompletions => {
                body["tools"] = json!(
                    request
                        .tools
                        .iter()
                        .map(|tool| json!({
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.parameters,
                            }
                        }))
                        .collect::<Vec<_>>()
                );
            }
            ProviderProtocol::OpenaiResponses => {
                body["tools"] = json!(
                    request
                        .tools
                        .iter()
                        .map(|tool| json!({
                            "type": "function",
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }))
                        .collect::<Vec<_>>()
                );
            }
        }
        body["tool_choice"] = json!(request.tool_choice.as_str());
    }
    if let Some(effort) = request.reasoning_effort.provider_value() {
        match protocol {
            ProviderProtocol::ChatCompletions => {
                body["reasoning_effort"] = json!(effort);
            }
            ProviderProtocol::OpenaiResponses => {
                body["reasoning"] = if request.request_public_reasoning_summary {
                    json!({ "effort": effort, "summary": "auto" })
                } else {
                    json!({ "effort": effort })
                };
            }
        }
    }
    body
}

fn serialize_chat_messages(request: &ModelRequest) -> Vec<serde_json::Value> {
    request
        .messages
        .iter()
        .map(|message| {
            let mut value = json!({
                "role": message.role.as_str(),
                "content": message.content,
            });
            if message.role == ProtocolMessageRole::Assistant && !message.tool_calls.is_empty() {
                value["tool_calls"] = json!(
                    message
                        .tool_calls
                        .iter()
                        .map(|call| json!({
                            "id": call.id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.arguments },
                        }))
                        .collect::<Vec<_>>()
                );
            }
            if message.role == ProtocolMessageRole::Tool
                && let Some(tool_call_id) = &message.tool_call_id
            {
                value["tool_call_id"] = json!(tool_call_id);
            }
            value
        })
        .collect()
}

fn serialize_responses_input(request: &ModelRequest) -> Vec<serde_json::Value> {
    let mut items = Vec::new();
    for message in &request.messages {
        match message.role {
            ProtocolMessageRole::System
            | ProtocolMessageRole::User
            | ProtocolMessageRole::Assistant => {
                if !message.content.is_empty() || message.tool_calls.is_empty() {
                    items.push(json!({
                        "type": "message",
                        "role": message.role.as_str(),
                        "content": message.content,
                    }));
                }
                for call in &message.tool_calls {
                    items.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }));
                }
            }
            ProtocolMessageRole::Tool => {
                items.push(json!({
                    "type": "function_call_output",
                    "call_id": message.tool_call_id.clone().unwrap_or_default(),
                    "output": message.content,
                }));
            }
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_core::HarnessToolDefinition;

    fn request() -> ModelRequest {
        ModelRequest {
            model: "model-1".into(),
            messages: vec![
                ProtocolMessage::system("系统指令"),
                ProtocolMessage::user("请查看附件"),
            ],
            tools: vec![HarnessToolDefinition {
                name: "read_attachment".into(),
                description: "读取附件".into(),
                parameters: json!({
                    "type": "object",
                    "properties": { "fileId": { "type": "string" } },
                    "required": ["fileId"],
                    "additionalProperties": false,
                }),
            }],
            tool_choice: ToolChoice::Auto,
            reasoning_effort: ReasoningEffort::Medium,
            request_public_reasoning_summary: true,
        }
    }

    #[test]
    fn chat_completions_request_serializes_messages_and_tools() {
        let body = serialize_request_body(ProviderProtocol::ChatCompletions, &request());
        assert_eq!(body["model"], "model-1");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "read_attachment");
        assert_eq!(
            body["tools"][0]["function"]["parameters"]["additionalProperties"],
            false
        );
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn responses_request_serializes_input_items_and_tools() {
        let mut request = request();
        request.messages.push(ProtocolMessage::assistant_with_tool_calls(
            "",
            vec![HarnessToolCall {
                id: "call-1".into(),
                name: "read_attachment".into(),
                arguments: r#"{"fileId":"file-1"}"#.into(),
            }],
        ));
        request
            .messages
            .push(ProtocolMessage::tool("call-1", "附件正文"));
        let body = serialize_request_body(ProviderProtocol::OpenaiResponses, &request);
        assert_eq!(body["model"], "model-1");
        assert_eq!(body["input"][0]["type"], "message");
        assert_eq!(body["input"][0]["role"], "system");
        assert_eq!(body["input"][2]["type"], "function_call");
        assert_eq!(body["input"][2]["call_id"], "call-1");
        assert_eq!(body["input"][2]["name"], "read_attachment");
        assert_eq!(body["input"][3]["type"], "function_call_output");
        assert_eq!(body["input"][3]["output"], "附件正文");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "read_attachment");
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn tool_choice_and_messages_round_trip_through_serde() {
        let request = request();
        let value = serde_json::to_value(&request).unwrap();
        let back: ModelRequest = serde_json::from_value(value).unwrap();
        assert_eq!(back, request);
        assert_eq!(back.tool_choice, ToolChoice::Auto);
        assert_eq!(back.messages[0].role, ProtocolMessageRole::System);
    }

    #[test]
    fn no_tools_means_no_tool_choice_field() {
        let mut request = request();
        request.tools = Vec::new();
        let body = serialize_request_body(ProviderProtocol::ChatCompletions, &request);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
        let body = serialize_request_body(ProviderProtocol::OpenaiResponses, &request);
        assert!(body.get("tools").is_none());
    }
}
