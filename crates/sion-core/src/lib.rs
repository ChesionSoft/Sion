//! Pure domain types and default workflow content for Sion Desktop.
//!
//! This crate deliberately has no dependency on Tauri, HTTP, or the filesystem.

use serde::{Deserialize, Serialize};
use thiserror::Error;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    #[serde(rename = "schema_version")]
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_historical_message_metadata_without_enabling_new_web_access() {
        let messages: Vec<ChatMessage> = serde_json::from_str(include_str!(
            "../../../fixtures/legacy-projects/minimal/projects/6a6b57e7-cbb6-4c0a-b630-000000000001/chat/basic-info/11111111-2222-4333-8444-555555555555.json"
        ))
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
}
