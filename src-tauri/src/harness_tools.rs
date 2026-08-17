//! Typed, security-scoped document tools for the Harness runtime.
//!
//! The model can inspect only approved project documents through ID-based,
//! bounded tools. Attachments and dependency nodes are strictly read-only; the
//! registry has no generic path, network, shell, browser, attachment-write, or
//! cross-node-write capability. Tool arguments use trusted project IDs only,
//! and tool execution never calls a node/override save function.

// The harness runtime gains its orchestration callers in Tasks 7 and 8.
#![allow(dead_code)]

use std::sync::OnceLock;

use sion_core::{
    HarnessToolCall, HarnessToolDefinition, HarnessToolStatus, WorkflowNode, WorkflowNodeId,
};
use sion_storage::ProjectStore;

use crate::dependency_context::{self, DependencyNodeContext};
use crate::harness_scope::HarnessScope;
use crate::harness_search::{HarnessSearchIndex, SearchDocument};

/// Maximum characters returned for one attachment chunk or section body.
const MAX_TOOL_EXCERPT_CHARS: usize = 8_000;
/// Maximum characters for a search query or dependency section heading.
const MAX_QUERY_CHARS: usize = 200;
/// Maximum number of search hits returned per call.
const MAX_SEARCH_RESULTS: usize = 8;
/// Maximum characters of each search excerpt.
const MAX_SEARCH_EXCERPT_CHARS: usize = 600;

/// Result of executing one tool call: the content sent back to the model, a
/// safe public summary for the durable trace, and the execution status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolExecution {
    pub(crate) status: HarnessToolStatus,
    pub(crate) content: String,
    pub(crate) summary: String,
}

/// A safe, redacted tool error. The message never contains storage paths,
/// internal error text, or secrets. Shared with the proposal service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolError {
    InvalidArguments(String),
    Unauthorized(String),
    NotFound(String),
    ReadFailed(String),
}

impl ToolError {
    pub(crate) fn into_execution(self) -> ToolExecution {
        let (status, content, summary) = match self {
            Self::InvalidArguments(message) => (
                HarnessToolStatus::Error,
                format!("工具参数错误：{message}"),
                "工具参数错误".to_string(),
            ),
            Self::Unauthorized(message) => (
                HarnessToolStatus::Unauthorized,
                format!("无权访问：{message}"),
                "拒绝未授权调用".to_string(),
            ),
            Self::NotFound(message) => (
                HarnessToolStatus::Error,
                format!("未找到：{message}"),
                "资源不存在".to_string(),
            ),
            Self::ReadFailed(message) => (
                HarnessToolStatus::Error,
                format!("读取失败：{message}"),
                "读取失败".to_string(),
            ),
        };
        ToolExecution {
            status,
            content,
            summary,
        }
    }
}

fn tool(
    name: &str,
    description: &str,
    parameters: serde_json::Value,
) -> HarnessToolDefinition {
    HarnessToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        parameters,
    }
}

