//! Deterministic export prompt composition from project metadata, workflow
//! nodes, approved blueprint, draft, and a review instruction.
//!
//! System prompts are embedded at compile time via `include_str!`, so a missing
//! asset is a build failure rather than a silent runtime fallback. Builders only
//! ever place project-local content (node Markdown, blueprint, draft, digest,
//! instruction) into the prompt; API keys never appear here.

use crate::{NodeStatus, ProjectManifest, WorkflowNode, WorkflowNodeId};

use super::ExportArtifactKind;

/// The four embedded export system prompts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportPromptKind {
    Blueprint,
    Draft,
    ReviewBlueprint,
    ReviewDraft,
}

pub fn export_system_prompt(kind: ExportPromptKind) -> &'static str {
    match kind {
        ExportPromptKind::Blueprint => include_str!("../../../../assets/export/blueprint.md"),
        ExportPromptKind::Draft => include_str!("../../../../assets/export/draft.md"),
        ExportPromptKind::ReviewBlueprint => {
            include_str!("../../../../assets/export/review-blueprint.md")
        }
        ExportPromptKind::ReviewDraft => {
            include_str!("../../../../assets/export/review-draft.md")
        }
    }
}

fn status_str(status: &NodeStatus) -> &'static str {
    match status {
        NodeStatus::NotStarted => "not_started",
        NodeStatus::Draft => "draft",
        NodeStatus::Generated => "generated",
        NodeStatus::Confirmed => "confirmed",
        NodeStatus::NeedsConfirmation => "needs_confirmation",
    }
}

fn append_node_context(out: &mut String, nodes: &[WorkflowNode]) {
    out.push_str("\n\n## 来源节点\n\n");
    for node in nodes
        .iter()
        .filter(|node| node.id != WorkflowNodeId::FinalExport)
    {
        out.push_str(&format!(
            "nodeId: {}\nstatus: {}\nrevision: {}\n{}\n\n",
            node.id.as_str(),
            status_str(&node.status),
            node.revision,
            node.markdown,
        ));
    }
}

/// Composes the blueprint generation prompt: the blueprint system prompt, the
/// project manifest, and every content workflow node (the final-export node is
/// never a blueprint source). Incomplete node status is advisory context, not a
/// hard filter.
pub fn build_blueprint_prompt(manifest: &ProjectManifest, nodes: &[WorkflowNode]) -> String {
    let mut out = String::from(export_system_prompt(ExportPromptKind::Blueprint));
    out.push_str("\n\n## 项目\n\n");
    out.push_str(&format!(
        "- projectId: {}\n- projectName: {}\n",
        manifest.id, manifest.name
    ));
    append_node_context(&mut out, nodes);
    out
}

/// Composes the formal draft generation prompt: the draft system prompt, the
/// project manifest, the approved blueprint, and the referenced content nodes.
pub fn build_draft_prompt(
    manifest: &ProjectManifest,
    blueprint: &super::ExportBlueprint,
    nodes: &[WorkflowNode],
) -> String {
    let mut out = String::from(export_system_prompt(ExportPromptKind::Draft));
    out.push_str("\n\n## 项目\n\n");
    out.push_str(&format!(
        "- projectId: {}\n- projectName: {}\n",
        manifest.id, manifest.name
    ));
    out.push_str("\n\n## 已批准导出蓝图\n\n");
    out.push_str(&super::serialize_blueprint(blueprint));
    append_node_context(&mut out, nodes);
    out
}

/// Composes a review prompt for the given target artifact. Only blueprint and
/// formal draft can be reviewed; other kinds return an error. The prompt binds
/// the current artifact content, its digest, the user's instruction, and the
/// allowed source nodes.
pub fn build_review_prompt(
    kind: ExportArtifactKind,
    current_markdown: &str,
    digest: &str,
    instruction: &str,
    nodes: &[WorkflowNode],
) -> Result<String, String> {
    let system = match kind {
        ExportArtifactKind::Blueprint => export_system_prompt(ExportPromptKind::ReviewBlueprint),
        ExportArtifactKind::FormalDraft => export_system_prompt(ExportPromptKind::ReviewDraft),
        _ => return Err(format!("{kind:?} cannot be reviewed")),
    };
    let mut out = String::from(system);
    out.push_str("\n\n## 当前文档内容\n\n");
    out.push_str(current_markdown);
    out.push_str("\n\n## 当前文档摘要\n\n");
    out.push_str(digest);
    out.push_str("\n\n## 评审意见\n\n");
    out.push_str(instruction);
    append_node_context(&mut out, nodes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NodeStatus, ProjectManifest, WorkflowNode, WorkflowNodeId};

    fn fixture_manifest() -> ProjectManifest {
        ProjectManifest {
            schema_version: 1,
            id: "project-1".into(),
            name: "示例项目".into(),
            customer_name: "客户".into(),
            author_name: "Sion".into(),
            version: "V1.0".into(),
            created_at: "2026-07-19T00:00:00Z".into(),
            updated_at: "2026-07-19T00:00:00Z".into(),
        }
    }

    fn fixture_nodes() -> Vec<WorkflowNode> {
        vec![
            WorkflowNode {
                id: WorkflowNodeId::BasicInfo,
                status: NodeStatus::Draft,
                markdown: "# 基本信息\n\n## 基础信息表\n\n正文".into(),
                revision: 1,
                updated_at: "2026-07-19T00:00:00Z".into(),
            },
            WorkflowNode {
                id: WorkflowNodeId::FinalExport,
                status: NodeStatus::NotStarted,
                markdown: "# 最终文档\n\n## 导出检查清单\n\n".into(),
                revision: 0,
                updated_at: "2026-07-19T00:00:00Z".into(),
            },
        ]
    }

    #[test]
    fn blueprint_prompt_excludes_final_export_and_labels_incomplete_nodes() {
        let prompt = build_blueprint_prompt(&fixture_manifest(), &fixture_nodes());
        assert!(prompt.contains("nodeId: basic-info"));
        assert!(prompt.contains("status: draft"));
        assert!(!prompt.contains("nodeId: final-export"));
        assert!(prompt.contains("delivery"));
    }

    #[test]
    fn review_prompt_binds_instruction_and_digest() {
        let prompt = build_review_prompt(
            ExportArtifactKind::FormalDraft,
            "# PRD\n\n## 目标\n\n正文",
            "digest-1",
            "把目标改成可量化指标",
            &fixture_nodes(),
        )
        .unwrap();
        assert!(prompt.contains("digest-1"));
        assert!(prompt.contains("把目标改成可量化指标"));
        assert!(prompt.contains("draft_patch"));
    }
}
