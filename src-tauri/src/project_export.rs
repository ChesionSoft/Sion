//! DOCX export keeps the local Markdown readable as a structured Word document.

use std::{io::Cursor, path::Path};

use docx_rs::{
    AbstractNumbering, AlignmentType, Docx, IndentLevel, Level, LevelJc, LevelText, LineSpacing,
    LineSpacingType, NumberFormat, Numbering, NumberingId, PageMargin, Paragraph, Run, RunFonts,
    Shading, SpecialIndentType, Start, Style, StyleType, Table, TableAlignmentType, TableBorder,
    TableBorderPosition, TableBorders, TableCell, TableCellMargins, TableLayoutType,
    TableOfContents, TableRow, WidthType,
};
use sion_core::{ProjectManifest, WorkflowNode};

pub fn write_docx(
    target: &Path,
    manifest: &ProjectManifest,
    nodes: &[WorkflowNode],
) -> Result<(), String> {
    let mut document = Docx::new()
        // standard_business_brief: Letter, one-inch margins, 0.492-inch header/footer.
        .page_size(12_240, 15_840)
        .page_margin(
            PageMargin::new()
                .top(1_440)
                .right(1_440)
                .bottom(1_440)
                .left(1_440)
                .header(708)
                .footer(708),
        )
        .default_size(22)
        .default_fonts(document_fonts())
        .default_line_spacing(body_spacing())
        .add_abstract_numbering(
            AbstractNumbering::new(2).add_level(
                Level::new(
                    0,
                    Start::new(1),
                    NumberFormat::new("bullet"),
                    LevelText::new("•"),
                    LevelJc::new("left"),
                )
                .indent(
                    Some(720),
                    Some(SpecialIndentType::Hanging(360)),
                    None,
                    None,
                ),
            ),
        )
        .add_numbering(Numbering::new(2, 2))
        .add_abstract_numbering(
            AbstractNumbering::new(3).add_level(
                Level::new(
                    0,
                    Start::new(1),
                    NumberFormat::new("decimal"),
                    LevelText::new("%1."),
                    LevelJc::new("left"),
                )
                .indent(
                    Some(720),
                    Some(SpecialIndentType::Hanging(360)),
                    None,
                    None,
                ),
            ),
        )
        .add_numbering(Numbering::new(3, 3))
        .add_style(
            Style::new("Normal", StyleType::Paragraph)
                .name("Normal")
                .size(22)
                .fonts(document_fonts())
                .line_spacing(body_spacing()),
        )
        .add_style(
            Style::new("Title", StyleType::Paragraph)
                .name("Title")
                .align(AlignmentType::Center)
                .size(44)
                .color("0B2545")
                .bold()
                .fonts(document_fonts())
                .line_spacing(
                    LineSpacing::new()
                        .after(240)
                        .line_rule(LineSpacingType::Auto)
                        .line(264),
                ),
        )
        .add_style(
            Style::new("SionMetadata", StyleType::Paragraph)
                .name("Sion Metadata")
                .align(AlignmentType::Center)
                .size(20)
                .color("666666")
                .fonts(document_fonts())
                .line_spacing(
                    LineSpacing::new()
                        .after(240)
                        .line_rule(LineSpacingType::Auto)
                        .line(264),
                ),
        )
        .add_style(
            Style::new("SionTocHeading", StyleType::Paragraph)
                .name("Sion TOC Heading")
                .size(26)
                .color("2E74B5")
                .bold()
                .fonts(document_fonts())
                .line_spacing(
                    LineSpacing::new()
                        .before(240)
                        .after(120)
                        .line_rule(LineSpacingType::Auto)
                        .line(264),
                ),
        )
        .add_style(
            Style::new("SionTableCell", StyleType::Paragraph)
                .name("Sion Table Cell")
                .size(20)
                .fonts(document_fonts())
                .line_spacing(
                    LineSpacing::new()
                        .after(80)
                        .line_rule(LineSpacingType::Auto)
                        .line(240),
                ),
        )
        .add_style(
            Style::new("Heading1", StyleType::Paragraph)
                .name("Heading 1")
                .size(32)
                .color("2E74B5")
                .bold()
                .outline_lvl(0)
                .fonts(document_fonts())
                .line_spacing(
                    LineSpacing::new()
                        .before(320)
                        .after(160)
                        .line_rule(LineSpacingType::Auto)
                        .line(264),
                ),
        )
        .add_style(
            Style::new("Heading2", StyleType::Paragraph)
                .name("Heading 2")
                .size(26)
                .color("2E74B5")
                .bold()
                .outline_lvl(1)
                .fonts(document_fonts())
                .line_spacing(
                    LineSpacing::new()
                        .before(240)
                        .after(120)
                        .line_rule(LineSpacingType::Auto)
                        .line(264),
                ),
        )
        .add_style(
            Style::new("Heading3", StyleType::Paragraph)
                .name("Heading 3")
                .size(24)
                .color("1F4D78")
                .bold()
                .outline_lvl(2)
                .fonts(document_fonts())
                .line_spacing(
                    LineSpacing::new()
                        .before(160)
                        .after(80)
                        .line_rule(LineSpacingType::Auto)
                        .line(264),
                ),
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(text_run(&manifest.name))
                .style("Title"),
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(text_run(format!(
                    "客户：{}    作者：{}    版本：{}",
                    manifest.customer_name, manifest.author_name, manifest.version
                )))
                .style("SionMetadata"),
        )
        .add_table_of_contents(
            TableOfContents::new()
                .heading_styles_range(1, 3)
                .alias("目录")
                .auto()
                .add_before_paragraph(
                    Paragraph::new()
                        .add_run(text_run("目录"))
                        .style("SionTocHeading"),
                ),
        );
    for node in nodes {
        document = add_markdown(document, &node.markdown);
    }
    let mut bytes = Cursor::new(Vec::new());
    document
        .build()
        .pack(&mut bytes)
        .map_err(|error| format!("DOCX pack failed: {error}"))?;
    std::fs::write(target, bytes.into_inner())
        .map_err(|error| format!("cannot write {}: {error}", target.display()))
}

