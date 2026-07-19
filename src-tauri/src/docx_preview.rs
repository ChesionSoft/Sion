//! Bounded DOCX-to-sanitized-HTML content preview.
//!
//! Only document-owned paragraphs, headings, lists, and tables are parsed, and
//! only a fixed allowlist of HTML tags is emitted. All text is escaped, so the
//! Markdown source `<script>` becomes visible text rather than an element. Word
//! or WPS remains authoritative for cover, TOC, pagination, headers, and
//! footers; this is a content-only preview bounded by byte and character limits.

use std::io::Read;

use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Serialize;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxHtmlPreview {
    pub html: String,
    pub truncated: bool,
    pub character_count: usize,
}

/// Converts a formal DOCX into bounded, sanitized HTML for in-app preview.
pub fn preview_docx(
    bytes: &[u8],
    max_bytes: usize,
    max_chars: usize,
) -> Result<DocxHtmlPreview, String> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut archive =
        ZipArchive::new(cursor).map_err(|error| format!("DOCX is not a readable ZIP: {error}"))?;
    let mut document_xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|error| format!("DOCX document.xml is missing: {error}"))?
        .read_to_string(&mut document_xml)
        .map_err(|error| format!("DOCX document.xml cannot be read: {error}"))?;
    if document_xml.len() > max_bytes {
        document_xml.truncate(max_bytes);
    }
    let (html, truncated) = render_document_xml(&document_xml, max_chars);
    let character_count = html.chars().count();
    Ok(DocxHtmlPreview {
        html,
        truncated,
        character_count,
    })
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

fn heading_tag(style: &str) -> Option<&'static str> {
    match style {
        "Title" | "Heading1" => Some("h1"),
        "Heading2" => Some("h2"),
        "Heading3" => Some("h3"),
        _ => None,
    }
}

type Paragraph = Option<(Option<String>, String, bool)>;

fn flush_paragraph(paragraph: &mut Paragraph, html: &mut String) {
    if let Some((style, text, is_list)) = paragraph.take()
        && !text.trim().is_empty()
    {
        let escaped = escape_html(text.trim());
        let tag = style.as_deref().and_then(heading_tag);
        let fragment = match tag {
            Some("h1") => format!("<h1>{escaped}</h1>"),
            Some("h2") => format!("<h2>{escaped}</h2>"),
            Some("h3") => format!("<h3>{escaped}</h3>"),
            _ if is_list => format!("<li>{escaped}</li>"),
            _ => format!("<p>{escaped}</p>"),
        };
        html.push_str(&fragment);
    }
}

fn render_document_xml(document_xml: &str, max_chars: usize) -> (String, bool) {
    let mut reader = Reader::from_str(document_xml);
    reader.config_mut().trim_text(true);
    let mut html = String::new();
    let mut truncated = false;
    let mut in_text = false;
    let mut paragraph: Paragraph = None;
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Err(_) | Ok(Event::Eof) => break,
            Ok(Event::Start(event)) => {
                let name = event.name();
                if name.as_ref() == b"w:p" {
                    flush_paragraph(&mut paragraph, &mut html);
                    paragraph = Some((None, String::new(), false));
                } else if name.as_ref() == b"w:t" {
                    in_text = true;
                } else if name.as_ref() == b"w:numPr"
                    && let Some((_, _, is_list)) = paragraph.as_mut()
                {
                    *is_list = true;
                }
            }
            Ok(Event::Empty(event)) => {
                let name = event.name();
                if name.as_ref() == b"w:numPr"
                    && let Some((_, _, is_list)) = paragraph.as_mut()
                {
                    *is_list = true;
                } else if name.as_ref() == b"w:pStyle" {
                    for attribute in event.attributes().flatten() {
                        if attribute.key.as_ref() == b"w:val"
                            && let Some((style, _, _)) = paragraph.as_mut()
                        {
                            *style = Some(
                                String::from_utf8_lossy(attribute.value.as_ref()).into_owned(),
                            );
                        }
                    }
                }
            }
            Ok(Event::Text(event)) => {
                if in_text
                    && let Ok(raw) = std::str::from_utf8(&event)
                    && let Ok(value) = quick_xml::escape::unescape(raw)
                    && let Some((_, text, _)) = paragraph.as_mut()
                {
                    text.push_str(&value);
                }
            }
            Ok(Event::End(event)) => {
                let name = event.name();
                if name.as_ref() == b"w:t" {
                    in_text = false;
                } else if name.as_ref() == b"w:p" {
                    flush_paragraph(&mut paragraph, &mut html);
                }
            }
            _ => {}
        }
        buffer.clear();
        if html.chars().count() >= max_chars {
            truncated = true;
            break;
        }
    }
    flush_paragraph(&mut paragraph, &mut html);
    (html, truncated)
}
