use std::io::{Cursor, Read};

use docx_rs::{Docx, Paragraph, Run};
use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Serialize;
use zip::ZipArchive;

pub fn round_trip_check() -> Result<(), String> {
    let expected = "Sion 桌面版 DOCX 验证";
    let mut bytes = Cursor::new(Vec::new());
    Docx::new()
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text(expected)))
        .build()
        .pack(&mut bytes)
        .map_err(|error| format!("DOCX pack failed: {error}"))?;

    let mut archive = ZipArchive::new(Cursor::new(bytes.into_inner()))
        .map_err(|error| format!("DOCX is not a readable ZIP: {error}"))?;
    let mut document_xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|error| format!("DOCX document.xml missing: {error}"))?
        .read_to_string(&mut document_xml)
        .map_err(|error| format!("DOCX document.xml read failed: {error}"))?;

    if !document_xml.contains(expected) {
        return Err("DOCX text round trip did not preserve the expected Chinese title".to_string());
    }
    if archive.by_name("[Content_Types].xml").is_err() {
        return Err("DOCX content types manifest is missing".to_string());
    }
    Ok(())
}

/// Stable issue codes recorded by [`check_export_docx`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxQaIssue {
    pub code: String,
    pub message: String,
}

/// Structural QA report for a candidate formal DOCX checked against the approved
/// formal draft Markdown. Word or WPS remains authoritative for cover, TOC,
/// pagination, headers, and footers; this only verifies content integrity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxQaReport {
    pub passed: bool,
    pub structural_unit_count: u32,
    pub issues: Vec<DocxQaIssue>,
    pub checked_at: String,
}

fn issue(code: &str, message: impl Into<String>) -> DocxQaIssue {
    DocxQaIssue {
        code: code.to_string(),
        message: message.into(),
    }
}

/// Checks a candidate DOCX against the approved formal draft: requires the
/// content-types manifest and document.xml, extracts visible text, verifies
/// Chinese text is present, verifies every approved H2 heading appears, and
/// verifies at least one structural unit. Records stable issue codes.
pub fn check_export_docx(bytes: &[u8], approved_markdown: &str, checked_at: &str) -> DocxQaReport {
    let mut issues: Vec<DocxQaIssue> = Vec::new();
    let cursor = Cursor::new(bytes.to_vec());
    let mut archive = match ZipArchive::new(cursor) {
        Ok(archive) => archive,
        Err(error) => {
            issues.push(issue(
                "docx_not_zip",
                format!("DOCX is not a readable ZIP: {error}"),
            ));
            return DocxQaReport {
                passed: false,
                structural_unit_count: 0,
                issues,
                checked_at: checked_at.to_string(),
            };
        }
    };
    if archive.by_name("[Content_Types].xml").is_err() {
        issues.push(issue(
            "content_types_missing",
            "[Content_Types].xml is missing",
        ));
    }
    let mut document_xml = String::new();
    match archive.by_name("word/document.xml") {
        Ok(mut entry) => {
            if entry.read_to_string(&mut document_xml).is_err() {
                issues.push(issue(
                    "document_xml_unreadable",
                    "word/document.xml cannot be read",
                ));
            }
        }
        Err(_) => issues.push(issue(
            "document_xml_missing",
            "word/document.xml is missing",
        )),
    }
    if issues
        .iter()
        .any(|entry| entry.code == "document_xml_missing")
    {
        return DocxQaReport {
            passed: false,
            structural_unit_count: 0,
            issues,
            checked_at: checked_at.to_string(),
        };
    }
    let (text, structural_unit_count) = extract_docx_text(&document_xml);
    if !text.chars().any(is_chinese) {
        issues.push(issue(
            "missing_chinese_text",
            "DOCX contains no Chinese text",
        ));
    }
    for heading in approved_h2_headings(approved_markdown) {
        if !text.contains(&heading) {
            issues.push(issue(
                "missing_heading",
                format!("approved H2 heading not found: {heading}"),
            ));
        }
    }
    if structural_unit_count == 0 {
        issues.push(issue("no_structural_units", "DOCX has no structural units"));
    }
    let passed = issues.is_empty();
    DocxQaReport {
        passed,
        structural_unit_count,
        issues,
        checked_at: checked_at.to_string(),
    }
}

fn is_chinese(character: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&character)
}

fn approved_h2_headings(markdown: &str) -> Vec<String> {
    markdown
        .lines()
        .filter_map(|line| {
            line.trim_start()
                .strip_prefix("## ")
                .map(str::trim)
                .filter(|heading| !heading.is_empty())
        })
        .map(str::to_string)
        .collect()
}

fn extract_docx_text(document_xml: &str) -> (String, u32) {
    let mut reader = Reader::from_str(document_xml);
    reader.config_mut().trim_text(true);
    let mut text = String::new();
    let mut structural_unit_count = 0u32;
    let mut in_text = false;
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Err(_) | Ok(Event::Eof) => break,
            Ok(Event::Start(event)) => {
                let name = event.name();
                if name.as_ref() == b"w:p" {
                    structural_unit_count += 1;
                } else if name.as_ref() == b"w:t" {
                    in_text = true;
                }
            }
            Ok(Event::Empty(event)) if event.name().as_ref() == b"w:p" => {
                structural_unit_count += 1;
            }
            Ok(Event::Text(event)) => {
                if in_text
                    && let Ok(raw) = std::str::from_utf8(&event)
                    && let Ok(value) = quick_xml::escape::unescape(raw)
                {
                    text.push_str(&value);
                }
            }
            Ok(Event::End(event)) if event.name().as_ref() == b"w:t" => {
                in_text = false;
            }
            _ => {}
        }
        buffer.clear();
    }
    (text, structural_unit_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_readable_docx_with_chinese_text() {
        round_trip_check().unwrap();
    }
}