fn add_markdown(mut document: Docx, markdown: &str) -> Docx {
    let lines: Vec<_> = markdown.lines().collect();
    let mut index = 0;
    while let Some(raw_line) = lines.get(index) {
        let line = raw_line.trim_end();
        if index + 1 < lines.len()
            && let (Some(header), Some(separator)) = (
                markdown_table_row(line),
                markdown_table_row(lines[index + 1].trim_end()),
            )
            && is_markdown_table_separator(&separator, header.len())
        {
            let mut rows = vec![header];
            index += 2;
            while let Some(row) = lines
                .get(index)
                .and_then(|row| markdown_table_row(row.trim_end()))
            {
                if row.len() != rows[0].len() {
                    break;
                }
                rows.push(row);
                index += 1;
            }
            document = document.add_table(markdown_table(&rows));
            continue;
        }
        if line.trim().is_empty() {
            index += 1;
            continue;
        }
        let paragraph = if let Some(text) = line.strip_prefix("### ") {
            Paragraph::new()
                .add_run(text_run(text))
                .style("Heading3")
                .keep_next(true)
                .keep_lines(true)
        } else if let Some(text) = line.strip_prefix("## ") {
            Paragraph::new()
                .add_run(text_run(text))
                .style("Heading2")
                .keep_next(true)
                .keep_lines(true)
        } else if let Some(text) = line.strip_prefix("# ") {
            Paragraph::new()
                .add_run(text_run(text))
                .style("Heading1")
                .keep_next(true)
                .keep_lines(true)
        } else if let Some(text) = bullet_list_item(line) {
            Paragraph::new()
                .add_run(text_run(text))
                .style("Normal")
                .numbering(NumberingId::new(2), IndentLevel::new(0))
        } else if numbered_list_item(line).is_some() {
            Paragraph::new()
                .add_run(text_run(
                    line.split_once(". ")
                        .map(|(_, text)| text)
                        .unwrap_or_default(),
                ))
                .style("Normal")
                .numbering(NumberingId::new(3), IndentLevel::new(0))
        } else {
            Paragraph::new().add_run(text_run(line)).style("Normal")
        };
        document = document.add_paragraph(paragraph);
        index += 1;
    }
    document
}

fn markdown_table(rows: &[Vec<String>]) -> Table {
    let column_count = rows.first().map_or(0, Vec::len);
    let column_widths = equal_column_widths(column_count);
    let table_rows = rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            TableRow::new(
                row.iter()
                    .zip(&column_widths)
                    .map(|(cell, width)| {
                        let run = if row_index == 0 {
                            text_run(cell).bold()
                        } else {
                            text_run(cell)
                        };
                        let cell = TableCell::new()
                            .width(*width, WidthType::Dxa)
                            .add_paragraph(Paragraph::new().add_run(run).style("SionTableCell"));
                        if row_index == 0 {
                            cell.shading(Shading::new().fill("F2F4F7"))
                        } else {
                            cell
                        }
                    })
                    .collect(),
            )
            .cant_split()
        })
        .collect();
    Table::new(table_rows)
        .width(9_360, WidthType::Dxa)
        .indent(120)
        .align(TableAlignmentType::Left)
        .layout(TableLayoutType::Fixed)
        .set_grid(column_widths)
        .margins(TableCellMargins::new().margin(80, 120, 80, 120))
        .set_borders(table_borders())
}

fn equal_column_widths(column_count: usize) -> Vec<usize> {
    if column_count == 0 {
        return Vec::new();
    }
    let base = 9_360 / column_count;
    let remainder = 9_360 % column_count;
    (0..column_count)
        .map(|index| base + usize::from(index < remainder))
        .collect()
}

