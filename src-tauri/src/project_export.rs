//! Tier-one DOCX export preserves all project text before rich layout work.

use std::{io::Cursor, path::Path};

use docx_rs::{Docx, Paragraph, Run};
use sion_core::{ProjectManifest, WorkflowNode};

pub fn write_docx(
    target: &Path,
    manifest: &ProjectManifest,
    nodes: &[WorkflowNode],
) -> Result<(), String> {
    let mut document = Docx::new()
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text(&manifest.name)))
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text(format!(
            "客户：{}\n作者：{}\n版本：{}",
            manifest.customer_name, manifest.author_name, manifest.version
        ))));
    for node in nodes {
        document = document
            .add_paragraph(Paragraph::new().add_run(Run::new().add_text(node.id.as_str())))
            .add_paragraph(Paragraph::new().add_run(Run::new().add_text(&node.markdown)));
    }
    let mut bytes = Cursor::new(Vec::new());
    document
        .build()
        .pack(&mut bytes)
        .map_err(|error| format!("DOCX pack failed: {error}"))?;
    std::fs::write(target, bytes.into_inner())
        .map_err(|error| format!("cannot write {}: {error}", target.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    #[test]
    fn preserves_project_and_node_text_in_a_readable_docx() {
        let root = std::env::temp_dir().join(format!("sion-export-{}", uuid::Uuid::new_v4()));
        let manifest = ProjectManifest {
            schema_version: 1,
            id: "project-a".to_string(),
            name: "导出样例".to_string(),
            customer_name: "客户".to_string(),
            author_name: "作者".to_string(),
            version: "V1".to_string(),
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        };
        let node = WorkflowNode {
            id: sion_core::WorkflowNodeId::BasicInfo,
            status: sion_core::NodeStatus::Draft,
            markdown: "# 项目简介\n保留所有正文。".to_string(),
            revision: 1,
            updated_at: "now".to_string(),
        };
        write_docx(&root, &manifest, &[node]).unwrap();
        let mut archive = ZipArchive::new(std::fs::File::open(&root).unwrap()).unwrap();
        let mut xml = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("导出样例"));
        assert!(xml.contains("项目简介"));
        let _ = std::fs::remove_file(root);
    }
}
