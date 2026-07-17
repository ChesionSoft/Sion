//! Shared conversation preparation: agent prompt assembly, selected-file
//! loading, and deterministic input-context estimation. The prompt built here
//! is the exact string used both for context estimation and for the real run.

use sion_core::{
    ChatMessage, ChatRole, ContextEstimate, MessageAttachmentRef, WorkflowNode, WorkflowNodeId,
    agent_rule, estimate_context,
};
use sion_storage::ProjectStore;

const TRANSCRIPT_WINDOW: usize = 16;

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
    pub estimate: ContextEstimate,
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

pub fn build_agent_prompt(parts: ConversationParts<'_>) -> String {
    let mut transcript: Vec<String> = parts
        .messages
        .iter()
        .rev()
        .take(TRANSCRIPT_WINDOW)
        .rev()
        .map(|message| {
            format!(
                "{}: {}",
                match message.role {
                    ChatRole::User => "用户",
                    ChatRole::Assistant => "助手",
                    ChatRole::System => "系统",
                },
                message.content
            )
        })
        .collect();
    transcript.push(format!("用户: {}", parts.draft));
    let transcript_str = transcript.join("\n\n");
    let effective_rules = compose_effective_agent_rules(
        parts.node.id,
        parts.project_override.map(|rule| rule.to_string()),
    );
    let attachment_block = parts
        .attachments
        .iter()
        .map(|attachment| format!("## {}\n{}", attachment.original_name, attachment.text))
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "你是 Sion 桌面应用中负责项目设计文档的助手。不要浏览网页、不要声称调用过外部搜索。请基于当前节点、选定文件和会话，给出可直接用于设计文档的中文建议。\n\n必须在回复末尾提供且只提供一个 fenced delivery JSON 交付块。默认使用分节补丁，格式为：```delivery\n{{\"mode\":\"patch\",\"sections\":[{{\"title\":\"当前已有的二级章节名\",\"content\":\"该章节的新内容，不含 # 或 ## 标题\"}}]}}\n```。`title` 必须精确匹配当前 Markdown 中本节点已有的必填二级标题；`content` 只能包含该章节正文，可使用三级标题，不能包含一级或二级标题。只提交需要改动的章节。\n\n兼容例外：只有当用户明确要求整篇重写时，才可用 `{{\"mode\":\"rewrite\",\"markdown\":\"完整节点 Markdown\"}}`，且必须保留本节点所有必填二级标题。\n\n# 本节点规则\n{}\n\n# 选定文件\n{}\n\n# 当前节点\n{}\n\n# 当前 Markdown\n{}\n\n# 会话\n{}",
        effective_rules.effective_markdown,
        attachment_block,
        parts.node.id.as_str(),
        parts.node.markdown,
        transcript_str
    )
}

pub fn prepare_from_parts(
    parts: ConversationParts<'_>,
    context_window_tokens: u64,
) -> PreparedConversation {
    let attachments: Vec<MessageAttachmentRef> = parts
        .attachments
        .iter()
        .map(|attachment| MessageAttachmentRef {
            file_id: attachment.file_id.clone(),
            original_name: attachment.original_name.clone(),
        })
        .collect();
    let prompt = build_agent_prompt(parts);
    let estimate = estimate_context(&prompt, context_window_tokens);
    PreparedConversation {
        prompt,
        attachments,
        estimate,
    }
}

pub fn prepare_conversation(
    store: &ProjectStore,
    node_id: WorkflowNodeId,
    session_id: Option<&str>,
    draft: &str,
    file_ids: &[String],
    context_window_tokens: u64,
) -> Result<PreparedConversation, String> {
    let node = store.node(node_id).map_err(|error| error.to_string())?;
    let messages = match session_id {
        Some(session_id) => store
            .messages(node_id, session_id)
            .map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    let project_override = store
        .agent_override(node_id)
        .map_err(|error| error.to_string())?;
    let attachments = load_selected_files(store, file_ids)?;
    Ok(prepare_from_parts(
        ConversationParts {
            node: &node,
            messages: &messages,
            project_override: project_override.as_deref(),
            attachments: &attachments,
            draft,
        },
        context_window_tokens,
    ))
}

#[cfg(test)]
mod tests {
    use sion_core::{estimate_context, NodeStatus, WorkflowNode, WorkflowNodeId};

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
        );
        assert!(prepared.prompt.contains("当前草稿消息"));
        assert_eq!(prepared.prompt.matches("当前草稿消息").count(), 1);
        assert!(prepared.prompt.contains(&"中".repeat(60_000)));
        assert_eq!(prepared.estimate, estimate_context(&prepared.prompt, 100_000));
    }
}