/// The read-only tool set exposed to a Harness turn. Proposal tools are added
/// separately in the proposal registry; rule tools appear only when authorized.
pub(crate) fn tool_definitions() -> Vec<HarnessToolDefinition> {
    vec![
        tool(
            "list_project_attachments",
            "列出当前项目的全部附件（ID、名称、类型、提取状态）。附件只读，正文需用 read_attachment 读取。",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "read_attachment",
            "按 fileId 读取当前项目附件正文的下一段。cursor 是上一次返回的续读游标；首次调用不带 cursor。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "fileId": { "type": "string", "maxLength": 64 },
                    "cursor": { "type": "string", "maxLength": 80 }
                },
                "required": ["fileId"],
                "additionalProperties": false
            }),
        ),
        tool(
            "list_dependency_sections",
            "按 nodeId 列出授权依赖节点的章节标题清单。只读依赖节点，正文用 read_dependency_section 读取。",
            serde_json::json!({
                "type": "object",
                "properties": { "nodeId": { "type": "string" } },
                "required": ["nodeId"],
                "additionalProperties": false
            }),
        ),
        tool(
            "read_dependency_section",
            "按 nodeId 与精确章节标题读取授权依赖节点某个二级章节的正文。只读。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "nodeId": { "type": "string" },
                    "heading": { "type": "string", "maxLength": 200 }
                },
                "required": ["nodeId", "heading"],
                "additionalProperties": false
            }),
        ),
        tool(
            "search_allowed_context",
            "在当前交付稿、有效 Agent 规则、授权依赖节点和当前项目附件中做字面关键词搜索。返回带摘录的匹配结果。",
            serde_json::json!({
                "type": "object",
                "properties": { "query": { "type": "string", "maxLength": 200 } },
                "required": ["query"],
                "additionalProperties": false
            }),
        ),
        tool(
            "read_current_delivery",
            "读取当前节点交付稿的完整 Markdown（含 revision）。当前节点是唯一可写节点，但读取不产生任何更改。",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "read_effective_agent_rule",
            "读取当前节点的有效 Agent 规则（内置规则与项目覆盖规则合并后的文本）。只读。",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
    ]
}

/// Per-turn typed tool registry frozen against an immutable `HarnessScope`.
/// It preloads the current node, authorized dependency bodies, the effective
/// rule, and the in-memory search index; tool calls can never widen the scope.
pub(crate) struct HarnessToolRegistry<'a> {
    scope: &'a HarnessScope,
    store: &'a ProjectStore,
    node: WorkflowNode,
    dependency_nodes: Vec<DependencyNodeContext>,
    effective_rules: String,
    search_index: OnceLock<HarnessSearchIndex>,
}

impl<'a> HarnessToolRegistry<'a> {
    pub(crate) fn new(scope: &'a HarnessScope, store: &'a ProjectStore) -> Result<Self, String> {
        let node = store
            .node(scope.node_id)
            .map_err(|_| "当前节点交付稿读取失败".to_string())?;
        let dependency_nodes = dependency_context::load(store, scope.node_id)?;
        Ok(Self {
            scope,
            store,
            node,
            dependency_nodes,
            effective_rules: scope.rule_snapshot.effective_markdown.clone(),
            search_index: OnceLock::new(),
        })
    }

    /// Validates and executes one tool call. Unauthorized calls fail closed and
    /// consume no write authority; errors are redacted to safe public text.
    pub(crate) fn execute(&self, call: &HarnessToolCall) -> ToolExecution {
        let result = match call.name.as_str() {
            "list_project_attachments" => self.list_project_attachments(),
            "read_attachment" => self.read_attachment(&call.arguments),
            "list_dependency_sections" => self.list_dependency_sections(&call.arguments),
            "read_dependency_section" => self.read_dependency_section(&call.arguments),
            "search_allowed_context" => self.search_allowed_context(&call.arguments),
            "read_current_delivery" => self.read_current_delivery(),
            "read_effective_agent_rule" => self.read_effective_agent_rule(),
            other => Err(ToolError::InvalidArguments(format!(
                "未知工具：{other}"
            ))),
        };
        match result {
            Ok(execution) => execution,
            Err(error) => error.into_execution(),
        }
    }

