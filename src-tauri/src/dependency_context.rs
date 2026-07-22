//! Load, filter, label, and format the read-only dependency-node delivery
//! drafts that an Agent prompt receives for its direct `depends_on` nodes.
//!
//! This module intentionally contains no prompt-protocol logic: it only reads
//! the latest saved node revisions authorized by `sion_core::readable_dependency_ids`
//! and renders them as read-only context. Missing or corrupt authorized
//! dependencies abort preparation with a safe error rather than running blind.

use sion_core::{NodeStatus, WorkflowNodeId, readable_dependency_ids, workflow_definition};
use sion_storage::ProjectStore;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DependencyNodeContext {
    pub(crate) id: WorkflowNodeId,
    pub(crate) title: &'static str,
    pub(crate) status: NodeStatus,
    pub(crate) revision: u64,
    pub(crate) markdown: String,
}

fn has_meaningful_body(markdown: &str) -> bool {
    markdown.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && !line.starts_with('#')
    })
}

fn status_name(status: &NodeStatus) -> &'static str {
    match status {
        NodeStatus::NotStarted => "not_started",
        NodeStatus::Draft => "draft",
        NodeStatus::Generated => "generated",
        NodeStatus::Confirmed => "confirmed",
        NodeStatus::NeedsConfirmation => "needs_confirmation",
    }
}

pub(crate) fn load(
    store: &ProjectStore,
    current: WorkflowNodeId,
) -> Result<Vec<DependencyNodeContext>, String> {
    readable_dependency_ids(current)
        .into_iter()
        .map(|id| {
            let definition = workflow_definition(id);
            store
                .node(id)
                .map_err(|_| format!("依赖节点“{}”交付稿读取失败", definition.title))
                .map(|node| DependencyNodeContext {
                    id,
                    title: definition.title,
                    status: node.status,
                    revision: node.revision,
                    markdown: node.markdown,
                })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|nodes| {
            nodes
                .into_iter()
                .filter(|node| has_meaningful_body(&node.markdown))
                .collect()
        })
}

pub(crate) fn format(nodes: &[DependencyNodeContext]) -> String {
    nodes
        .iter()
        .map(|node| {
            format!(
                "<dependency-node id=\"{}\" title=\"{}\" status=\"{}\" revision=\"{}\" read-only=\"true\">\n{}\n</dependency-node>",
                node.id.as_str(),
                node.title,
                status_name(&node.status),
                node.revision,
                node.markdown.trim(),
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sion_storage::{CreateProjectInput, SaveNodeResult};
    use std::path::PathBuf;

    fn fixture() -> (PathBuf, ProjectStore) {
        let root =
            std::env::temp_dir().join(format!("sion-dependency-context-{}", uuid::Uuid::new_v4()));
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
        let store = ProjectStore::at(projects.join("project-1"));
        (root, store)
    }

    fn save_body(store: &ProjectStore, id: WorkflowNodeId, markdown: &str, status: NodeStatus) {
        assert!(matches!(
            store
                .save_node_if_revision(id, 0, markdown.into(), status, "later".into())
                .unwrap(),
            SaveNodeResult::Saved(_)
        ));
    }

    #[test]
    fn loads_only_direct_dependencies_in_workflow_order() {
        let (root, store) = fixture();
        save_body(
            &store,
            WorkflowNodeId::RolesPermissions,
            "# 用户角色与权限\n\n## 角色清单\n角色哨兵",
            NodeStatus::Draft,
        );
        save_body(
            &store,
            WorkflowNodeId::BusinessFlow,
            "# 业务流程设计\n\n## 核心业务流程\n未授权哨兵",
            NodeStatus::Confirmed,
        );
        save_body(
            &store,
            WorkflowNodeId::FeatureDesign,
            "# 功能模块设计\n\n## 功能模块清单\n功能哨兵\n\n## 模块详情\n详情",
            NodeStatus::Generated,
        );

        let nodes = load(&store, WorkflowNodeId::PageInteraction).unwrap();
        assert_eq!(
            nodes.iter().map(|node| node.id).collect::<Vec<_>>(),
            vec![
                WorkflowNodeId::RolesPermissions,
                WorkflowNodeId::FeatureDesign,
            ]
        );
        let rendered = format(&nodes);
        assert!(rendered.contains("角色哨兵"));
        assert!(rendered.contains("功能哨兵"));
        assert!(!rendered.contains("未授权哨兵"));
        assert!(rendered.contains("status=\"draft\""));
        assert!(rendered.contains("revision=\"1\""));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn omits_heading_only_skeletons_but_keeps_any_status_with_body() {
        let (root, store) = fixture();
        assert!(load(&store, WorkflowNodeId::Goals).unwrap().is_empty());
        save_body(
            &store,
            WorkflowNodeId::BasicInfo,
            "# 项目基本信息\n\n## 基础信息表\n仍有正文\n\n## 项目边界",
            NodeStatus::NotStarted,
        );
        assert_eq!(load(&store, WorkflowNodeId::Goals).unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authorized_read_failure_is_safe_and_does_not_return_partial_context() {
        let (root, store) = fixture();
        std::fs::remove_file(root.join("projects/project-1/nodes/goals.json")).unwrap();
        let error = load(&store, WorkflowNodeId::RolesPermissions).unwrap_err();
        assert_eq!(error, "依赖节点“需求背景与建设目标”交付稿读取失败");
        assert!(!error.contains("/nodes/"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
