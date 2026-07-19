//! Export workflow domain: fixed artifact kinds, workspace state, approvals,
//! source snapshots, candidates, review status, and digest/staleness helpers.
//!
//! This module is pure domain logic. It owns no filesystem, Tauri, or provider
//! access. Persisted structs use camelCase so the on-disk JSON mirrors the IPC
//! wire shape; the artifact kind enum is snake_case to match the design
//! contract. Review tasks, proposed changes, patch operations, and the
//! blueprint/draft content model live in [`content`] alongside their parsing
//! and validation behavior.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{ChatModelSelection, WorkflowNode, WorkflowNodeId};

mod content;
pub use content::*;

/// The eight fixed export files. Blueprint is preparation material; the other
/// seven are delivery artifacts. Filenames are fixed so IPC never accepts an
/// arbitrary path or filename.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportArtifactKind {
    Blueprint,
    FormalDraft,
    QaReport,
    FormalDocx,
    ProjectDesign,
    Spec,
    Tasks,
    Agents,
}

impl ExportArtifactKind {
    pub const ALL: [Self; 8] = [
        Self::Blueprint,
        Self::FormalDraft,
        Self::QaReport,
        Self::FormalDocx,
        Self::ProjectDesign,
        Self::Spec,
        Self::Tasks,
        Self::Agents,
    ];

    pub const DELIVERY_ARTIFACTS: [Self; 7] = [
        Self::FormalDraft,
        Self::QaReport,
        Self::FormalDocx,
        Self::ProjectDesign,
        Self::Spec,
        Self::Tasks,
        Self::Agents,
    ];

    pub fn filename(self) -> &'static str {
        match self {
            Self::Blueprint => "export-blueprint.md",
            Self::FormalDraft => "formal-prd-draft.md",
            Self::QaReport => "formal-prd-qa-report.md",
            Self::FormalDocx => "项目开发设计文档.docx",
            Self::ProjectDesign => "PROJECT_DESIGN.md",
            Self::Spec => "SPEC.md",
            Self::Tasks => "TASKS.md",
            Self::Agents => "AGENTS.md",
        }
    }

    pub fn is_delivery_artifact(self) -> bool {
        self != Self::Blueprint
    }
}

/// Persisted metadata for one fixed export file. `source_snapshot`,
/// `based_on_blueprint_digest`, and `based_on_draft_digest` are absent until the
/// artifact is generated from approved upstream content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifactRecord {
    pub kind: ExportArtifactKind,
    pub filename: String,
    pub revision: u64,
    pub digest: String,
    pub byte_size: u64,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_snapshot: Option<ExportSourceSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub based_on_blueprint_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub based_on_draft_digest: Option<String>,
}

/// One workflow node captured at generation time. A node is stale when its
/// current revision or content digest no longer matches the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportNodeSnapshot {
    pub node_id: WorkflowNodeId,
    pub revision: u64,
    pub digest: String,
}

/// The set of source workflow nodes an artifact was generated from. Only the
/// first eleven content nodes are captured; the final-export node is never a
/// source for export generation.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSourceSnapshot {
    pub nodes: Vec<ExportNodeSnapshot>,
}

/// A user approval bound to a specific revision and digest. Only blueprint and
/// formal draft can be approved; downstream generation requires the current
/// digest to match the approved digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportApproval {
    pub artifact_kind: ExportArtifactKind,
    pub approved_revision: u64,
    pub approved_digest: String,
    pub approved_at: String,
}

/// Formal Word QA outcome. The full report is persisted as the `QaReport`
/// artifact file; this state records which draft was checked, when, and the
/// stable issue codes so the UI can summarize a failure without re-reading it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportQaState {
    #[default]
    None,
    Passed {
        checked_draft_digest: String,
        checked_at: String,
    },
    Failed {
        checked_draft_digest: String,
        checked_at: String,
        issue_codes: Vec<String>,
    },
}

