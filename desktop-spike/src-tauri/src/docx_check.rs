use std::io::{Cursor, Read};

use docx_rs::{Docx, Paragraph, Run};
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_readable_docx_with_chinese_text() {
        round_trip_check().unwrap();
    }
}