fn table_borders() -> TableBorders {
    [
        TableBorderPosition::Top,
        TableBorderPosition::Left,
        TableBorderPosition::Bottom,
        TableBorderPosition::Right,
        TableBorderPosition::InsideH,
        TableBorderPosition::InsideV,
    ]
    .into_iter()
    .fold(TableBorders::with_empty(), |borders, position| {
        borders.set(TableBorder::new(position).color("DADCE0").size(4))
    })
}

fn markdown_table_row(line: &str) -> Option<Vec<String>> {
    let line = line.trim();
    let line = line.strip_prefix('|').unwrap_or(line);
    let line = line.strip_suffix('|').unwrap_or(line);
    let cells: Vec<_> = line
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect();
    (cells.len() >= 2).then_some(cells)
}

fn is_markdown_table_separator(cells: &[String], expected_columns: usize) -> bool {
    cells.len() == expected_columns
        && cells.iter().all(|cell| {
            let marker = cell.trim().trim_matches(':');
            marker.len() >= 3 && marker.bytes().all(|byte| byte == b'-')
        })
}

fn bullet_list_item(line: &str) -> Option<&str> {
    ["- ", "* ", "+ "]
        .into_iter()
        .find_map(|marker| line.strip_prefix(marker))
}

fn numbered_list_item(line: &str) -> Option<(&str, &str)> {
    let (number, text) = line.split_once(". ")?;
    (!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
        .then_some((number, text))
}

fn document_fonts() -> RunFonts {
    RunFonts::new()
        .ascii("Calibri")
        .hi_ansi("Calibri")
        .east_asia("Microsoft YaHei")
        .cs("Calibri")
}

fn text_run(text: impl Into<String>) -> Run {
    Run::new().fonts(document_fonts()).add_text(text)
}

fn body_spacing() -> LineSpacing {
    LineSpacing::new()
        .after(120)
        .line_rule(LineSpacingType::Auto)
        .line(264)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    #[test]
    fn preserves_project_text_and_word_heading_structure() {
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
            markdown:
                "# 项目简介\n\n## 范围\n\n| 阶段 | 负责人 |\n| --- | :---: |\n| 调研 | 产品 |\n\n- 保留所有正文。\n* 兼容星号项目符号。\n1. 确认导出。"
                    .to_string(),
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
        assert!(xml.contains("w:pStyle w:val=\"Title\""));
        assert!(xml.contains("w:pStyle w:val=\"Heading1\""));
        assert!(xml.contains("w:pStyle w:val=\"Heading2\""));
        assert!(xml.contains("w:numPr"));
        assert!(xml.contains("TOC"));
        let mut numbering_xml = String::new();
        archive
            .by_name("word/numbering.xml")
            .unwrap()
            .read_to_string(&mut numbering_xml)
            .unwrap();
        assert!(numbering_xml.contains("w:numFmt w:val=\"bullet\""));
        assert!(numbering_xml.contains("w:numFmt w:val=\"decimal\""));
        let mut styles_xml = String::new();
        archive
            .by_name("word/styles.xml")
            .unwrap()
            .read_to_string(&mut styles_xml)
            .unwrap();
        assert!(styles_xml.contains("Microsoft YaHei"));
        assert!(styles_xml.contains("w:after=\"120\""));
        assert!(styles_xml.contains("w:color w:val=\"2E74B5\""));
        assert!(xml.contains("w:pgSz w:w=\"12240\" w:h=\"15840\""));
        assert!(xml.contains("w:pgMar w:top=\"1440\" w:right=\"1440\""));
        assert!(xml.contains("阶段"));
        assert!(xml.contains("负责人"));
        assert!(xml.contains("w:tblW w:w=\"9360\" w:type=\"dxa\""));
        assert!(xml.contains("w:tblLayout w:type=\"fixed\""));
        assert!(xml.contains("w:tblCellMar"));
        assert!(xml.contains("w:fill=\"F2F4F7\""));
        if let Some(destination) = std::env::var_os("SION_DOCX_QA_OUTPUT") {
            std::fs::copy(&root, destination).unwrap();
        }
        let _ = std::fs::remove_file(root);
    }

    #[test]
    fn recognizes_only_numeric_ordered_markdown_list_markers() {
        assert_eq!(numbered_list_item("12. 项目"), Some(("12", "项目")));
        assert_eq!(numbered_list_item("A. 不是有序列表"), None);
        assert_eq!(numbered_list_item("1. "), Some(("1", "")));
        assert_eq!(bullet_list_item("* 项目"), Some("项目"));
        assert_eq!(bullet_list_item("+ 项目"), Some("项目"));
        assert_eq!(bullet_list_item("普通文本"), None);
        assert_eq!(equal_column_widths(3), vec![3120, 3120, 3120]);
        assert_eq!(equal_column_widths(7).iter().sum::<usize>(), 9360);
        assert!(is_markdown_table_separator(
            &["---".to_string(), ":---:".to_string()],
            2
        ));
        assert!(!is_markdown_table_separator(
            &["---".to_string(), "---".to_string()],
            3
        ));
    }
}