    /// Validates one read tool call against its schema and the frozen scope
    /// without executing it. Used for whole-batch validation before any call
    /// in a provider step runs.
    pub(crate) fn validate(&self, call: &HarnessToolCall) -> Result<(), ToolError> {
        match call.name.as_str() {
            "list_project_attachments" => {
                validate_tool_arguments(&tool_by_name("list_project_attachments"), &call.arguments)?;
                Ok(())
            }
            "read_attachment" => {
                let arguments =
                    validate_tool_arguments(&tool_by_name("read_attachment"), &call.arguments)?;
                let file_id = required_string(&arguments, "fileId")?;
                if !self.scope.attachment_ids.iter().any(|id| id == file_id) {
                    return Err(ToolError::Unauthorized(
                        "该附件不属于当前项目".to_string(),
                    ));
                }
                Ok(())
            }
            "list_dependency_sections" => {
                let arguments = validate_tool_arguments(
                    &tool_by_name("list_dependency_sections"),
                    &call.arguments,
                )?;
                let node_id = required_node_id(&arguments, "nodeId")?;
                self.require_dependency(&node_id)
            }
            "read_dependency_section" => {
                let arguments = validate_tool_arguments(
                    &tool_by_name("read_dependency_section"),
                    &call.arguments,
                )?;
                let node_id = required_node_id(&arguments, "nodeId")?;
                self.require_dependency(&node_id)?;
                let heading = required_string(&arguments, "heading")?;
                if heading.chars().count() > MAX_QUERY_CHARS {
                    return Err(ToolError::InvalidArguments("章节标题过长".to_string()));
                }
                Ok(())
            }
            "search_allowed_context" => {
                let arguments = validate_tool_arguments(
                    &tool_by_name("search_allowed_context"),
                    &call.arguments,
                )?;
                let query = required_string(&arguments, "query")?;
                if query.trim().is_empty() {
                    return Err(ToolError::InvalidArguments("搜索词不能为空".to_string()));
                }
                if query.chars().count() > MAX_QUERY_CHARS {
                    return Err(ToolError::InvalidArguments("搜索词过长".to_string()));
                }
                Ok(())
            }
            "read_current_delivery" => {
                validate_tool_arguments(&tool_by_name("read_current_delivery"), &call.arguments)?;
                Ok(())
            }
            "read_effective_agent_rule" => {
                validate_tool_arguments(&tool_by_name("read_effective_agent_rule"), &call.arguments)?;
                Ok(())
            }
            other => Err(ToolError::InvalidArguments(format!("未知工具：{other}"))),
        }
    }