/// A validated regeneration candidate for blueprint or formal draft. Candidates
/// are persisted under `exports/candidates/` so a restart can resume review;
/// they never replace the current artifact until the user applies them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCandidate {
    pub id: String,
    pub target_kind: ExportArtifactKind,
    pub base_revision: u64,
    pub base_digest: String,
    pub candidate_digest: String,
    pub markdown: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ChatModelSelection>,
    pub created_at: String,
}

/// Lifecycle of a non-chat review task. `Stale` means the target document has
/// changed since the task was created, so its proposals are refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportReviewStatus {
    Queued,
    Running,
    Ready,
    PartiallyApplied,
    Applied,
    Stale,
    Failed,
    Cancelled,
}

/// Engineering attachment batch state. The four deterministic files
/// (`PROJECT_DESIGN`, `SPEC`, `TASKS`, `AGENTS`) are written as one batch; the
/// batch is `Complete` only when all four succeed. A failure records the failed
/// kinds so the user can retry the whole batch.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportAttachmentBatchStatus {
    #[default]
    None,
    Complete,
    Failed {
        failed_kinds: Vec<ExportArtifactKind>,
    },
}

/// Recoverable export workspace state, persisted as `exports/export-state.json`.
/// Review tasks are discovered separately from `exports/reviews/`, so they are
/// not embedded here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWorkspaceState {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ChatModelSelection>,
    #[serde(default)]
    pub artifacts: Vec<ExportArtifactRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blueprint_approval: Option<ExportApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_approval: Option<ExportApproval>,
    #[serde(default)]
    pub qa_state: ExportQaState,
    #[serde(default)]
    pub pending_candidates: Vec<ExportCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_run_id: Option<String>,
    #[serde(default)]
    pub attachment_batch_status: ExportAttachmentBatchStatus,
    #[serde(default)]
    pub updated_at: String,
}

pub const EXPORT_WORKSPACE_SCHEMA_VERSION: u32 = 1;

