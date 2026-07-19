//! Deterministic engineering attachment builders: PROJECT_DESIGN, SPEC, TASKS,
//! and AGENTS Markdown generated from the project manifest and workflow nodes.
//!
//! These artifacts never call a model. They are derived from the first eleven
//! content nodes in fixed WORKFLOW order (the final-export node is never a
//! source), so the same inputs always produce the same bytes.

use sion_core::{
    ExportArtifactKind, ProjectManifest, WORKFLOW, WorkflowNode, WorkflowNodeId,
    workflow_definition,
};

/// Builds the four engineering artifacts in fixed order: PROJECT_DESIGN, SPEC,
/// TASKS, AGENTS.
pub fn build_engineering_artifacts(
    manifest: &ProjectManifest,
    nodes: &[WorkflowNode],
) -> Result<Vec<(ExportArtifactKind, String)>, String> {
    let ordered = ordered_content_nodes(nodes)?;
    Ok(vec![
        (
            ExportArtifactKind::ProjectDesign,
            build_project_design(manifest, &ordered),
        ),
        (ExportArtifactKind::Spec, build_spec(manifest, &ordered)),
        (ExportArtifactKind::Tasks, build_tasks(manifest, &ordered)),
        (ExportArtifactKind::Agents, build_agents(manifest)),
    ])
}

fn ordered_content_nodes(nodes: &[WorkflowNode]) -> Result<Vec<&WorkflowNode>, String> {
    let mut ordered = Vec::new();
    for definition in WORKFLOW
        .iter()
        .filter(|definition| definition.id != WorkflowNodeId::FinalExport)
    {
        let node = nodes
            .iter()
            .find(|node| node.id == definition.id)
            .ok_or_else(|| format!("missing workflow node: {:?}", definition.id))?;
        ordered.push(node);
    }
    Ok(ordered)
}

/// Drops a single leading H1 line so a node chapter nests cleanly under its
/// document-heading H2 instead of producing a nested H1.
fn body_without_h1(markdown: &str) -> &str {
    let mut lines = markdown.lines();
    if let Some(first) = lines.next()
        && first.trim_start().starts_with("# ")
    {
        return markdown[first.len()..].trim_start_matches('\n');
    }
    markdown
}

fn project_metadata(manifest: &ProjectManifest) -> String {
    format!(
        "- 项目ID: {}\n- 项目名称: {}\n- 客户: {}\n- 作者: {}\n- 版本: {}",
        manifest.id, manifest.name, manifest.customer_name, manifest.author_name, manifest.version
    )
}

fn build_project_design(manifest: &ProjectManifest, nodes: &[&WorkflowNode]) -> String {
    let mut out = format!("# {} 项目开发设计文档\n\n", manifest.name);
    out.push_str("## 项目元数据\n\n");
    out.push_str(&project_metadata(manifest));
    out.push_str("\n\n");
    for node in nodes {
        let definition = workflow_definition(node.id);
        out.push_str(&format!(
            "## {}\n\n{}\n\n",
            definition.document_heading,
            body_without_h1(&node.markdown)
        ));
    }
    out
}

fn build_spec(manifest: &ProjectManifest, nodes: &[&WorkflowNode]) -> String {
    let mut out = format!("# {} SPEC\n\n", manifest.name);
    out.push_str("## 项目元数据\n\n");
    out.push_str(&project_metadata(manifest));
    out.push_str("\n\n");
    let spec_node_ids = [
        WorkflowNodeId::Goals,
        WorkflowNodeId::RolesPermissions,
        WorkflowNodeId::BusinessFlow,
        WorkflowNodeId::FeatureDesign,
        WorkflowNodeId::PageInteraction,
        WorkflowNodeId::DataStructure,
        WorkflowNodeId::ApiDesign,
        WorkflowNodeId::ArchitectureDeployment,
        WorkflowNodeId::RisksOpenQuestions,
    ];
    for target_id in spec_node_ids {
        if let Some(node) = nodes.iter().find(|node| node.id == target_id) {
            let definition = workflow_definition(node.id);
            out.push_str(&format!(
                "## {}\n\n{}\n\n",
                definition.document_heading,
                body_without_h1(&node.markdown)
            ));
        }
    }
    out
}

fn build_tasks(manifest: &ProjectManifest, nodes: &[&WorkflowNode]) -> String {
    let mut out = format!("# {} 开发任务\n\n", manifest.name);
    out.push_str("## 项目元数据\n\n");
    out.push_str(&project_metadata(manifest));
    out.push_str("\n\n");
    if let Some(node) = nodes
        .iter()
        .find(|node| node.id == WorkflowNodeId::DevelopmentTasks)
    {
        out.push_str("## 开发任务拆分\n\n");
        out.push_str(body_without_h1(&node.markdown));
        out.push('\n');
    }
    out
}

fn build_agents(manifest: &ProjectManifest) -> String {
    let mut out = format!("# {} AGENTS\n\n", manifest.name);
    out.push_str("## 本地项目上下文\n\n");
    out.push_str(&project_metadata(manifest));
    out.push_str("\n\n## 固定节点顺序\n\n");
    for definition in WORKFLOW {
        out.push_str(&format!(
            "- {}：{}\n",
            definition.document_heading, definition.title
        ));
    }
    out.push_str("\n## 交付与校验规则\n\n");
    out.push_str("- Agent 修改必须以一个完整、闭合的 ```delivery JSON 块返回，不得返回过程描述或部分流式内容。\n");
    out.push_str("- 对现有蓝图或正文的修改必须经过结构校验和差异预览，确认后才可写入。\n");
    out.push_str("- 桌面运行时不包含浏览器、搜索、自动化或任何新的 Web 出口。\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_core::default_nodes;

    fn manifest() -> ProjectManifest {
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

    fn nodes() -> Vec<WorkflowNode> {
        let now = "2026-07-19T00:00:00Z";
        let mut nodes = default_nodes(now);
        if let Some(basic) = nodes
            .iter_mut()
            .find(|node| node.id == WorkflowNodeId::BasicInfo)
        {
            basic.markdown = "# 项目基本信息\n\n## 基础信息表\n\n| 字段 | 值 |\n| --- | --- |\n| 项目 | 示例项目 |\n\n## 项目边界\n\n- 仅本地桌面应用。\n".into();
        }
        if let Some(tasks) = nodes
            .iter_mut()
            .find(|node| node.id == WorkflowNodeId::DevelopmentTasks)
        {
            tasks.markdown = "# 开发任务拆分\n\n## 任务清单\n\n- 开发任务一：搭建导出中心。\n- 开发任务二：实现 DOCX 生成。\n".into();
        }
        nodes
    }

    #[test]
    fn engineering_artifacts_have_fixed_names_order_and_sources() {
        let artifacts = build_engineering_artifacts(&manifest(), &nodes()).unwrap();
        assert_eq!(
            artifacts.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
            vec![
                ExportArtifactKind::ProjectDesign,
                ExportArtifactKind::Spec,
                ExportArtifactKind::Tasks,
                ExportArtifactKind::Agents,
            ]
        );
        assert!(artifacts[0].1.contains("# 示例项目 项目开发设计文档"));
        assert!(artifacts[0].1.contains("## 1. 项目基本信息"));
        assert!(!artifacts[0].1.contains("12. 最终文档生成"));
        assert!(artifacts[2].1.contains("开发任务"));
    }
}