    fn list_project_attachments(&self) -> Result<ToolExecution, ToolError> {
        let files = self
            .store
            .list_files()
            .map_err(|_| ToolError::ReadFailed("无法读取项目附件索引".to_string()))?;
        if files.is_empty() {
            return Ok(ToolExecution {
                status: HarnessToolStatus::Completed,
                content: "当前项目没有任何附件。".to_string(),
                summary: "项目无附件".to_string(),
            });
        }
        let manifest = files
            .iter()
            .map(|file| {
                let kind = file
                    .kind
                    .as_ref()
                    .map(|kind| format!("{kind:?}").to_lowercase())
                    .unwrap_or_else(|| "unknown".to_string());
                let status = file
                    .extraction_status
                    .as_ref()
                    .map(|status| format!("{status:?}").to_lowercase())
                    .unwrap_or_else(|| "unsupported".to_string());
                format!(
                    "<attachment id=\"{}\" name=\"{}\" kind=\"{}\" extraction=\"{}\" characters=\"{}\" />",
                    file.id,
                    file.original_name,
                    kind,
                    status,
                    file.character_count.unwrap_or(0),
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!("当前项目共有 {} 个附件：\n{manifest}", files.len()),
            summary: "已列出项目附件".to_string(),
        })
    }

    fn read_attachment(&self, args: &str) -> Result<ToolExecution, ToolError> {
        let arguments = validate_tool_arguments(&tool_by_name("read_attachment"), args)?;
        let file_id = required_string(&arguments, "fileId")?;
        if !self.scope.attachment_ids.iter().any(|id| id == file_id) {
            return Err(ToolError::Unauthorized(
                "该附件不属于当前项目".to_string(),
            ));
        }
        let cursor = optional_string(&arguments, "cursor")?;
        let file = self
            .store
            .list_files()
            .map_err(|_| ToolError::ReadFailed("无法读取项目附件索引".to_string()))?
            .into_iter()
            .find(|file| file.id == file_id)
            .ok_or_else(|| ToolError::NotFound("附件不存在".to_string()))?;
        let text = self
            .store
            .read_file_text(file_id)
            .map_err(|_| ToolError::ReadFailed("附件正文读取失败".to_string()))?
            .ok_or_else(|| ToolError::ReadFailed("该附件没有可用的提取文本".to_string()))?;
        let start = match cursor {
            Some(cursor) => parse_attachment_cursor(cursor, file_id)?,
            None => 0,
        };
        let (chunk, truncated, next_cursor) =
            chunk_attachment_text(&text, start, file_id, MAX_TOOL_EXCERPT_CHARS);
        let continuation = match next_cursor {
            Some(next) => format!(
                "\n\n[正文未结束。继续读取请再次调用 read_attachment，fileId 不变，cursor=\"{next}\"]"
            ),
            None => String::new(),
        };
        let characters = text.chars().count();
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!(
                "<attachment id=\"{}\" name=\"{}\" characters=\"{}\" truncated=\"{}\">\n{chunk}\n</attachment>{continuation}",
                file.id, file.original_name, characters, truncated
            ),
            summary: format!("已读取附件“{}”", file.original_name),
        })
    }

    fn list_dependency_sections(&self, args: &str) -> Result<ToolExecution, ToolError> {
        let arguments = validate_tool_arguments(&tool_by_name("list_dependency_sections"), args)?;
        let node_id = required_node_id(&arguments, "nodeId")?;
        self.require_dependency(&node_id)?;
        let node = self
            .store
            .node(node_id)
            .map_err(|_| ToolError::ReadFailed("依赖节点交付稿读取失败".to_string()))?;
        let headings = dependency_context::markdown_section_headings(&node.markdown);
        let heading_text = if headings.is_empty() {
            "（无章节）".to_string()
        } else {
            headings
                .iter()
                .map(|heading| format!("- ## {heading}"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!(
                "<dependency-node id=\"{}\" revision=\"{}\">\n{heading_text}\n</dependency-node>",
                node_id.as_str(),
                node.revision
            ),
            summary: "已列出依赖章节".to_string(),
        })
    }

    fn read_dependency_section(&self, args: &str) -> Result<ToolExecution, ToolError> {
        let arguments = validate_tool_arguments(&tool_by_name("read_dependency_section"), args)?;
        let node_id = required_node_id(&arguments, "nodeId")?;
        self.require_dependency(&node_id)?;
        let heading = required_string(&arguments, "heading")?;
        if heading.chars().count() > MAX_QUERY_CHARS {
            return Err(ToolError::InvalidArguments("章节标题过长".to_string()));
        }
        let node = self
            .store
            .node(node_id)
            .map_err(|_| ToolError::ReadFailed("依赖节点交付稿读取失败".to_string()))?;
        let body = dependency_context::dependency_section_body(&node.markdown, heading)
            .ok_or_else(|| ToolError::NotFound("该章节不存在".to_string()))?;
        let (bounded, truncated) = bound_text(&body, MAX_TOOL_EXCERPT_CHARS);
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!(
                "<dependency-section node=\"{}\" heading=\"{}\" truncated=\"{}\">\n{bounded}\n</dependency-section>",
                node_id.as_str(),
                heading,
                truncated
            ),
            summary: format!("已读取依赖章节“{heading}”"),
        })
    }

    fn search_allowed_context(&self, args: &str) -> Result<ToolExecution, ToolError> {
        let arguments = validate_tool_arguments(&tool_by_name("search_allowed_context"), args)?;
        let query = required_string(&arguments, "query")?;
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(ToolError::InvalidArguments("搜索词过长".to_string()));
        }
        if query.trim().is_empty() {
            return Err(ToolError::InvalidArguments("搜索词不能为空".to_string()));
        }
        let index = self.search_index.get_or_init(|| self.build_search_index());
        let hits = index.search(query, MAX_SEARCH_RESULTS, MAX_SEARCH_EXCERPT_CHARS);
        if hits.is_empty() {
            return Ok(ToolExecution {
                status: HarnessToolStatus::Completed,
                content: format!("未找到与“{query}”匹配的内容。"),
                summary: "搜索无结果".to_string(),
            });
        }
        let body = hits
            .iter()
            .map(|hit| format!("<hit source=\"{}\">\n{}\n</hit>", hit.label, hit.excerpt))
            .collect::<Vec<_>>()
            .join("\n\n");
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!("搜索“{query}”共 {} 条结果：\n\n{body}", hits.len()),
            summary: format!("搜索得到 {} 条结果", hits.len()),
        })
    }

    fn read_current_delivery(&self) -> Result<ToolExecution, ToolError> {
        let (bounded, truncated) = bound_text(&self.node.markdown, MAX_TOOL_EXCERPT_CHARS);
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!(
                "<current-delivery revision=\"{}\" truncated=\"{}\">\n{bounded}\n</current-delivery>",
                self.node.revision, truncated
            ),
            summary: "已读取当前交付稿".to_string(),
        })
    }

    fn read_effective_agent_rule(&self) -> Result<ToolExecution, ToolError> {
        let (bounded, truncated) = bound_text(&self.effective_rules, MAX_TOOL_EXCERPT_CHARS);
        Ok(ToolExecution {
            status: HarnessToolStatus::Completed,
            content: format!(
                "<effective-agent-rule truncated=\"{}\">\n{bounded}\n</effective-agent-rule>",
                truncated
            ),
            summary: "已读取有效 Agent 规则".to_string(),
        })
    }

    fn require_dependency(&self, node_id: &WorkflowNodeId) -> Result<(), ToolError> {
        if self.scope.allowed_dependency_ids.contains(node_id) {
            Ok(())
        } else {
            Err(ToolError::Unauthorized(
                "该节点不在授权依赖范围内".to_string(),
            ))
        }
    }

    /// Builds the per-turn in-memory search index from approved documents only.
    fn build_search_index(&self) -> HarnessSearchIndex {
        let mut documents = vec![
            SearchDocument {
                label: "当前交付稿".into(),
                text: self.node.markdown.clone(),
            },
            SearchDocument {
                label: "有效 Agent 规则".into(),
                text: self.effective_rules.clone(),
            },
        ];
        for dependency in &self.dependency_nodes {
            documents.push(SearchDocument {
                label: format!("依赖节点：{}", dependency.title),
                text: dependency.markdown.clone(),
            });
        }
        if let Ok(files) = self.store.list_files() {
            for file in files {
                if !self.scope.attachment_ids.iter().any(|id| id == &file.id) {
                    continue;
                }
                if let Ok(Some(text)) = self.store.read_file_text(&file.id) {
                    documents.push(SearchDocument {
                        label: format!("附件：{}", file.original_name),
                        text,
                    });
                }
            }
        }
        HarnessSearchIndex::new(documents)
    }
}

