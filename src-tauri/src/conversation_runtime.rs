//! Shared conversation preparation: agent prompt assembly, selected-file
//! loading, and deterministic input-context estimation. The prompt built here
//! is the exact string used both for context estimation and for the real run.

use sion_core::{
    ChatMessage, ChatRole, ContextUsageBreakdown, ConversationContextSnapshot,
    CumulativeTokenUsage, MessageAttachmentRef, WorkflowNode, WorkflowNodeId, agent_rule,
    aggregate_message_usage, estimate_context, estimate_input_tokens,
};
use sion_storage::ProjectStore;

const PROTOCOL: &str = "你是 Sion 桌面应用中负责项目设计文档的助手。不要浏览网页、不要声称调用过外部搜索。请基于当前节点、选定文件和会话，给出可直接用于设计文档的中文建议。不要输出隐藏思维链。\n\n回复正文先给出可见说明，然后在末尾提供且只提供一个 fenced delivery 交付块，二选一：\n- 无需修改：```delivery\n{\"mode\":\"unchanged\"}\n```\n- 分节补丁：```delivery\n{\"mode\":\"patch\",\"sections\":[{\"title\":\"当前已有的二级章节名\",\"content\":\"该章节的新内容，不含 # 或 ## 标题\"}]}\n```\n常规对话默认使用 unchanged；只有需要改动交付稿时才用 patch。不要使用整篇 rewrite。`title` 必须精确匹配当前 Markdown 中本节点已有的必填二级标题；`content` 只能包含该章节正文，可使用三级标题，不能包含一级或二级标题。只提交需要改动的章节。";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EffectiveAgentRules {
    pub(crate) built_in_markdown: String,
    pub(crate) custom_markdown: Option<String>,
    pub(crate) effective_markdown: String,
}

pub(crate) fn compose_effective_agent_rules(
    node_id: WorkflowNodeId,
    custom_markdown: Option<String>,
) -> EffectiveAgentRules {
    let built_in_markdown = agent_rule(node_id).to_string();
    let custom_markdown = custom_markdown
        .map(|markdown| markdown.trim().to_string())
        .filter(|markdown| !markdown.is_empty());
    let effective_markdown = custom_markdown
        .as_deref()
        .map(|custom| format!("{built_in_markdown}\n\n# 项目覆盖规则\n{custom}"))
        .unwrap_or_else(|| built_in_markdown.clone());
    EffectiveAgentRules {
        built_in_markdown,
        custom_markdown,
        effective_markdown,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedFileContext {
    pub file_id: String,
    pub original_name: String,
    pub text: String,
}

pub struct ConversationParts<'a> {
    pub node: &'a WorkflowNode,
    pub messages: &'a [ChatMessage],
    pub project_override: Option<&'a str>,
    pub attachments: &'a [SelectedFileContext],
    pub draft: &'a str,
}

#[derive(Debug, Clone)]
pub struct PreparedConversation {
    pub prompt: String,
    pub attachments: Vec<MessageAttachmentRef>,
    pub snapshot: ConversationContextSnapshot,
}

struct PromptSections {
    protocol: String,
    rules: String,
    attachments: String,
    node_label: String,
    node_markdown: String,
    transcript: String,
}

pub fn load_selected_files(
    store: &ProjectStore,
    file_ids: &[String],
) -> Result<Vec<SelectedFileContext>, String> {
    let files = store.list_files().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for id in file_ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let file = files
            .iter()
            .find(|file| &file.id == id)
            .ok_or_else(|| format!("selected file {id} was not found"))?;
        let text = store
            .read_file_text(id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("selected file {} has no extracted text", file.original_name))?;
        result.push(SelectedFileContext {
            file_id: file.id.clone(),
            original_name: file.original_name.clone(),
            text,
        });
    }
    Ok(result)
}

fn role_label(role: &ChatRole) -> &'static str {
    match role {
        ChatRole::User => "用户",
        ChatRole::Assistant => "助手",
        ChatRole::System => "系统",
    }
}

fn full_transcript(messages: &[ChatMessage], draft: &str) -> String {
    let mut transcript: Vec<String> = messages
        .iter()
        .map(|message| format!("{}: {}", role_label(&message.role), message.content))
        .collect();
    if !draft.is_empty() {
        transcript.push(format!("用户: {}", draft));
    }
    transcript.join("\n\n")
}

