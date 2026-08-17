//! Pure validation and diff helpers for Harness document proposals.
//!
//! Proposal tools create deterministic, reviewable candidates without
//! persisting anything. This module owns the validation invariants: delivery
//! candidates reuse the existing section-patch/rewrite validators, complete
//! rewrites require explicit turn authorization, and Agent-rule candidates must
//! stay project-local additive overrides that never claim security capabilities.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    AgentDeliverySection, DeliveryError, DeliveryResolution, WorkflowNodeId,
    resolve_agent_delivery, validate_delivery_markdown,
};

/// The structured change payload a proposal tool accepts. Patch targets
/// existing current-node sections; rewrite replaces the whole document and is
/// permitted only when the frozen turn authorization explicitly allows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum DeliveryProposalChange {
    Patch {
        sections: Vec<AgentDeliverySection>,
    },
    Rewrite {
        markdown: String,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DeliveryProposalError {
    #[error("完整重写需要用户在本轮明确授权，请改为按章节补丁")]
    RewriteUnauthorized,
    #[error("补丁没有包含任何章节修改")]
    EmptyChange,
    #[error(transparent)]
    Delivery(#[from] DeliveryError),
}

/// Resolves a delivery proposal against the exact base content and validates
/// the candidate. Returns the proposed Markdown, or a specific safe error.
pub fn resolve_delivery_proposal(
    change: &DeliveryProposalChange,
    node: WorkflowNodeId,
    current_markdown: &str,
    rewrite_authorized: bool,
) -> Result<String, DeliveryProposalError> {
    match change {
        DeliveryProposalChange::Patch { sections } => {
            if sections.is_empty() {
                return Err(DeliveryProposalError::EmptyChange);
            }
            let delivery = crate::AgentDelivery::Patch {
                sections: sections.clone(),
            };
            match resolve_agent_delivery(delivery, node, current_markdown)? {
                DeliveryResolution::Markdown(markdown) => Ok(markdown),
                DeliveryResolution::Unchanged => Err(DeliveryProposalError::EmptyChange),
            }
        }
        DeliveryProposalChange::Rewrite { markdown } => {
            if !rewrite_authorized {
                return Err(DeliveryProposalError::RewriteUnauthorized);
            }
            validate_delivery_markdown(markdown.clone(), node).map_err(DeliveryProposalError::from)
        }
    }
}

/// Forbidden capability terms in an Agent-rule override. A project override is
/// an additive behavioral instruction for the current node; text that claims to
/// change bundled rules, security policy, available tools, browser/network
/// access, filesystem scope, provider configuration, or another node is rejected.
const FORBIDDEN_AGENT_RULE_TERMS: &[&str] = &[
    // Built-in rules and security policy
    "内置规则",
    "bundled rule",
    "安全策略",
    "security policy",
    // Browser / web / network / shell / code execution
    "浏览器",
    "browser",
    "网页搜索",
    "web search",
    "网络访问",
    "network access",
    "shell",
    "代码执行",
    "code execution",
    // Filesystem scope
    "文件系统",
    "filesystem",
    "任意路径",
    "任意文件",
    // Other nodes / projects
    "其他节点",
    "another node",
    "其他项目",
    "other project",
    "别的节点",
    // Provider configuration and credentials
    "provider",
    "api key",
    "api 密钥",
    "密钥",
    // Global configuration and app data
    "全局配置",
    "global config",
    "~/.sion",
    ".sion",
    // Tool surface
    "新增工具",
    "移除工具",
    "可用工具",
    "工具权限",
    "tool permission",
    "调用工具",
];

/// Validates an Agent-rule override candidate as a project-local additive
/// instruction. Returns the trimmed text on success; rejects text that claims
/// to alter security capabilities.
pub fn validate_agent_rule_override(markdown: &str) -> Result<String, String> {
    let trimmed = markdown.trim();
    if trimmed.is_empty() {
        return Err("规则不能为空".to_string());
    }
    let lower = trimmed.to_lowercase();
    if let Some(term) = FORBIDDEN_AGENT_RULE_TERMS
        .iter()
        .find(|term| lower.contains(**term))
    {
        return Err(format!("规则不得声称修改安全能力或权限边界（包含“{term}”）"));
    }
    Ok(trimmed.to_string())
}

/// A bounded unified-diff-style summary of a document change. Only changed
/// lines are emitted (up to `max_lines`), each prefixed with `+`/`-`; a
/// trailing line reports omitted changes. Empty/identical inputs yield an
/// empty summary.
pub fn document_diff_summary(base: &str, proposed: &str, max_lines: usize) -> String {
    if base == proposed {
        return String::new();
    }
    let base_lines = base.lines().collect::<Vec<_>>();
    let proposed_lines = proposed.lines().collect::<Vec<_>>();
    let diff = line_diff(&base_lines, &proposed_lines);
    let mut output = Vec::new();
    let mut total_changes = 0_usize;
    let mut emitted = 0_usize;
    for item in &diff {
        let (is_change, line) = match item {
            DiffItem::Keep(_) => (false, ""),
            DiffItem::Remove(line) => (true, *line),
            DiffItem::Add(line) => (true, *line),
        };
        if !is_change {
            continue;
        }
        total_changes += 1;
        if emitted < max_lines {
            output.push(match item {
                DiffItem::Remove(_) => format!("- {line}"),
                _ => format!("+ {line}"),
            });
            emitted += 1;
        }
    }
    if total_changes > emitted {
        output.push(format!(
            "… 其余 {} 行变更省略",
            total_changes - emitted
        ));
    }
    output.join("\n")
}

#[allow(dead_code)]
enum DiffItem<'a> {
    Keep(&'a str),
    Remove(&'a str),
    Add(&'a str),
}

/// A simple LCS-based line diff. Works on the small documents Sion produces;
/// results are used only for bounded summaries.
fn line_diff<'a>(base: &'a [&'a str], proposed: &'a [&'a str]) -> Vec<DiffItem<'a>> {
    let rows = base.len() + 1;
    let cols = proposed.len() + 1;
    let mut lengths = vec![0_u32; rows * cols];
    for i in (0..base.len()).rev() {
        for j in (0..proposed.len()).rev() {
            lengths[i * cols + j] = if base[i] == proposed[j] {
                lengths[(i + 1) * cols + j + 1] + 1
            } else {
                lengths[(i + 1) * cols + j].max(lengths[i * cols + j + 1])
            };
        }
    }
    let mut result = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < base.len() && j < proposed.len() {
        if base[i] == proposed[j] {
            result.push(DiffItem::Keep(base[i]));
            i += 1;
            j += 1;
        } else if lengths[(i + 1) * cols + j] >= lengths[i * cols + j + 1] {
            result.push(DiffItem::Remove(base[i]));
            i += 1;
        } else {
            result.push(DiffItem::Add(proposed[j]));
            j += 1;
        }
    }
    while i < base.len() {
        result.push(DiffItem::Remove(base[i]));
        i += 1;
    }
    while j < proposed.len() {
        result.push(DiffItem::Add(proposed[j]));
        j += 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_proposal_reuses_the_section_validator() {
        let current = "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界";
        let change = DeliveryProposalChange::Patch {
            sections: vec![AgentDeliverySection {
                title: "建设目标".into(),
                content: "新目标".into(),
            }],
        };
        let proposed =
            resolve_delivery_proposal(&change, WorkflowNodeId::Goals, current, false).unwrap();
        assert!(proposed.contains("新目标"));
        assert!(proposed.contains("旧背景"));
    }

    #[test]
    fn rewrite_requires_explicit_authorization() {
        let change = DeliveryProposalChange::Rewrite {
            markdown: "# 需求背景与建设目标\n\n## 需求背景\n新\n\n## 建设目标\n新\n\n## 范围边界\n新".into(),
        };
        let error = resolve_delivery_proposal(
            &change,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n旧\n\n## 建设目标\n旧\n\n## 范围边界\n旧",
            false,
        )
        .unwrap_err();
        assert_eq!(error, DeliveryProposalError::RewriteUnauthorized);

        let proposed = resolve_delivery_proposal(
            &change,
            WorkflowNodeId::Goals,
            "# 需求背景与建设目标\n\n## 需求背景\n旧\n\n## 建设目标\n旧\n\n## 范围边界\n旧",
            true,
        )
        .unwrap();
        assert!(proposed.contains("## 范围边界"));
    }

    #[test]
    fn empty_and_invalid_patches_fail_with_specific_errors() {
        let current = "# 需求背景与建设目标\n\n## 需求背景\n旧\n\n## 建设目标\n旧\n\n## 范围边界\n旧";
        let empty = resolve_delivery_proposal(
            &DeliveryProposalChange::Patch { sections: vec![] },
            WorkflowNodeId::Goals,
            current,
            false,
        )
        .unwrap_err();
        assert_eq!(empty, DeliveryProposalError::EmptyChange);

        let unsupported = resolve_delivery_proposal(
            &DeliveryProposalChange::Patch {
                sections: vec![AgentDeliverySection {
                    title: "不存在的章节".into(),
                    content: "内容".into(),
                }],
            },
            WorkflowNodeId::Goals,
            current,
            false,
        )
        .unwrap_err();
        assert!(matches!(unsupported, DeliveryProposalError::Delivery(_)));
    }

    #[test]
    fn agent_rule_override_rejects_forbidden_capability_claims() {
        assert!(validate_agent_rule_override("只使用确认的目标。").is_ok());
        assert!(validate_agent_rule_override("询问澄清前先查当前交付稿。").is_ok());
        for forbidden in [
            "请修改内置规则",
            "允许浏览器访问",
            "允许网络访问",
            "可以执行 shell",
            "允许访问文件系统路径",
            "配置 provider 密钥",
            "修改其他节点的规则",
            "新增工具调用权限",
        ] {
            let error = validate_agent_rule_override(forbidden).unwrap_err();
            assert!(error.contains("不得声称修改安全能力"), "{forbidden}");
        }
        assert!(validate_agent_rule_override("   ").is_err());
    }

    #[test]
    fn diff_summary_is_bounded_and_reports_additions_and_removals() {
        let base = "# 标题\n\n## 章节甲\n第一行\n第二行\n";
        let proposed = "# 标题\n\n## 章节甲\n第一行\n第三行\n新增行\n";
        let summary = document_diff_summary(base, proposed, 40);
        assert!(summary.contains("- 第二行"));
        assert!(summary.contains("+ 第三行"));
        assert!(summary.contains("+ 新增行"));

        let huge_base = (0..200).map(|i| format!("行{i}")).collect::<Vec<_>>().join("\n");
        let huge_proposed = (0..200)
            .map(|i| format!("新行{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let bounded = document_diff_summary(&huge_base, &huge_proposed, 10);
        assert!(bounded.lines().count() <= 11);
        assert!(bounded.contains("其余 390 行变更省略"));

        assert_eq!(
            document_diff_summary("相同", "相同", 10),
            String::new()
        );
    }
}