fn tool_by_name(name: &str) -> HarnessToolDefinition {
    tool_definitions()
        .into_iter()
        .find(|definition| definition.name == name)
        .expect("every dispatched tool has a definition")
}

/// Bounds a text excerpt to `max_chars`, reporting explicit truncation.
fn bound_text(text: &str, max_chars: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max_chars {
        (text.to_string(), false)
    } else {
        (text.chars().take(max_chars).collect(), true)
    }
}

/// Splits `text` into bounded chunks, returning the chunk, whether more content
/// remains, and the opaque continuation cursor bound to this exact file.
fn chunk_attachment_text(
    text: &str,
    start: usize,
    file_id: &str,
    max_chars: usize,
) -> (String, bool, Option<String>) {
    let chars: Vec<char> = text.chars().collect();
    if start >= chars.len() {
        return (String::new(), false, None);
    }
    let end = (start + max_chars).min(chars.len());
    let chunk: String = chars[start..end].iter().collect();
    let truncated = end < chars.len();
    let next_cursor = truncated.then(|| format!("{file_id}:{end}"));
    (chunk, truncated, next_cursor)
}

/// Parses an opaque attachment cursor. The cursor embeds the file id and the
/// next character offset; it is validated against the requested file id so it
/// can never select a different resource.
fn parse_attachment_cursor(cursor: &str, file_id: &str) -> Result<usize, ToolError> {
    let Some((embedded, offset)) = cursor.rsplit_once(':') else {
        return Err(ToolError::InvalidArguments("游标无效".to_string()));
    };
    if embedded != file_id {
        return Err(ToolError::InvalidArguments(
            "游标与请求的附件不匹配".to_string(),
        ));
    }
    offset
        .parse::<usize>()
        .map_err(|_| ToolError::InvalidArguments("游标无效".to_string()))
}