fn attachment_block(attachments: &[SelectedFileContext]) -> String {
    attachments
        .iter()
        .map(|attachment| format!("## {}\n{}", attachment.original_name, attachment.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn prompt_sections(parts: ConversationParts<'_>) -> PromptSections {
    let effective_rules = compose_effective_agent_rules(
        parts.node.id,
        parts.project_override.map(|rule| rule.to_string()),
    );
    PromptSections {
        protocol: PROTOCOL.to_string(),
        rules: effective_rules.effective_markdown,
        attachments: attachment_block(parts.attachments),
        node_label: parts.node.id.as_str().to_string(),
        node_markdown: parts.node.markdown.clone(),
        transcript: full_transcript(parts.messages, parts.draft),
    }
}

fn prompt_from_sections(sections: &PromptSections) -> String {
    format!(
        "{}\n\n# 本节点规则\n{}\n\n# 选定文件\n{}\n\n# 当前节点\n{}\n\n# 当前 Markdown\n{}\n\n# 会话\n{}",
        sections.protocol,
        sections.rules,
        sections.attachments,
        sections.node_label,
        sections.node_markdown,
        sections.transcript,
    )
}

#[allow(dead_code)]
pub fn build_agent_prompt(parts: ConversationParts<'_>) -> String {
    prompt_from_sections(&prompt_sections(parts))
}

pub fn snapshot_for_prompt(
    prompt: &str,
    context_window_tokens: u64,
    cumulative_usage: CumulativeTokenUsage,
    calculated_at: &str,
) -> ConversationContextSnapshot {
    let estimate = estimate_context(prompt, context_window_tokens);
    ConversationContextSnapshot {
        estimated_input_tokens: estimate.estimated_input_tokens,
        context_window_tokens: estimate.context_window_tokens,
        ratio: estimate.ratio,
        status: estimate.status,
        breakdown: ContextUsageBreakdown {
            protocol_tokens: estimate.estimated_input_tokens,
            rules_tokens: 0,
            node_markdown_tokens: 0,
            conversation_tokens: 0,
            attachment_tokens: 0,
        },
        cumulative_usage,
        calculated_at: calculated_at.to_string(),
    }
}

#[allow(dead_code)]
pub fn build_delivery_retry_prompt(
    node: &WorkflowNode,
    messages: &[ChatMessage],
    assistant_message: &ChatMessage,
    rules: &str,
) -> String {
    format!(
        "你是 Sion 桌面应用中负责项目设计文档的助手。不要浏览网页、不要声称调用过外部搜索。不要输出隐藏思维链。\n\n此前助手回复如下：\n{}\n\n请仅基于最新保存的交付稿重新判断，在末尾提供且只提供一个 fenced delivery 交付块，二选一：\n- 无需修改：```delivery\n{{\"mode\":\"unchanged\"}}\n```\n- 分节补丁：```delivery\n{{\"mode\":\"patch\",\"sections\":[{{\"title\":\"当前已有的二级章节名\",\"content\":\"该章节的新内容\"}}]}}\n```\n不要使用整篇 rewrite。\n\n# 本节点规则\n{}\n\n# 当前节点\n{}\n\n# 当前 Markdown\n{}\n\n# 会话\n{}",
        assistant_message.content,
        rules,
        node.id.as_str(),
        node.markdown,
        full_transcript(messages, "")
    )
}

#[allow(dead_code)]
pub fn build_delivery_regeneration_prompt(
    node: &WorkflowNode,
    messages: &[ChatMessage],
    attachments: &[SelectedFileContext],
    effective_rules: &str,
) -> String {
    format!(
        "你是 Sion 桌面应用中负责项目设计文档的助手。不要浏览网页、不要声称调用过外部搜索。不要输出隐藏思维链。请基于当前节点、选定文件和会话，重新生成本节点的完整交付稿。\n\n输出完整 Markdown，包含本节点所有必填二级标题。不要输出 delivery 交付块，不要在前后添加解释说明。\n\n# 本节点规则\n{}\n\n# 选定文件\n{}\n\n# 当前节点\n{}\n\n# 当前 Markdown\n{}\n\n# 会话\n{}",
        effective_rules,
        attachment_block(attachments),
        node.id.as_str(),
        node.markdown,
        full_transcript(messages, "")
    )
}

pub fn prepare_from_parts(
    parts: ConversationParts<'_>,
    context_window_tokens: u64,
    calculated_at: &str,
) -> PreparedConversation {
    let attachments: Vec<MessageAttachmentRef> = parts
        .attachments
        .iter()
        .map(|attachment| MessageAttachmentRef {
            file_id: attachment.file_id.clone(),
            original_name: attachment.original_name.clone(),
        })
        .collect();
    let messages = parts.messages;
    let sections = prompt_sections(parts);
    let prompt = prompt_from_sections(&sections);
    let estimate = estimate_context(&prompt, context_window_tokens);
    let snapshot = ConversationContextSnapshot {
        estimated_input_tokens: estimate.estimated_input_tokens,
        context_window_tokens: estimate.context_window_tokens,
        ratio: estimate.ratio,
        status: estimate.status,
        breakdown: ContextUsageBreakdown {
            protocol_tokens: estimate_input_tokens(&sections.protocol),
            rules_tokens: estimate_input_tokens(&sections.rules),
            node_markdown_tokens: estimate_input_tokens(&sections.node_markdown),
            conversation_tokens: estimate_input_tokens(&sections.transcript),
            attachment_tokens: estimate_input_tokens(&sections.attachments),
        },
        cumulative_usage: aggregate_message_usage(messages),
        calculated_at: calculated_at.to_string(),
    };
    PreparedConversation {
        prompt,
        attachments,
        snapshot,
    }
}

pub fn prepare_conversation(
    store: &ProjectStore,
    node_id: WorkflowNodeId,
    session_id: Option<&str>,
    draft: &str,
    file_ids: &[String],
    context_window_tokens: u64,
    calculated_at: &str,
) -> Result<PreparedConversation, String> {
    let node = store.node(node_id).map_err(|error| error.to_string())?;
    let messages = match session_id {
        Some(session_id) => store
            .messages(node_id, session_id)
            .map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    let cumulative_usage = match session_id {
        Some(session_id) => Some(
            store
                .session_usage(node_id, session_id)
                .map_err(|error| error.to_string())?,
        ),
        None => None,
    };
    let project_override = store
        .agent_override(node_id)
        .map_err(|error| error.to_string())?;
    let attachments = load_selected_files(store, file_ids)?;
    let mut prepared = prepare_from_parts(
        ConversationParts {
            node: &node,
            messages: &messages,
            project_override: project_override.as_deref(),
            attachments: &attachments,
            draft,
        },
        context_window_tokens,
        calculated_at,
    );
    if let Some(cumulative_usage) = cumulative_usage {
        prepared.snapshot.cumulative_usage = cumulative_usage;
    }
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use sion_core::{
        ChatRole, MessageAttachmentRef, NodeStatus, WorkflowNode, WorkflowNodeId,
        estimate_input_tokens,
    };

    use super::*;

    #[test]
    fn prompt_and_estimate_share_the_exact_final_text() {
        let node = WorkflowNode {
            id: WorkflowNodeId::Goals,
            status: NodeStatus::Draft,
            markdown: "# 项目目标".into(),
            revision: 0,
            updated_at: "now".into(),
        };
        let attachments = vec![SelectedFileContext {
            file_id: "file-a".into(),
            original_name: "长文件.md".into(),
            text: "中".repeat(60_000),
        }];
        let prepared = prepare_from_parts(
            ConversationParts {
                node: &node,
                messages: &[],
                project_override: None,
                attachments: &attachments,
                draft: "当前草稿消息",
            },
            100_000,
            "now",
        );
        assert!(prepared.prompt.contains("当前草稿消息"));
        assert_eq!(prepared.prompt.matches("当前草稿消息").count(), 1);
        assert!(prepared.prompt.contains(&"中".repeat(60_000)));
        assert_eq!(
            prepared.snapshot.estimated_input_tokens,
            estimate_input_tokens(&prepared.prompt)
        );
    }

    #[test]
    fn prompt_contains_all_visible_messages_without_reasoning_or_old_file_text() {
        let node = WorkflowNode {
            id: WorkflowNodeId::Goals,
            status: NodeStatus::Draft,
            markdown: "# 项目目标".into(),
            revision: 0,
            updated_at: "now".into(),
        };
        let mut messages = (0..20)
            .map(|index| ChatMessage {
                id: format!("m-{index}"),
                role: if index % 2 == 0 {
                    ChatRole::User
                } else {
                    ChatRole::Assistant
                },
                content: format!("visible-{index}"),
                reasoning_content: None,
                sources: None,
                created_at: "now".into(),
                turn_id: None,
                reasoning_duration_ms: None,
                usage: None,
                attachments: vec![],
                model_execution: None,
            })
            .collect::<Vec<_>>();
        messages[0].reasoning_content = Some("hidden-sentinel".into());
        messages[0].attachments = vec![MessageAttachmentRef {
            file_id: "old-file-body-sentinel".into(),
            original_name: "old.md".into(),
        }];

        let prepared = prepare_from_parts(
            ConversationParts {
                node: &node,
                messages: &messages,
                project_override: None,
                attachments: &[],
                draft: "new draft",
            },
            128_000,
            "now",
        );
        assert!(prepared.prompt.contains("visible-0"));
        assert!(prepared.prompt.contains("visible-19"));
        assert!(!prepared.prompt.contains("hidden-sentinel"));
        assert!(!prepared.prompt.contains("old-file-body-sentinel"));
        assert_eq!(
            prepared.snapshot.estimated_input_tokens,
            estimate_input_tokens(&prepared.prompt)
        );
        assert!(prepared.snapshot.breakdown.conversation_tokens > 0);
        assert!(prepared.snapshot.breakdown.protocol_tokens > 0);
    }

    #[test]
    fn conversation_prompt_requires_an_explicit_delivery_decision() {
        let node = WorkflowNode {
            id: WorkflowNodeId::Goals,
            status: NodeStatus::Draft,
            markdown: "# 需求背景与建设目标\n\n## 需求背景\n已有\n\n## 建设目标\n已有\n\n## 范围边界\n已有"
                .into(),
            revision: 7,
            updated_at: "2026-07-18T00:00:00Z".into(),
        };
        let prompt = build_agent_prompt(ConversationParts {
            node: &node,
            messages: &[],
            project_override: None,
            attachments: &[],
            draft: "只回答，不修改",
        });
        assert!(prompt.contains(r#"{"mode":"unchanged"}"#));
        assert!(prompt.contains(r#"{"mode":"patch","sections"#));
        assert!(prompt.contains("不要输出隐藏思维链"));
        assert!(!prompt.contains("每轮必须修改"));
    }

    #[test]
    fn retry_and_regeneration_prompts_carry_context_without_a_delivery_fence() {
        let node = WorkflowNode {
            id: WorkflowNodeId::Goals,
            status: NodeStatus::Draft,
            markdown: "# 需求背景与建设目标\n\n## 需求背景\n已有\n\n## 建设目标\n已有\n\n## 范围边界\n已有"
                .into(),
            revision: 7,
            updated_at: "now".into(),
        };
        let assistant = ChatMessage {
            id: "a-1".into(),
            role: ChatRole::Assistant,
            content: "此前回复".into(),
            reasoning_content: None,
            sources: None,
            created_at: "now".into(),
            turn_id: None,
            reasoning_duration_ms: None,
            usage: None,
            attachments: Vec::new(),
            model_execution: None,
        };
        let attachments = vec![SelectedFileContext {
            file_id: "file-1".into(),
            original_name: "brief.md".into(),
            text: "历史附件正文".into(),
        }];
        let retry = build_delivery_retry_prompt(&node, &[], &assistant, "当前自定义规则");
        assert!(retry.contains("此前回复"));
        assert!(retry.contains(r#"{"mode":"unchanged"}"#));
        let regen = build_delivery_regeneration_prompt(&node, &[], &attachments, "当前自定义规则");
        assert!(regen.contains("历史附件正文"));
        assert!(regen.contains("当前自定义规则"));
        assert!(regen.contains("输出完整 Markdown"));
        assert!(!regen.contains("```delivery"));
    }
}
