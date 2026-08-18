//! Bounded semantic review for confirmed Harness writes.
//!
//! The reviewer is deliberately separate from Markdown parsing and storage:
//! it receives only the user-confirmed intent and bounded document text, and
//! returns a finite verdict. It never produces replacement Markdown and it has
//! no write capability. The default implementation is conservative and
//! deterministic; a provider-backed reviewer can be introduced behind the
//! same request/result contract without changing the CAS boundary.

use sion_core::{SemanticReviewResult, SemanticReviewVerdict, WorkflowNodeId};

pub(crate) const MAX_REVIEW_TEXT_CHARS: usize = 200_000;
const MAX_FEEDBACK_ITEMS: usize = 6;
const MAX_FEEDBACK_CHARS: usize = 160;

#[derive(Debug, Clone)]
pub(crate) struct SemanticReviewRequest {
    pub(crate) summary: String,
    pub(crate) node_id: WorkflowNodeId,
    pub(crate) original_markdown: String,
    pub(crate) candidate_markdown: String,
    pub(crate) saved_target_summaries: Vec<String>,
}

/// Reviews one structurally valid candidate without constraining normal
/// Markdown expression. Only obvious completeness/scope violations revise;
/// the candidate itself is never returned by this module.
pub(crate) fn review_candidate(request: &SemanticReviewRequest) -> SemanticReviewResult {
    let _original_length = request.original_markdown.chars().count();
    let mut missing_requirements = Vec::new();
    let mut out_of_plan_content = Vec::new();
    let mut cross_node_conflicts = Vec::new();

    if request.candidate_markdown.chars().count() > MAX_REVIEW_TEXT_CHARS {
        out_of_plan_content.push("候选文稿超过允许长度".to_string());
    }
    if request.candidate_markdown.trim().is_empty() {
        missing_requirements.push("候选文稿不能为空".to_string());
    }

    // A summary may name a required top-level heading. This is intentionally
    // a narrow check: prose, tables, and section formatting remain unrestricted.
    for requirement in summary_heading_requirements(&request.summary, &request.original_markdown) {
        if !request.candidate_markdown.contains(&requirement) {
            missing_requirements.push(format!("缺少计划中提到的章节：{requirement}"));
        }
    }

    // A candidate must not claim to have changed a different node. This catches
    // accidental cross-node output while leaving ordinary mentions untouched.
    for node in WorkflowNodeId::ALL {
        if node != request.node_id
            && request
                .candidate_markdown
                .contains(&format!("nodeId: {}", node.as_str()))
        {
            out_of_plan_content.push(format!("候选文稿包含其他节点标识：{}", node.as_str()));
        }
    }

    // Saved target summaries are public, bounded evidence. A direct conflict
    // marker is treated as revise; the reviewer never chooses which document
    // should win over CAS.
    for summary in &request.saved_target_summaries {
        if summary.contains("冲突") || summary.contains("不一致") {
            cross_node_conflicts.push(bound(summary));
        }
    }

    trim_items(&mut missing_requirements);
    trim_items(&mut out_of_plan_content);
    trim_items(&mut cross_node_conflicts);
    let revise = !missing_requirements.is_empty()
        || !out_of_plan_content.is_empty()
        || !cross_node_conflicts.is_empty();
    SemanticReviewResult {
        verdict: if revise {
            SemanticReviewVerdict::Revise
        } else {
            SemanticReviewVerdict::Pass
        },
        missing_requirements,
        out_of_plan_content,
        cross_node_conflicts,
        reason: revise.then(|| "候选文稿需要按确认意图修正后再保存".to_string()),
    }
}

fn summary_heading_requirements(summary: &str, original_markdown: &str) -> Vec<String> {
    ["需求背景", "建设目标", "范围边界", "实施方案", "预算", "风险"]
        .iter()
        .filter(|heading| {
            summary.contains(**heading)
                && original_markdown.contains(&format!("## {heading}"))
        })
        .map(|heading| format!("## {heading}"))
        .collect()
}

fn bound(value: &str) -> String {
    value.chars().take(MAX_FEEDBACK_CHARS).collect()
}

fn trim_items(items: &mut Vec<String>) {
    items.truncate(MAX_FEEDBACK_ITEMS);
    for item in items {
        *item = bound(item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(summary: &str, candidate: &str) -> SemanticReviewRequest {
        SemanticReviewRequest {
            summary: summary.to_string(),
            node_id: WorkflowNodeId::Goals,
            original_markdown: "# 原稿\n\n## 建设目标\n旧内容".to_string(),
            candidate_markdown: candidate.to_string(),
            saved_target_summaries: Vec::new(),
        }
    }

    #[test]
    fn review_passes_free_form_markdown_when_intent_is_satisfied() {
        let result = review_candidate(&request(
            "补充建设目标",
            "# 标题\n\n## 建设目标\n使用表格、列表和自由段落",
        ));
        assert_eq!(result.verdict, SemanticReviewVerdict::Pass);
    }

    #[test]
    fn review_returns_bounded_revise_feedback_without_markdown() {
        let result = review_candidate(&request("补充建设目标", "# 标题"));
        assert_eq!(result.verdict, SemanticReviewVerdict::Revise);
        assert!(!result.missing_requirements.is_empty());
        assert!(result.reason.is_some());
    }

    #[test]
    fn review_detects_cross_node_conflict_marker() {
        let mut request = request("补充内容", "# 标题");
        request.saved_target_summaries = vec!["节点内容不一致".to_string()];
        let result = review_candidate(&request);
        assert_eq!(result.verdict, SemanticReviewVerdict::Revise);
        assert_eq!(result.cross_node_conflicts.len(), 1);
    }
}