fn required_string<'a>(
    arguments: &'a serde_json::Value,
    name: &str,
) -> Result<&'a str, ToolError> {
    arguments
        .get(name)
        .and_then(|value| value.as_str())
        .ok_or_else(|| ToolError::InvalidArguments(format!("缺少字符串参数 {name}")))
}

fn optional_string<'a>(
    arguments: &'a serde_json::Value,
    name: &str,
) -> Result<Option<&'a str>, ToolError> {
    match arguments.get(name) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| ToolError::InvalidArguments(format!("参数 {name} 必须是字符串"))),
    }
}

fn required_node_id(arguments: &serde_json::Value, name: &str) -> Result<WorkflowNodeId, ToolError> {
    let raw = required_string(arguments, name)?;
    WorkflowNodeId::try_from(raw).map_err(|_| {
        ToolError::InvalidArguments(format!("未知的节点标识 {name}"))
    })
}

/// Validates tool arguments against the tool's strict JSON schema: the payload
/// must be a JSON object, unknown fields are rejected (`additionalProperties:
/// false`), required fields must be present, and string fields must respect
/// their declared max length. Shared with the proposal service.
pub(crate) fn validate_tool_arguments(
    definition: &HarnessToolDefinition,
    args: &str,
) -> Result<serde_json::Value, ToolError> {
    let arguments: serde_json::Value = serde_json::from_str(args)
        .map_err(|_| ToolError::InvalidArguments("参数必须是有效的 JSON 对象".to_string()))?;
    let object = arguments
        .as_object()
        .ok_or_else(|| ToolError::InvalidArguments("参数必须是 JSON 对象".to_string()))?;
    let properties = definition
        .parameters
        .get("properties")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let additional_rejected = definition
        .parameters
        .get("additionalProperties")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if additional_rejected {
        for key in object.keys() {
            if !properties.contains_key(key) {
                return Err(ToolError::InvalidArguments(format!("未知参数：{key}")));
            }
        }
    }
    if let Some(required) = definition
        .parameters
        .get("required")
        .and_then(|value| value.as_array())
    {
        for name in required {
            let name = name
                .as_str()
                .ok_or_else(|| ToolError::InvalidArguments("schema required 无效".to_string()))?;
            if !object.contains_key(name) {
                return Err(ToolError::InvalidArguments(format!("缺少必填参数：{name}")));
            }
        }
    }
    for (key, value) in object {
        let property = properties
            .get(key)
            .ok_or_else(|| ToolError::InvalidArguments(format!("未知参数：{key}")))?;
        let expected = property.get("type").and_then(|value| value.as_str());
        let type_ok = match expected {
            Some("string") => value.is_string(),
            Some("integer") => value.is_i64() || value.is_u64(),
            _ => true,
        };
        if !type_ok {
            return Err(ToolError::InvalidArguments(format!("参数 {key} 类型错误")));
        }
        if let Some(text) = value.as_str()
            && let Some(max_length) = property.get("maxLength").and_then(|value| value.as_u64())
            && text.chars().count() as u64 > max_length
        {
            return Err(ToolError::InvalidArguments(format!(
                "参数 {key} 超过长度限制"
            )));
        }
    }
    Ok(arguments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_core::{
        ChatModelSelection, NodeStatus, ReasoningEffort, agent_override_digest,
    };
    use sion_storage::{CreateProjectInput, SaveNodeResult};
    use std::path::PathBuf;

    fn fixture() -> (PathBuf, ProjectStore) {
        let root =
            std::env::temp_dir().join(format!("sion-harness-tools-{}", uuid::Uuid::new_v4()));
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
        (root, ProjectStore::at(projects.join("project-1")))
    }

    fn selection() -> ChatModelSelection {
        ChatModelSelection {
            provider_id: "provider-1".into(),
            model: "model-1".into(),
            reasoning_effort: ReasoningEffort::Medium,
        }
    }

    fn save_body(store: &ProjectStore, id: WorkflowNodeId, markdown: &str) {
        assert!(matches!(
            store
                .save_node_if_revision(id, 0, markdown.into(), NodeStatus::Generated, "later".into())
                .unwrap(),
            SaveNodeResult::Saved(_)
        ));
    }

    fn scope_for(store: &ProjectStore, root: &PathBuf, session_id: &str) -> HarnessScope {
        crate::harness_scope::freeze_harness_scope(
            store,
            root.join("projects/project-1"),
            "project-1".into(),
            WorkflowNodeId::Goals,
            session_id,
            "你好",
            selection(),
        )
        .unwrap()
    }

    fn completed(execution: &ToolExecution) {
        assert_eq!(execution.status, HarnessToolStatus::Completed, "{}", execution.content);
    }

    #[test]
    fn reads_current_delivery_and_effective_rule_without_writes() {
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n当前正文",
        );
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = scope_for(&store, &root, &session.id);
        let registry = HarnessToolRegistry::new(&scope, &store).unwrap();
        let delivery = registry.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "read_current_delivery".into(),
            arguments: "{}".into(),
        });
        completed(&delivery);
        assert!(delivery.content.contains("当前正文"));
        assert!(delivery.content.contains("revision=\"1\""));
        let rule = registry.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "read_effective_agent_rule".into(),
            arguments: "{}".into(),
        });
        completed(&rule);
        assert!(rule.content.contains("Agent"));
        // Reading must not change the stored node.
        assert_eq!(
            store.node(WorkflowNodeId::Goals).unwrap().revision,
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_read_is_bounded_and_cursor_bound_to_the_file() {
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n正文",
        );
        let source = root.join("long.md");
        std::fs::write(&source, "甲".repeat(20_000)).unwrap();
        let imported = store.import_file(&source, "now".into()).unwrap();
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = scope_for(&store, &root, &session.id);
        let registry = HarnessToolRegistry::new(&scope, &store).unwrap();

        let first = registry.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "read_attachment".into(),
            arguments: format!(r#"{{"fileId":"{}"}}"#, imported.id),
        });
        completed(&first);
        assert!(first.content.contains("truncated=\"true\""));
        let cursor = first
            .content
            .split("cursor=\"")
            .nth(1)
            .and_then(|part| part.split('"').next())
            .expect("first chunk returns a continuation cursor");
        assert!(cursor.starts_with(&imported.id));

        let second = registry.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "read_attachment".into(),
            arguments: format!(r#"{{"fileId":"{}","cursor":"{cursor}"}}"#, imported.id),
        });
        completed(&second);
        assert!(second.content.contains(&imported.id));

        // A cursor from another file (or a forged one) is rejected.
        let forged = registry.execute(&HarnessToolCall {
            id: "c-3".into(),
            name: "read_attachment".into(),
            arguments: format!(r#"{{"fileId":"{}","cursor":"other-file:100"}}"#, imported.id),
        });
        assert_eq!(forged.status, HarnessToolStatus::Error);
        assert!(forged.content.contains("不匹配"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dependency_section_read_works_and_non_dependency_ids_fail_closed() {
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n基础正文\n\n## 项目边界\n边界正文",
        );
        save_body(
            &store,
            WorkflowNodeId::FeatureDesign,
            "# 功能模块设计\n\n## 功能模块清单\n未授权节点正文",
        );
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n目标正文",
        );
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = scope_for(&store, &root, &session.id);
        let registry = HarnessToolRegistry::new(&scope, &store).unwrap();

        let sections = registry.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "list_dependency_sections".into(),
            arguments: r#"{"nodeId":"basic-info"}"#.into(),
        });
        completed(&sections);
        assert!(sections.content.contains("基础信息表"));
        assert!(sections.content.contains("项目边界"));

        let body = registry.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "read_dependency_section".into(),
            arguments: r#"{"nodeId":"basic-info","heading":"项目边界"}"#.into(),
        });
        completed(&body);
        assert!(body.content.contains("边界正文"));
        assert!(!body.content.contains("基础正文"));

        // A non-dependency node is refused even though it exists in the project.
        let unauthorized = registry.execute(&HarnessToolCall {
            id: "c-3".into(),
            name: "read_dependency_section".into(),
            arguments: r#"{"nodeId":"feature-design","heading":"功能模块清单"}"#.into(),
        });
        assert_eq!(unauthorized.status, HarnessToolStatus::Unauthorized);

        // Traversal-like ids and unknown node ids are rejected before execution.
        let traversal = registry.execute(&HarnessToolCall {
            id: "c-4".into(),
            name: "read_dependency_section".into(),
            arguments: r#"{"nodeId":"../outside","heading":"x"}"#.into(),
        });
        assert_eq!(traversal.status, HarnessToolStatus::Error);
        assert!(!traversal.content.contains("projects"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_covers_only_approved_documents() {
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n项目代号 ALPHA",
        );
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n项目代号 BETA",
        );
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = scope_for(&store, &root, &session.id);
        let registry = HarnessToolRegistry::new(&scope, &store).unwrap();
        let hit = registry.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "search_allowed_context".into(),
            arguments: r#"{"query":"ALPHA"}"#.into(),
        });
        completed(&hit);
        assert!(hit.content.contains("依赖节点"));
        let miss = registry.execute(&HarnessToolCall {
            id: "c-2".into(),
            name: "search_allowed_context".into(),
            arguments: r#"{"query":"不存在的词"}"#.into(),
        });
        completed(&miss);
        assert!(miss.content.contains("未找到"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_fields_and_wrong_types_are_rejected_before_execution() {
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n正文",
        );
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = scope_for(&store, &root, &session.id);
        let registry = HarnessToolRegistry::new(&scope, &store).unwrap();
        for args in [
            r#"{"fileId":"x","extra":1}"#,
            r#"{"fileId":123}"#,
            r#"{"query":"a","query2":"b"}"#,
            r#"not json"#,
            r#"[]"#,
        ] {
            let result = registry.execute(&HarnessToolCall {
                id: "c-1".into(),
                name: "read_attachment".into(),
                arguments: args.into(),
            });
            assert_eq!(result.status, HarnessToolStatus::Error, "{args}");
            assert!(!result.content.contains("secret"));
        }
    }

    #[test]
    fn attachment_extraction_failure_returns_metadata_not_file_content() {
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n正文",
        );
        let source = root.join("broken.pdf");
        std::fs::write(&source, b"%PDF-not-a-real-document").unwrap();
        let imported = store.import_file(&source, "now".into()).unwrap();
        assert_eq!(imported.extraction_status, Some(sion_core::FileExtractionStatus::Failed));
        let session = store
            .create_session(WorkflowNodeId::Goals, "讨论".into(), None, "now".into())
            .unwrap();
        let scope = scope_for(&store, &root, &session.id);
        let registry = HarnessToolRegistry::new(&scope, &store).unwrap();
        let result = registry.execute(&HarnessToolCall {
            id: "c-1".into(),
            name: "read_attachment".into(),
            arguments: format!(r#"{{"fileId":"{}"}}"#, imported.id),
        });
        assert_eq!(result.status, HarnessToolStatus::Error);
        assert!(!result.content.contains("projects"));
        assert!(result.content.contains("没有可用的提取文本"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rule_digest_is_stable_for_the_snapshot() {
        assert_eq!(
            agent_override_digest(None),
            agent_override_digest(None)
        );
    }
}