impl Default for ExportWorkspaceState {
    fn default() -> Self {
        Self {
            schema_version: EXPORT_WORKSPACE_SCHEMA_VERSION,
            model_selection: None,
            artifacts: Vec::new(),
            blueprint_approval: None,
            draft_approval: None,
            qa_state: ExportQaState::None,
            pending_candidates: Vec::new(),
            active_run_id: None,
            attachment_batch_status: ExportAttachmentBatchStatus::None,
            updated_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ExportMutationError {
    #[error("artifact kind {0:?} cannot be approved")]
    UnsupportedApprovalKind(ExportArtifactKind),
}

/// Stable SHA-256 hex digest of raw bytes. Used for content digests and CAS
/// approval binding.
pub fn export_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Captures the revision and content digest of every content workflow node
/// (the first eleven nodes, excluding `FinalExport`) so later staleness checks
/// can detect advisory source changes.
pub fn capture_export_source(nodes: &[WorkflowNode]) -> ExportSourceSnapshot {
    let captured = nodes
        .iter()
        .filter(|node| node.id != WorkflowNodeId::FinalExport)
        .map(|node| ExportNodeSnapshot {
            node_id: node.id,
            revision: node.revision,
            digest: export_digest(node.markdown.as_bytes()),
        });
    ExportSourceSnapshot {
        nodes: captured.collect(),
    }
}

/// Returns the content node ids whose current revision or content digest no
/// longer matches the snapshot. This is advisory: it never revokes approval or
/// blocks generation, preview, download, or Save As.
pub fn stale_source_nodes(
    snapshot: &ExportSourceSnapshot,
    nodes: &[WorkflowNode],
) -> Vec<WorkflowNodeId> {
    let by_id: std::collections::HashMap<WorkflowNodeId, &ExportNodeSnapshot> = snapshot
        .nodes
        .iter()
        .map(|entry| (entry.node_id, entry))
        .collect();
    nodes
        .iter()
        .filter_map(|node| {
            let snapshot = by_id.get(&node.id)?;
            let current_digest = export_digest(node.markdown.as_bytes());
            let stale = node.revision != snapshot.revision || current_digest != snapshot.digest;
            stale.then_some(node.id)
        })
        .collect()
}

/// Records an approval for the current blueprint or formal draft. Only those
/// two kinds are approvable; other kinds return an error.
pub fn approve_current(
    state: &mut ExportWorkspaceState,
    kind: ExportArtifactKind,
    revision: u64,
    digest: &str,
    now: &str,
) -> Result<(), ExportMutationError> {
    let approval = ExportApproval {
        artifact_kind: kind,
        approved_revision: revision,
        approved_digest: digest.to_string(),
        approved_at: now.to_string(),
    };
    match kind {
        ExportArtifactKind::Blueprint => state.blueprint_approval = Some(approval),
        ExportArtifactKind::FormalDraft => state.draft_approval = Some(approval),
        _ => return Err(ExportMutationError::UnsupportedApprovalKind(kind)),
    }
    Ok(())
}

/// Replaces the same-kind artifact record. When the artifact's content digest
/// changed, only that artifact's approval is revoked; downstream records are
/// left in place and remain visibly based on the older digest.
pub fn record_artifact_change(state: &mut ExportWorkspaceState, record: ExportArtifactRecord) {
    let kind = record.kind;
    let new_digest = record.digest.clone();
    let previous_digest = state
        .artifacts
        .iter()
        .find(|existing| existing.kind == kind)
        .map(|existing| existing.digest.clone());
    if let Some(position) = state
        .artifacts
        .iter()
        .position(|existing| existing.kind == kind)
    {
        state.artifacts[position] = record;
    } else {
        state.artifacts.push(record);
    }
    let content_changed = previous_digest.as_deref() != Some(new_digest.as_str());
    if content_changed {
        match kind {
            ExportArtifactKind::Blueprint => state.blueprint_approval = None,
            ExportArtifactKind::FormalDraft => state.draft_approval = None,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NodeStatus, WorkflowNode, WorkflowNodeId};

    #[test]
    fn source_changes_are_advisory_but_artifact_changes_revoke_approval() {
        let nodes = fixture_nodes();
        let snapshot = capture_export_source(&nodes);
        assert!(stale_source_nodes(&snapshot, &nodes).is_empty());

        let mut changed_nodes = nodes.clone();
        changed_nodes[0].revision += 1;
        changed_nodes[0].markdown.push_str("\n新增事实");
        assert_eq!(
            stale_source_nodes(&snapshot, &changed_nodes),
            vec![WorkflowNodeId::BasicInfo]
        );

        let mut state = ExportWorkspaceState::default();
        state
            .artifacts
            .push(record(ExportArtifactKind::Blueprint, 1, "old"));
        approve_current(
            &mut state,
            ExportArtifactKind::Blueprint,
            1,
            "old",
            "2026-07-19T00:00:00Z",
        )
        .unwrap();
        record_artifact_change(&mut state, record(ExportArtifactKind::Blueprint, 2, "new"));
        assert!(state.blueprint_approval.is_none());
    }

    #[test]
    fn artifact_filenames_are_fixed_and_blueprint_is_not_a_delivery_artifact() {
        assert_eq!(
            ExportArtifactKind::Blueprint.filename(),
            "export-blueprint.md"
        );
        assert!(!ExportArtifactKind::Blueprint.is_delivery_artifact());
        assert_eq!(ExportArtifactKind::DELIVERY_ARTIFACTS.len(), 7);
        assert_eq!(
            ExportArtifactKind::FormalDocx.filename(),
            "项目开发设计文档.docx"
        );
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

    fn record(kind: ExportArtifactKind, revision: u64, digest: &str) -> ExportArtifactRecord {
        ExportArtifactRecord {
            kind,
            filename: kind.filename().into(),
            revision,
            digest: digest.into(),
            byte_size: 0,
            updated_at: "2026-07-19T00:00:00Z".into(),
            source_snapshot: None,
            based_on_blueprint_digest: None,
            based_on_draft_digest: None,
        }
    }
}
