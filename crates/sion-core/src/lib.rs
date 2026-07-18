//! Pure domain types and default workflow content for Sion Desktop.
//!
//! This crate deliberately has no dependency on Tauri, HTTP, or the filesystem.

use serde::{Deserialize, Serialize};
use thiserror::Error;

mod conversation;
mod conversation_turn;
pub use conversation::*;
pub use conversation_turn::*;

pub const PROJECT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowNodeId {
    BasicInfo,
    Goals,
    RolesPermissions,
    BusinessFlow,
    FeatureDesign,
    PageInteraction,
    DataStructure,
    ApiDesign,
    ArchitectureDeployment,
    DevelopmentTasks,
    RisksOpenQuestions,
    FinalExport,
}

impl WorkflowNodeId {
    pub const ALL: [Self; 12] = [
        Self::BasicInfo,
        Self::Goals,
        Self::RolesPermissions,
        Self::BusinessFlow,
        Self::FeatureDesign,
        Self::PageInteraction,
        Self::DataStructure,
        Self::ApiDesign,
        Self::ArchitectureDeployment,
        Self::DevelopmentTasks,
        Self::RisksOpenQuestions,
        Self::FinalExport,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::BasicInfo => "basic-info",
            Self::Goals => "goals",
            Self::RolesPermissions => "roles-permissions",
            Self::BusinessFlow => "business-flow",
            Self::FeatureDesign => "feature-design",
            Self::PageInteraction => "page-interaction",
            Self::DataStructure => "data-structure",
            Self::ApiDesign => "api-design",
            Self::ArchitectureDeployment => "architecture-deployment",
            Self::DevelopmentTasks => "development-tasks",
            Self::RisksOpenQuestions => "risks-open-questions",
            Self::FinalExport => "final-export",
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("unknown workflow node: {0}")]
pub struct UnknownWorkflowNode(pub String);

impl TryFrom<&str> for WorkflowNodeId {
    type Error = UnknownWorkflowNode;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        WorkflowNodeId::ALL
            .into_iter()
            .find(|node| node.as_str() == value)
            .ok_or_else(|| UnknownWorkflowNode(value.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkflowNodeDefinition {
    pub id: WorkflowNodeId,
    pub order: u8,
    pub title: &'static str,
    pub document_heading: &'static str,
    pub required_for_initialization: bool,
    pub depends_on: &'static [WorkflowNodeId],
    pub agent_rule_file: &'static str,
    pub required_sections: &'static [&'static str],
}

pub const WORKFLOW: [WorkflowNodeDefinition; 12] = [
    WorkflowNodeDefinition {
        id: WorkflowNodeId::BasicInfo,
        order: 1,
        title: "项目基本信息",
        document_heading: "1. 项目基本信息",
        required_for_initialization: true,
        depends_on: &[],
        agent_rule_file: "01-basic-info.md",
        required_sections: &["基础信息表", "项目边界"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::Goals,
        order: 2,
        title: "需求背景与建设目标",
        document_heading: "2. 需求背景与建设目标",
        required_for_initialization: true,
        depends_on: &[WorkflowNodeId::BasicInfo],
        agent_rule_file: "02-goals.md",
        required_sections: &["需求背景", "建设目标", "范围边界"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::RolesPermissions,
        order: 3,
        title: "用户角色与权限",
        document_heading: "3. 用户角色与权限",
        required_for_initialization: false,
        depends_on: &[WorkflowNodeId::BasicInfo, WorkflowNodeId::Goals],
        agent_rule_file: "03-roles-permissions.md",
        required_sections: &["角色清单"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::BusinessFlow,
        order: 4,
        title: "业务流程设计",
        document_heading: "4. 业务流程设计",
        required_for_initialization: false,
        depends_on: &[
            WorkflowNodeId::BasicInfo,
            WorkflowNodeId::Goals,
            WorkflowNodeId::RolesPermissions,
        ],
        agent_rule_file: "04-business-flow.md",
        required_sections: &["核心业务流程"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::FeatureDesign,
        order: 5,
        title: "功能模块设计",
        document_heading: "5. 功能模块设计",
        required_for_initialization: false,
        depends_on: &[
            WorkflowNodeId::BasicInfo,
            WorkflowNodeId::Goals,
            WorkflowNodeId::RolesPermissions,
            WorkflowNodeId::BusinessFlow,
        ],
        agent_rule_file: "05-feature-design.md",
        required_sections: &["功能模块清单", "模块详情"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::PageInteraction,
        order: 6,
        title: "页面与交互设计",
        document_heading: "6. 页面与交互设计",
        required_for_initialization: false,
        depends_on: &[
            WorkflowNodeId::FeatureDesign,
            WorkflowNodeId::RolesPermissions,
        ],
        agent_rule_file: "06-page-interaction.md",
        required_sections: &["页面清单"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::DataStructure,
        order: 7,
        title: "数据结构设计",
        document_heading: "7. 数据结构设计",
        required_for_initialization: false,
        depends_on: &[
            WorkflowNodeId::FeatureDesign,
            WorkflowNodeId::PageInteraction,
        ],
        agent_rule_file: "07-data-structure.md",
        required_sections: &["实体清单"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::ApiDesign,
        order: 8,
        title: "接口设计",
        document_heading: "8. 接口设计",
        required_for_initialization: false,
        depends_on: &[WorkflowNodeId::FeatureDesign, WorkflowNodeId::DataStructure],
        agent_rule_file: "08-api-design.md",
        required_sections: &["接口清单"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::ArchitectureDeployment,
        order: 9,
        title: "技术架构与部署",
        document_heading: "9. 技术架构与部署",
        required_for_initialization: false,
        depends_on: &[
            WorkflowNodeId::BasicInfo,
            WorkflowNodeId::Goals,
            WorkflowNodeId::FeatureDesign,
        ],
        agent_rule_file: "09-architecture-deployment.md",
        required_sections: &["技术栈", "部署方案"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::DevelopmentTasks,
        order: 10,
        title: "开发任务拆分",
        document_heading: "10. 开发任务拆分",
        required_for_initialization: false,
        depends_on: &[
            WorkflowNodeId::FeatureDesign,
            WorkflowNodeId::ApiDesign,
            WorkflowNodeId::DataStructure,
            WorkflowNodeId::ArchitectureDeployment,
        ],
        agent_rule_file: "10-development-tasks.md",
        required_sections: &["任务清单"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::RisksOpenQuestions,
        order: 11,
        title: "待确认事项与风险",
        document_heading: "11. 待确认事项与风险",
        required_for_initialization: false,
        depends_on: &[
            WorkflowNodeId::BasicInfo,
            WorkflowNodeId::Goals,
            WorkflowNodeId::FeatureDesign,
            WorkflowNodeId::DevelopmentTasks,
        ],
        agent_rule_file: "11-risks-open-questions.md",
        required_sections: &["风险清单", "待确认事项"],
    },
    WorkflowNodeDefinition {
        id: WorkflowNodeId::FinalExport,
        order: 12,
        title: "最终文档生成",
        document_heading: "12. 最终文档生成",
        required_for_initialization: false,
        depends_on: &[
            WorkflowNodeId::BasicInfo,
            WorkflowNodeId::Goals,
            WorkflowNodeId::RolesPermissions,
            WorkflowNodeId::BusinessFlow,
            WorkflowNodeId::FeatureDesign,
            WorkflowNodeId::PageInteraction,
            WorkflowNodeId::DataStructure,
            WorkflowNodeId::ApiDesign,
            WorkflowNodeId::ArchitectureDeployment,
            WorkflowNodeId::DevelopmentTasks,
            WorkflowNodeId::RisksOpenQuestions,
        ],
        agent_rule_file: "12-final-export.md",
        required_sections: &["导出检查清单"],
    },
];

pub fn workflow_definition(id: WorkflowNodeId) -> &'static WorkflowNodeDefinition {
    WORKFLOW
        .iter()
        .find(|definition| definition.id == id)
        .expect("workflow is complete")
}

/// Product rule assets are embedded in the Rust binary. `include_str!` makes
/// an accidentally missing asset a build failure for both development and
/// packaged desktop builds instead of a silent runtime fallback.
pub fn agent_rule(id: WorkflowNodeId) -> &'static str {
    match id {
        WorkflowNodeId::BasicInfo => include_str!("../../../assets/agents/01-basic-info.md"),
        WorkflowNodeId::Goals => include_str!("../../../assets/agents/02-goals.md"),
        WorkflowNodeId::RolesPermissions => {
            include_str!("../../../assets/agents/03-roles-permissions.md")
        }
        WorkflowNodeId::BusinessFlow => include_str!("../../../assets/agents/04-business-flow.md"),
        WorkflowNodeId::FeatureDesign => {
            include_str!("../../../assets/agents/05-feature-design.md")
        }
        WorkflowNodeId::PageInteraction => {
            include_str!("../../../assets/agents/06-page-interaction.md")
        }
        WorkflowNodeId::DataStructure => {
            include_str!("../../../assets/agents/07-data-structure.md")
        }
        WorkflowNodeId::ApiDesign => include_str!("../../../assets/agents/08-api-design.md"),
        WorkflowNodeId::ArchitectureDeployment => {
            include_str!("../../../assets/agents/09-architecture-deployment.md")
        }
        WorkflowNodeId::DevelopmentTasks => {
            include_str!("../../../assets/agents/10-development-tasks.md")
        }
        WorkflowNodeId::RisksOpenQuestions => {
            include_str!("../../../assets/agents/11-risks-open-questions.md")
        }
        WorkflowNodeId::FinalExport => include_str!("../../../assets/agents/12-final-export.md"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    NotStarted,
    Draft,
    Generated,
    Confirmed,
    NeedsConfirmation,
}

fn default_project_schema_version() -> u32 {
    PROJECT_SCHEMA_VERSION
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    #[serde(default = "default_project_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub customer_name: String,
    pub author_name: String,
    pub version: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: WorkflowNodeId,
    pub status: NodeStatus,
    pub markdown: String,
    pub revision: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoricalSourceKind {
    ProvidedUrl,
    WebSearch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalSource {
    pub id: String,
    pub kind: HistoricalSourceKind,
    pub url: String,
    pub title: String,
    pub domain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub retrieved_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenUsageSource {
    Exact,
    Estimated,
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCallCategory {
    Answer,
    ToolPlanning,
    DocumentUpdate,
    /// Fallback for legacy or unrecognized categories (e.g. the removed
    /// `fact_judge`), so historical chat files stay readable. The category is
    /// informational only and never drives behavior; on the next write the
    /// value is normalized to `other`.
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCallStatus {
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCallUsage {
    pub id: String,
    pub category: ModelCallCategory,
    pub provider_id: String,
    pub model: String,
    pub source: TokenUsageSource,
    pub status: ModelCallStatus,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTokenUsage {
    pub turn_id: String,
    pub source: TokenUsageSource,
    pub call_count: u32,
    pub calls: Vec<ModelCallUsage>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<HistoricalSource>>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnTokenUsage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageAttachmentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_execution: Option<ModelExecution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub node_id: WorkflowNodeId,
    pub name: String,
    pub message_count: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ChatModelSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectFileKind {
    Markdown,
    Text,
    Json,
    Csv,
    Pdf,
    Word,
    Excel,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileExtractionStatus {
    Available,
    Failed,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub id: String,
    pub original_name: String,
    pub stored_name: String,
    pub extension: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub uploaded_at: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ProjectFileKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction_status: Option<FileExtractionStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

pub fn default_node(id: WorkflowNodeId, now: impl Into<String>) -> WorkflowNode {
    let definition = workflow_definition(id);
    let mut lines = vec![format!("# {}", definition.title), String::new()];
    for section in definition.required_sections {
        lines.push(format!("## {section}"));
        lines.push(String::new());
    }
    WorkflowNode {
        id,
        status: if definition.required_for_initialization {
            NodeStatus::Draft
        } else {
            NodeStatus::NotStarted
        },
        markdown: lines.join("\n"),
        revision: 0,
        updated_at: now.into(),
    }
}

pub fn default_nodes(now: impl Into<String>) -> Vec<WorkflowNode> {
    let now = now.into();
    WorkflowNodeId::ALL
        .into_iter()
        .map(|id| default_node(id, now.clone()))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AgentDelivery {
    Unchanged,
    Rewrite { markdown: String },
    Patch { sections: Vec<AgentDeliverySection> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDeliverySection {
    pub title: String,
    pub content: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DeliveryError {
    #[error("assistant response did not include a fenced ```delivery JSON block")]
    MissingBlock,
    #[error("assistant response included more than one fenced ```delivery block")]
    MultipleBlocks,
    #[error("assistant response included an unterminated fenced ```delivery block")]
    UnterminatedBlock,
    #[error("assistant response had non-whitespace content after the delivery block")]
    TrailingContent,
    #[error("delivery block JSON is invalid: {0}")]
    InvalidJson(String),
    #[error("delivery markdown is empty")]
    EmptyMarkdown,
    #[error("delivery markdown is missing required sections for {node:?}: {sections:?}")]
    MissingRequiredSections {
        node: WorkflowNodeId,
        sections: Vec<&'static str>,
    },
    #[error("delivery patch does not include any sections")]
    EmptyPatch,
    #[error("delivery patch targets an unsupported section for {node:?}: {section}")]
    UnsupportedPatchSection {
        node: WorkflowNodeId,
        section: String,
    },
    #[error("delivery patch targets the same section more than once: {section}")]
    DuplicatePatchSection { section: String },
    #[error("delivery patch content is empty for section: {section}")]
    EmptyPatchContent { section: String },
    #[error("delivery patch content cannot contain level-one or level-two headings: {section}")]
    PatchContentChangesStructure { section: String },
    #[error("current markdown is missing the target section: {section}")]
    MissingTargetSection { section: String },
}

#[derive(Debug, Clone)]
pub struct ParsedAgentResponse {
    pub visible_content: String,
    pub delivery: AgentDelivery,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryResolution {
    Unchanged,
    Markdown(String),
}

pub fn parse_agent_delivery(response: &str) -> Result<AgentDelivery, DeliveryError> {
    let block = extract_delivery_block(response)?;
    serde_json::from_str(block.body.trim())
        .map_err(|error| DeliveryError::InvalidJson(error.to_string()))
}

pub fn parse_agent_response(response: &str) -> Result<ParsedAgentResponse, DeliveryError> {
    let block = extract_delivery_block(response)?;
    let trailing = &response[block.block_end..];
    if !trailing.trim().is_empty() {
        return Err(DeliveryError::TrailingContent);
    }
    let delivery: AgentDelivery = serde_json::from_str(block.body.trim())
        .map_err(|error| DeliveryError::InvalidJson(error.to_string()))?;
    let visible_content = response[..block.visible_end].trim_end().to_string();
    Ok(ParsedAgentResponse {
        visible_content,
        delivery,
    })
}

pub fn resolve_agent_delivery(
    delivery: AgentDelivery,
    node: WorkflowNodeId,
    current_markdown: &str,
) -> Result<DeliveryResolution, DeliveryError> {
    match delivery {
        AgentDelivery::Unchanged => Ok(DeliveryResolution::Unchanged),
        AgentDelivery::Rewrite { markdown } => {
            validate_delivery_markdown(markdown, node).map(DeliveryResolution::Markdown)
        }
        AgentDelivery::Patch { sections } => apply_delivery_patch(current_markdown, node, &sections)
            .map(DeliveryResolution::Markdown),
    }
}

pub fn apply_agent_delivery(
    response: &str,
    node: WorkflowNodeId,
    current_markdown: &str,
) -> Result<String, DeliveryError> {
    let delivery = parse_agent_delivery(response)?;
    match delivery {
        AgentDelivery::Unchanged => Ok(current_markdown.to_string()),
        AgentDelivery::Rewrite { markdown } => validate_delivery_markdown(markdown, node),
        AgentDelivery::Patch { sections } => apply_delivery_patch(current_markdown, node, &sections),
    }
}

pub fn validate_delivery_markdown(
    markdown: String,
    node: WorkflowNodeId,
) -> Result<String, DeliveryError> {
    let markdown = markdown.trim();
    if markdown.is_empty() {
        return Err(DeliveryError::EmptyMarkdown);
    }
    let headings = markdown_h2_sections(markdown);
    let missing_sections = workflow_definition(node)
        .required_sections
        .iter()
        .copied()
        .filter(|section| !headings.iter().any(|heading| heading.title == *section))
        .collect::<Vec<_>>();
    if !missing_sections.is_empty() {
        return Err(DeliveryError::MissingRequiredSections {
            node,
            sections: missing_sections,
        });
    }
    Ok(markdown.to_string())
}

fn apply_delivery_patch(
    current_markdown: &str,
    node: WorkflowNodeId,
    sections: &[AgentDeliverySection],
) -> Result<String, DeliveryError> {
    if sections.is_empty() {
        return Err(DeliveryError::EmptyPatch);
    }
    let definition = workflow_definition(node);
    let mut seen = std::collections::HashSet::new();
    let mut replacements = Vec::with_capacity(sections.len());
    let current_sections = markdown_h2_sections(current_markdown);
    for section in sections {
        let title = section.title.trim();
        if !definition.required_sections.contains(&title) {
            return Err(DeliveryError::UnsupportedPatchSection {
                node,
                section: title.to_string(),
            });
        }
        if !seen.insert(title) {
            return Err(DeliveryError::DuplicatePatchSection {
                section: title.to_string(),
            });
        }
        let content = section.content.trim();
        if content.is_empty() {
            return Err(DeliveryError::EmptyPatchContent {
                section: title.to_string(),
            });
        }
        if contains_structural_heading(content) {
            return Err(DeliveryError::PatchContentChangesStructure {
                section: title.to_string(),
            });
        }
        let target = current_sections
            .iter()
            .find(|candidate| candidate.title == title)
            .ok_or_else(|| DeliveryError::MissingTargetSection {
                section: title.to_string(),
            })?;
        replacements.push((target.content_start, target.end, content.to_string()));
    }
    replacements.sort_by_key(|replacement| std::cmp::Reverse(replacement.0));
    let mut result = current_markdown.to_string();
    for (start, end, content) in replacements {
        result.replace_range(start..end, &format!("\n\n{content}\n\n"));
    }
    validate_delivery_markdown(result, node)
}

#[derive(Debug, Clone, Copy)]
struct MarkdownH2Section<'a> {
    title: &'a str,
    content_start: usize,
    end: usize,
}

fn markdown_h2_sections(markdown: &str) -> Vec<MarkdownH2Section<'_>> {
    let mut sections: Vec<MarkdownH2Section<'_>> = Vec::new();
    let mut offset = 0;
    let mut in_fence = false;
    for line in markdown.split_inclusive('\n') {
        let line_without_newline = line.strip_suffix('\n').unwrap_or(line);
        let line_without_newline = line_without_newline
            .strip_suffix('\r')
            .unwrap_or(line_without_newline);
        let trimmed = line_without_newline.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        } else if !in_fence && let Some(title) = trimmed.strip_prefix("## ") {
            let title = title.trim_end();
            if !title.is_empty() {
                if let Some(previous) = sections.last_mut() {
                    previous.end = offset;
                }
                sections.push(MarkdownH2Section {
                    title,
                    content_start: offset + line.len(),
                    end: markdown.len(),
                });
            }
        }
        offset += line.len();
    }
    sections
}

fn contains_structural_heading(markdown: &str) -> bool {
    let mut in_fence = false;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence && (trimmed.starts_with("# ") || trimmed.starts_with("## ")) {
            return true;
        }
    }
    false
}

struct DeliveryBlock<'a> {
    body: &'a str,
    visible_end: usize,
    block_end: usize,
}

fn extract_delivery_block(response: &str) -> Result<DeliveryBlock<'_>, DeliveryError> {
    let mut found: Option<DeliveryBlock<'_>> = None;
    let mut search_start = 0;
    while let Some(relative_start) = response[search_start..].find("```") {
        let fence_start = search_start + relative_start;
        let language_start = fence_start + 3;
        let line_end = response[language_start..]
            .find('\n')
            .map(|offset| language_start + offset)
            .unwrap_or(response.len());
        let language = response[language_start..line_end].trim();
        if language.eq_ignore_ascii_case("delivery") {
            let body_start = if line_end == response.len() {
                response.len()
            } else {
                line_end + 1
            };
            let Some(body_end) = find_closing_fence(response, body_start) else {
                return Err(DeliveryError::UnterminatedBlock);
            };
            let closing_fence_end = (body_end + 3).min(response.len());
            let block_end = response[closing_fence_end..]
                .find('\n')
                .map(|offset| closing_fence_end + offset + 1)
                .unwrap_or(response.len());
            let block = DeliveryBlock {
                body: response[body_start..body_end].trim(),
                visible_end: fence_start,
                block_end,
            };
            if found.replace(block).is_some() {
                return Err(DeliveryError::MultipleBlocks);
            }
            search_start = block_end;
        } else {
            if line_end == response.len() {
                break;
            }
            search_start = line_end + 1;
        }
    }
    found.ok_or(DeliveryError::MissingBlock)
}

fn find_closing_fence(response: &str, body_start: usize) -> Option<usize> {
    let mut offset = body_start;
    for line in response[body_start..].split_inclusive('\n') {
        let line_without_newline = line.strip_suffix('\n').unwrap_or(line);
        let line_without_newline = line_without_newline
            .strip_suffix('\r')
            .unwrap_or(line_without_newline);
        if line_without_newline.trim() == "```" {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_session_without_model_selection_deserializes_empty() {
        let json = r#"{"id":"s","nodeId":"goals","name":"n","messageCount":0,"createdAt":"t","updatedAt":"t"}"#;
        let session: ChatSession = serde_json::from_str(json).unwrap();
        assert_eq!(session.model_selection, None);
    }

    #[test]
    fn legacy_message_without_attachments_deserializes_empty() {
        let json = r#"{"id":"m","role":"user","content":"c","createdAt":"t"}"#;
        let message: ChatMessage = serde_json::from_str(json).unwrap();
        assert!(message.attachments.is_empty());
        assert_eq!(message.model_execution, None);
    }

    #[test]
    fn workflow_has_twelve_unique_nodes_in_order() {
        assert_eq!(WORKFLOW.len(), 12);
        for (index, node) in WORKFLOW.iter().enumerate() {
            assert_eq!(node.order as usize, index + 1);
            assert_eq!(WorkflowNodeId::try_from(node.id.as_str()).unwrap(), node.id);
        }
    }

    #[test]
    fn default_nodes_seed_required_sections_without_optional_placeholders() {
        let node = default_node(WorkflowNodeId::Goals, "2026-07-15T00:00:00.000Z");
        assert_eq!(node.status, NodeStatus::Draft);
        assert!(node.markdown.contains("## 需求背景"));
        assert!(node.markdown.contains("## 建设目标"));
        assert!(node.markdown.contains("## 范围边界"));
    }

    #[test]
    fn embeds_a_non_empty_rule_for_every_workflow_node() {
        for definition in WORKFLOW {
            let rule = agent_rule(definition.id);
            assert!(rule.contains("Agent"));
            assert!(rule.len() > 100);
        }
    }

    #[test]
    fn project_manifest_defaults_a_missing_schema_version_to_one() {
        let manifest: ProjectManifest = serde_json::from_str(
            r#"{"id":"legacy-project","name":"Legacy","customerName":"","authorName":"","version":"V1.0","createdAt":"2026-06-14T00:00:00Z","updatedAt":"2026-06-14T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(manifest.schema_version, PROJECT_SCHEMA_VERSION);
    }

    #[test]
    fn parses_historical_message_metadata_without_enabling_new_web_access() {
        // Inlined so sion-core no longer reads fixtures/legacy-projects. The
        // payload is a historical chat transcript whose assistant turn carries
        // a web-search source and token usage; parsing it must not enable any
        // new web access in the desktop runtime.
        let messages: Vec<ChatMessage> = serde_json::from_str(
            r#"[
  {
    "id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "role": "user",
    "content": "请写入项目基本信息。",
    "createdAt": "2026-02-03T04:05:06.000Z"
  },
  {
    "id": "ffffffff-1111-4222-8333-444444444444",
    "role": "assistant",
    "content": "已整理项目基本信息。",
    "reasoningContent": "先核对用户提供信息。",
    "sources": [
      {
        "id": "source-legacy-1",
        "kind": "web_search",
        "url": "https://example.invalid/reference",
        "title": "历史来源，仅作保留",
        "domain": "example.invalid",
        "snippet": "此来源不应触发新应用联网。",
        "retrievedAt": "2026-02-03T04:05:30.000Z"
      }
    ],
    "createdAt": "2026-02-03T04:06:06.000Z",
    "turnId": "turn-fixture-001",
    "reasoningDurationMs": 1200,
    "usage": {
      "inputTokens": 120,
      "outputTokens": 40,
      "totalTokens": 160,
      "turnId": "turn-fixture-001",
      "source": "exact",
      "callCount": 1,
      "calls": [
        {
          "id": "call-fixture-001",
          "category": "answer",
          "providerId": "provider-fixture-001",
          "model": "fixture-model",
          "source": "exact",
          "status": "completed",
          "inputTokens": 120,
          "outputTokens": 40,
          "totalTokens": 160
        }
      ]
    }
  }
]"#,
        )
        .unwrap();
        let assistant = &messages[1];
        assert_eq!(assistant.role, ChatRole::Assistant);
        assert_eq!(
            assistant.sources.as_ref().unwrap()[0].kind,
            HistoricalSourceKind::WebSearch
        );
        assert_eq!(assistant.usage.as_ref().unwrap().total_tokens, 160);
        assert_eq!(assistant.reasoning_duration_ms, Some(1200));
    }

    #[test]
    fn tolerates_legacy_model_call_categories_when_parsing_messages() {
        // Chat files written before the `fact_judge` category was removed (commit
        // 7c2fd02) still carry that value on disk. Such files must remain
        // readable instead of failing the whole session.
        let messages: Vec<ChatMessage> = serde_json::from_str(
            r##"[{
              "id": "legacy-call-1",
              "role": "assistant",
              "content": "历史回复",
              "createdAt": "2026-07-03T04:02:07.184Z",
              "usage": {
                "inputTokens": 1185,
                "outputTokens": 515,
                "totalTokens": 1700,
                "turnId": "turn-legacy-1",
                "source": "exact",
                "callCount": 1,
                "calls": [
                  {
                    "id": "call-legacy-1",
                    "category": "fact_judge",
                    "providerId": "provider-legacy",
                    "model": "legacy-model",
                    "source": "exact",
                    "status": "completed",
                    "inputTokens": 1185,
                    "outputTokens": 515,
                    "totalTokens": 1700
                  }
                ]
              }
            }]"##,
        )
        .unwrap();
        let assistant = &messages[0];
        let call = &assistant.usage.as_ref().unwrap().calls[0];
        assert_eq!(call.category, ModelCallCategory::Other);
        assert_eq!(call.total_tokens, 1700);
    }

    #[test]
    fn parses_a_delivery_rewrite_block_from_an_assistant_reply() {
        let markdown = apply_agent_delivery(
            r##"可以，下面是交付稿。

```delivery
{
  "mode": "rewrite",
  "markdown": "# 项目基本信息\n\n## 基础信息表\n\n| 字段 | 内容 |\n| --- | --- |\n\n## 项目边界\n\n- 仅本地桌面应用。"
}
```
"##,
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n\n## 项目边界\n",
        )
        .unwrap();
        assert!(markdown.contains("## 基础信息表"));
        assert!(markdown.contains("## 项目边界"));
    }

    #[test]
    fn rejects_assistant_replies_without_a_delivery_block() {
        let error = apply_agent_delivery(
            "普通回复",
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n\n## 项目边界\n",
        )
        .unwrap_err();
        assert_eq!(error, DeliveryError::MissingBlock);
    }

    #[test]
    fn rejects_multiple_delivery_blocks() {
        let error = parse_agent_delivery(
            r##"```delivery
{"mode":"rewrite","markdown":"# A"}
```
```delivery
{"mode":"rewrite","markdown":"# B"}
```"##,
        )
        .unwrap_err();
        assert_eq!(error, DeliveryError::MultipleBlocks);
    }

    #[test]
    fn rejects_delivery_missing_required_node_sections() {
        let error = apply_agent_delivery(
            r##"```delivery
{"mode":"rewrite","markdown":"# 项目基本信息\n\n## 基础信息表\n\n- A"}
```"##,
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n\n## 项目边界\n",
        )
        .unwrap_err();
        assert_eq!(
            error,
            DeliveryError::MissingRequiredSections {
                node: WorkflowNodeId::BasicInfo,
                sections: vec!["项目边界"],
            }
        );
    }

    #[test]
    fn allows_markdown_code_fences_inside_delivery_json_strings() {
        let markdown = apply_agent_delivery(
            r##"```delivery
{"mode":"rewrite","markdown":"# 接口设计\n\n## 接口清单\n\n```ts\nconst route = '/v1/projects';\n```"}
```
"##,
            WorkflowNodeId::ApiDesign,
            "# 接口设计\n\n## 接口清单\n",
        )
        .unwrap();
        assert!(markdown.contains("```ts"));
    }

    #[test]
    fn applies_a_patch_to_only_the_named_required_sections() {
        let current = "# 项目基本信息\n\n## 基础信息表\n\n| 字段 | 内容 |\n| --- | --- |\n\n## 项目边界\n\n- 原始边界\n";
        let markdown = apply_agent_delivery(
            r##"```delivery
{"mode":"patch","sections":[{"title":"项目边界","content":"- 仅支持 Windows 和 macOS。\n- 不包含浏览器搜索。"}]}
```"##,
            WorkflowNodeId::BasicInfo,
            current,
        )
        .unwrap();
        assert!(markdown.contains("| 字段 | 内容 |"));
        assert!(markdown.contains("- 仅支持 Windows 和 macOS。"));
        assert!(!markdown.contains("- 原始边界"));
    }

    #[test]
    fn rejects_a_patch_that_rewrites_document_structure() {
        let error = apply_agent_delivery(
            r###"```delivery
{"mode":"patch","sections":[{"title":"项目边界","content":"## 隐藏章节\n\n- 内容"}]}
```"###,
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n\n## 项目边界\n",
        )
        .unwrap_err();
        assert_eq!(
            error,
            DeliveryError::PatchContentChangesStructure {
                section: "项目边界".to_string(),
            }
        );
    }

    #[test]
    fn rejects_duplicate_or_unknown_patch_sections() {
        let current = "# 项目基本信息\n\n## 基础信息表\n\n## 项目边界\n";
        let duplicate = apply_agent_delivery(
            r##"```delivery
{"mode":"patch","sections":[{"title":"项目边界","content":"- A"},{"title":"项目边界","content":"- B"}]}
```"##,
            WorkflowNodeId::BasicInfo,
            current,
        )
        .unwrap_err();
        assert_eq!(
            duplicate,
            DeliveryError::DuplicatePatchSection {
                section: "项目边界".to_string(),
            }
        );
        let unknown = apply_agent_delivery(
            r##"```delivery
{"mode":"patch","sections":[{"title":"任意章节","content":"- A"}]}
```"##,
            WorkflowNodeId::BasicInfo,
            current,
        )
        .unwrap_err();
        assert_eq!(
            unknown,
            DeliveryError::UnsupportedPatchSection {
                node: WorkflowNodeId::BasicInfo,
                section: "任意章节".to_string(),
            }
        );
    }

    #[test]
    fn allows_code_fence_headings_inside_patch_content() {
        let markdown = apply_agent_delivery(
            r###"```delivery
{"mode":"patch","sections":[{"title":"接口清单","content":"```md\n## 这不是文档章节\n```\n\n- GET /projects"}]}
```"###,
            WorkflowNodeId::ApiDesign,
            "# 接口设计\n\n## 接口清单\n",
        )
        .unwrap();
        assert!(markdown.contains("## 这不是文档章节"));
    }

    #[test]
    fn parses_unchanged_without_mutating_markdown() {
        let parsed = parse_agent_response(
            "当前信息已经覆盖该要求。\n\n```delivery\n{\"mode\":\"unchanged\"}\n```",
        )
        .unwrap();
        assert_eq!(parsed.visible_content, "当前信息已经覆盖该要求。");
        assert_eq!(parsed.delivery, AgentDelivery::Unchanged);
        assert_eq!(
            resolve_agent_delivery(
                parsed.delivery,
                WorkflowNodeId::Goals,
                "# 目标\n\n## 建设目标\n已有"
            ),
            Ok(DeliveryResolution::Unchanged),
        );
    }
}
