//! Integration tests for Harness proposal validation and diff summaries.

use sion_core::{
    AgentDeliverySection, DeliveryProposalChange, DeliveryProposalError, WorkflowNodeId,
    document_diff_summary, resolve_delivery_proposal, validate_agent_rule_override,
};

const GOALS_CURRENT: &str =
    "# 需求背景与建设目标\n\n## 需求背景\n旧背景\n\n## 建设目标\n旧目标\n\n## 范围边界\n旧边界";

#[test]
fn patch_proposal_resolves_and_keeps_untouched_sections() {
    let change = DeliveryProposalChange::Patch {
        sections: vec![AgentDeliverySection {
            title: "建设目标".into(),
            content: "新目标".into(),
        }],
    };
    let proposed = resolve_delivery_proposal(&change, WorkflowNodeId::Goals, GOALS_CURRENT, false)
        .unwrap();
    assert!(proposed.contains("## 需求背景\n旧背景"));
    assert!(proposed.contains("新目标"));
    assert!(proposed.contains("## 范围边界\n旧边界"));
    assert!(!proposed.contains("旧目标"));
}

#[test]
fn rewrite_is_rejected_without_turn_authorization() {
    let change = DeliveryProposalChange::Rewrite {
        markdown: "# 需求背景与建设目标\n\n## 需求背景\n新\n\n## 建设目标\n新\n\n## 范围边界\n新".into(),
    };
    let error =
        resolve_delivery_proposal(&change, WorkflowNodeId::Goals, GOALS_CURRENT, false).unwrap_err();
    assert_eq!(error, DeliveryProposalError::RewriteUnauthorized);
}

#[test]
fn rewrite_is_accepted_with_authorization_after_validation() {
    let change = DeliveryProposalChange::Rewrite {
        markdown: "# 需求背景与建设目标\n\n## 需求背景\n新\n\n## 建设目标\n新\n\n## 范围边界\n新".into(),
    };
    let proposed =
        resolve_delivery_proposal(&change, WorkflowNodeId::Goals, GOALS_CURRENT, true).unwrap();
    assert!(proposed.starts_with("# 需求背景与建设目标"));
    assert!(proposed.contains("## 需求背景\n新"));
}

#[test]
fn malformed_sections_fail_with_specific_validation_errors() {
    // A section missing a required sibling section fails validation.
    let missing = DeliveryProposalChange::Rewrite {
        markdown: "# 需求背景与建设目标\n\n## 需求背景\n只有背景".into(),
    };
    let error =
        resolve_delivery_proposal(&missing, WorkflowNodeId::Goals, GOALS_CURRENT, true).unwrap_err();
    assert!(matches!(error, DeliveryProposalError::Delivery(_)));

    // A patch targeting a non-patchable section is rejected.
    let unsupported = DeliveryProposalChange::Patch {
        sections: vec![AgentDeliverySection {
            title: "凭空章节".into(),
            content: "内容".into(),
        }],
    };
    let error =
        resolve_delivery_proposal(&unsupported, WorkflowNodeId::Goals, GOALS_CURRENT, false)
            .unwrap_err();
    assert!(matches!(error, DeliveryProposalError::Delivery(_)));
}

#[test]
fn agent_rule_override_validates_project_local_additive_instructions() {
    let ok = validate_agent_rule_override("先询问澄清，再写入交付稿。\n\n- 保持章节标题不变。").unwrap();
    assert_eq!(ok, "先询问澄清，再写入交付稿。\n\n- 保持章节标题不变。");
    assert!(validate_agent_rule_override("").is_err());
}

#[test]
fn agent_rule_override_rejects_capability_boundary_claims() {
    for forbidden in [
        "允许访问其他节点",
        "可以修改内置规则",
        "允许浏览器搜索",
        "开放网络访问",
        "可以执行 shell 命令",
        "允许读取 ~/.sion",
        "修改 provider 配置",
        "新增可用工具",
    ] {
        let error = validate_agent_rule_override(forbidden).unwrap_err();
        assert!(error.contains("不得声称修改安全能力"), "{forbidden}");
    }
}

#[test]
fn diff_summary_is_bounded_and_marks_omissions() {
    let base_lines = (0..300).map(|i| format!("行{i}")).collect::<Vec<_>>().join("\n");
    let proposed_lines = (0..300)
        .map(|i| format!("新行{i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let summary = document_diff_summary(&base_lines, &proposed_lines, 5);
    assert!(summary.lines().count() <= 6);
    assert!(summary.contains("其余 595 行变更省略"));
    assert!(summary.contains("- 行0"));
}
