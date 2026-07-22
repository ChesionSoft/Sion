//! Export content contracts: the blueprint vocabulary, formal draft
//! validation, structured patch operations, the fenced `delivery` envelope, and
//! the non-chat review task model.
//!
//! Blueprint and draft Markdown are validated here before any artifact is
//! written. Patch operations are deterministic and revalidated after
//! application so a review proposal can never bypass validation. The delivery
//! envelope reuses the crate's shared fence extractor but enforces the stricter
//! export rule that no prose may appear outside the single delivery block.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{ChatModelSelection, DeliveryError, WorkflowNodeId, extract_delivery_block};

use super::{ExportArtifactKind, ExportReviewStatus};

/// Whether a blueprint section is included in the formal draft and how.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportInclusion {
    Confirmed,
    ConfirmedSummary,
    Omit,
    RequiredDisclosure,
}

/// How a blueprint section should be presented in the formal draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportPresentation {
    Paragraphs,
    Bullets,
    Table,
    Flow,
    Appendix,
}

/// One section of an export blueprint. The H2 title is the section's display
/// name; the six metadata lines (`id`, `inclusion`, `presentation`, `source`,
/// `headings`, `rationale`) describe how the source node feeds the draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBlueprintSection {
    pub title: String,
    pub id: String,
    pub inclusion: ExportInclusion,
    pub presentation: ExportPresentation,
    pub source: WorkflowNodeId,
    pub headings: String,
    pub rationale: String,
}

/// The export blueprint: one H1 title and one or more H2 sections. Blueprint is
/// preparation material, not a delivery artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBlueprint {
    pub title: String,
    pub sections: Vec<ExportBlueprintSection>,
}

/// Maps a formal draft heading back to the source workflow node and heading it
/// was generated from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSourceMapEntry {
    pub heading: String,
    pub node_id: WorkflowNodeId,
    pub source_heading: String,
}

/// Validated formal draft content persisted as `formal-prd-draft.md`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDraft {
    pub markdown: String,
    pub source_map: Vec<ExportSourceMapEntry>,
}

/// Structured blueprint patch operation, addressed by section id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BlueprintPatchOp {
    Update {
        #[serde(rename = "sectionId")]
        section_id: String,
        section: ExportBlueprintSection,
    },
    Insert {
        #[serde(rename = "afterSectionId")]
        after_section_id: Option<String>,
        section: ExportBlueprintSection,
    },
    Delete {
        #[serde(rename = "sectionId")]
        section_id: String,
    },
    Reorder {
        #[serde(rename = "orderedSectionIds")]
        ordered_section_ids: Vec<String>,
    },
}

/// Structured formal draft patch operation, addressed by unique H2 heading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum DraftPatchOp {
    Replace {
        heading: String,
        markdown: String,
    },
    Insert {
        #[serde(rename = "afterHeading")]
        after_heading: Option<String>,
        heading: String,
        markdown: String,
    },
    Delete {
        heading: String,
    },
    Reorder {
        #[serde(rename = "orderedHeadings")]
        ordered_headings: Vec<String>,
    },
}

/// Per-operation outcome of applying a patch: applied or skipped with a reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPatchResult {
    pub applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The single fenced `delivery` JSON envelope an export agent returns. Each
/// variant maps to one stage: blueprint generation, draft generation, or a
/// review patch proposal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportDelivery {
    ExportBlueprint {
        blueprint: ExportBlueprint,
    },
    ExportDraft {
        markdown: String,
        #[serde(rename = "sourceMap")]
        source_map: Vec<ExportSourceMapEntry>,
    },
    BlueprintPatch {
        #[serde(rename = "artifactDigest")]
        artifact_digest: String,
        ops: Vec<BlueprintPatchOp>,
    },
    DraftPatch {
        #[serde(rename = "artifactDigest")]
        artifact_digest: String,
        ops: Vec<DraftPatchOp>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ExportContentError {
    #[error("invalid blueprint: {0}")]
    InvalidBlueprint(String),
    #[error("invalid draft: {0}")]
    InvalidDraft(String),
    #[error("delivery block is missing")]
    MissingDeliveryBlock,
    #[error("delivery block appears more than once")]
    MultipleDeliveryBlocks,
    #[error("delivery block is not terminated")]
    UnterminatedDeliveryBlock,
    #[error("delivery block has content outside the fence")]
    TrailingDeliveryContent,
    #[error("delivery JSON is invalid: {0}")]
    InvalidDeliveryJson(String),
    #[error("patch is invalid: {0}")]
    InvalidPatch(String),
}

/// A single structured change proposed by a review task, with before/after
/// previews for the diff UI and the op to apply on confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportProposedOp {
    Blueprint(BlueprintPatchOp),
    Draft(DraftPatchOp),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProposedChange {
    pub id: String,
    pub target_kind: ExportArtifactKind,
    pub op: ExportProposedOp,
    pub before: String,
    pub after: String,
}

/// Recorded outcome of applying one proposed change during a review task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPatchApplication {
    pub change_id: String,
    pub applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A non-chat review task. The user supplies one focused instruction; the agent
/// returns structured patch ops, which the user selects and applies through an
/// explicit diff. There is no session, message list, or continuous reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReviewTask {
    pub id: String,
    pub target_kind: ExportArtifactKind,
    pub instruction: String,
    pub base_revision: u64,
    pub base_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ChatModelSelection>,
    pub status: ExportReviewStatus,
    #[serde(default)]
    pub proposed_changes: Vec<ExportProposedChange>,
    #[serde(default)]
    pub applied_results: Vec<ExportPatchApplication>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
}

fn inclusion_str(inclusion: ExportInclusion) -> &'static str {
    match inclusion {
        ExportInclusion::Confirmed => "confirmed",
        ExportInclusion::ConfirmedSummary => "confirmed-summary",
        ExportInclusion::Omit => "omit",
        ExportInclusion::RequiredDisclosure => "required-disclosure",
    }
}

fn parse_inclusion(value: &str) -> Result<ExportInclusion, ExportContentError> {
    match value {
        "confirmed" => Ok(ExportInclusion::Confirmed),
        "confirmed-summary" => Ok(ExportInclusion::ConfirmedSummary),
        "omit" => Ok(ExportInclusion::Omit),
        "required-disclosure" => Ok(ExportInclusion::RequiredDisclosure),
        _ => Err(ExportContentError::InvalidBlueprint(format!(
            "unknown inclusion: {value}"
        ))),
    }
}

fn presentation_str(presentation: ExportPresentation) -> &'static str {
    match presentation {
        ExportPresentation::Paragraphs => "paragraphs",
        ExportPresentation::Bullets => "bullets",
        ExportPresentation::Table => "table",
        ExportPresentation::Flow => "flow",
        ExportPresentation::Appendix => "appendix",
    }
}

fn parse_presentation(value: &str) -> Result<ExportPresentation, ExportContentError> {
    match value {
        "paragraphs" => Ok(ExportPresentation::Paragraphs),
        "bullets" => Ok(ExportPresentation::Bullets),
        "table" => Ok(ExportPresentation::Table),
        "flow" => Ok(ExportPresentation::Flow),
        "appendix" => Ok(ExportPresentation::Appendix),
        _ => Err(ExportContentError::InvalidBlueprint(format!(
            "unknown presentation: {value}"
        ))),
    }
}

/// Serializes a blueprint to its deterministic Markdown form: one H1, then one
/// H2 section with exactly six metadata lines each.
pub fn serialize_blueprint(blueprint: &ExportBlueprint) -> String {
    let mut out = format!("# {}\n", blueprint.title);
    for section in &blueprint.sections {
        out.push_str(&format!(
            "\n## {}\n\n- id: {}\n- inclusion: {}\n- presentation: {}\n- source: {}\n- headings: {}\n- rationale: {}\n",
            section.title,
            section.id,
            inclusion_str(section.inclusion),
            presentation_str(section.presentation),
            section.source.as_str(),
            section.headings,
            section.rationale,
        ));
    }
    out
}

/// Parses blueprint Markdown back into the structured blueprint. Rejects
/// unknown source nodes, duplicate section ids, missing or misordered metadata,
/// and any structural deviation as `InvalidBlueprint`.
pub fn parse_blueprint(markdown: &str) -> Result<ExportBlueprint, ExportContentError> {
    let mut lines = markdown.lines().peekable();
    let title = loop {
        let line = lines.next().ok_or_else(|| {
            ExportContentError::InvalidBlueprint("blueprint is missing an H1 title".into())
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let rest = trimmed.strip_prefix("# ").ok_or_else(|| {
            ExportContentError::InvalidBlueprint("blueprint must start with an H1 title".into())
        })?;
        break rest.trim().to_string();
    };

    let mut sections = Vec::new();
    let mut seen_ids = HashSet::new();
    let expected_keys = [
        "id",
        "inclusion",
        "presentation",
        "source",
        "headings",
        "rationale",
    ];
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let section_title = trimmed
            .strip_prefix("## ")
            .map(|rest| rest.trim().to_string())
            .ok_or_else(|| {
                ExportContentError::InvalidBlueprint(format!(
                    "expected an H2 section, found: {trimmed}"
                ))
            })?;
        let mut metadata: Vec<(String, String)> = Vec::new();
        while metadata.len() < expected_keys.len() {
            let Some(metadata_line) = lines.next() else {
                return Err(ExportContentError::InvalidBlueprint(
                    "blueprint section is missing metadata lines".into(),
                ));
            };
            let metadata_trimmed = metadata_line.trim();
            if metadata_trimmed.is_empty() {
                if metadata.is_empty() {
                    continue;
                }
                return Err(ExportContentError::InvalidBlueprint(
                    "unexpected blank line inside section metadata".into(),
                ));
            }
            let stripped = metadata_trimmed.strip_prefix("- ").ok_or_else(|| {
                ExportContentError::InvalidBlueprint(format!(
                    "expected a metadata line, found: {metadata_trimmed}"
                ))
            })?;
            // Accept both "- key: value" and "- key:" (empty after trim). Empty
            // values are rejected later with field-specific errors.
            let (key, value) = stripped.split_once(':').ok_or_else(|| {
                ExportContentError::InvalidBlueprint(format!(
                    "metadata line is missing a value: {metadata_trimmed}"
                ))
            })?;
            metadata.push((key.trim().to_string(), value.trim().to_string()));
        }
        for (index, (key, _)) in metadata.iter().enumerate() {
            if key != expected_keys[index] {
                return Err(ExportContentError::InvalidBlueprint(format!(
                    "metadata key at position {index} expected {}, found {key}",
                    expected_keys[index]
                )));
            }
        }
        let id = metadata[0].1.clone();
        if id.is_empty() {
            return Err(ExportContentError::InvalidBlueprint(
                "section id is empty".into(),
            ));
        }
        if !seen_ids.insert(id.clone()) {
            return Err(ExportContentError::InvalidBlueprint(format!(
                "duplicate section id: {id}"
            )));
        }
        let inclusion = parse_inclusion(&metadata[1].1)?;
        let presentation = parse_presentation(&metadata[2].1)?;
        let source = WorkflowNodeId::try_from(metadata[3].1.as_str()).map_err(|_| {
            ExportContentError::InvalidBlueprint(format!("unknown source node: {}", metadata[3].1))
        })?;
        let headings = metadata[4].1.clone();
        let rationale = metadata[5].1.clone();
        if headings.is_empty() || rationale.is_empty() {
            return Err(ExportContentError::InvalidBlueprint(
                "section headings and rationale are required".into(),
            ));
        }
        sections.push(ExportBlueprintSection {
            title: section_title,
            id,
            inclusion,
            presentation,
            source,
            headings,
            rationale,
        });
    }
    if sections.is_empty() {
        return Err(ExportContentError::InvalidBlueprint(
            "blueprint has no sections".into(),
        ));
    }
    Ok(ExportBlueprint { title, sections })
}

/// Chinese unfinished-stub phrases. Prefer explicit markers over bare
/// 「待确认」so headings like「待确认问题」from source nodes are allowed.
const DRAFT_PHRASE_PLACEHOLDERS: [&str; 6] = [
    "待确认：",
    "待补充：",
    "后续补充",
    "agent 建议",
    "agent 分析",
    "历史结论",
];

fn strip_list_prefix(line: &str) -> &str {
    let mut body = line.trim();
    for _ in 0..3 {
        if let Some(rest) = body
            .strip_prefix("- ")
            .or_else(|| body.strip_prefix("* "))
            .or_else(|| body.strip_prefix("> "))
        {
            body = rest.trim_start();
            continue;
        }
        // ordered list: "1. " / "12) "
        let bytes = body.as_bytes();
        let mut i = 0;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i > 0 {
            if body[i..].starts_with(". ") {
                body = body[i + 2..].trim_start();
                continue;
            }
            if body[i..].starts_with(") ") {
                body = body[i + 2..].trim_start();
                continue;
            }
        }
        break;
    }
    body
}

/// Detect unfinished draft stubs without false-positiving product copy such as
/// `/todos` routes or feature names. ASCII `todo`/`tbd` only count as stubs when
/// they are clearly unfinished markers (whole line, `TODO:`, `[TODO]`, …).
fn find_draft_placeholder(markdown: &str) -> Option<(String, String)> {
    let lower = markdown.to_lowercase();

    for phrase in DRAFT_PHRASE_PLACEHOLDERS {
        if let Some(idx) = lower.find(phrase) {
            return Some((
                phrase.to_string(),
                context_snippet(markdown, idx, phrase.len()),
            ));
        }
    }

    // Bracket / bold forms anywhere: [todo], 【todo】, **todo**, *todo*
    for (label, patterns) in [
        (
            "todo",
            [
                "[todo]",
                "【todo】",
                "**todo**",
                "*todo*",
                "`todo`",
                "todo:",
                "todo：",
            ]
            .as_slice(),
        ),
        (
            "tbd",
            [
                "[tbd]",
                "【tbd】",
                "**tbd**",
                "*tbd*",
                "`tbd`",
                "tbd:",
                "tbd：",
            ]
            .as_slice(),
        ),
    ] {
        for pattern in patterns {
            if let Some(idx) = lower.find(pattern) {
                return Some((
                    label.to_string(),
                    context_snippet(markdown, idx, pattern.len()),
                ));
            }
        }
    }

    // Whole-line stubs: "TODO", "TBD.", "- TODO", "1. TBD"
    for (line_idx, line) in lower.lines().enumerate() {
        let body = strip_list_prefix(line);
        let body = body.trim_end_matches(|c: char| matches!(c, '.' | '。' | '!' | '！'));
        if body == "todo" || body == "tbd" {
            let original = markdown.lines().nth(line_idx).unwrap_or(line);
            return Some((body.to_string(), original.trim().to_string()));
        }
    }

    None
}

fn context_snippet(source: &str, idx: usize, len: usize) -> String {
    let start = source
        .char_indices()
        .rev()
        .find(|(i, _)| *i <= idx.saturating_sub(24))
        .map(|(i, _)| i)
        .unwrap_or(0);
    let end = source
        .char_indices()
        .find(|(i, _)| *i >= idx + len + 24)
        .map(|(i, _)| i)
        .unwrap_or(source.len());
    source[start..end].replace('\n', " ").trim().to_string()
}

fn heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let hashes = trimmed
        .chars()
        .take_while(|&character| character == '#')
        .count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &trimmed[hashes..];
    let text = rest.strip_prefix(' ')?;
    if text.trim().is_empty() {
        return None;
    }
    Some(hashes)
}

fn heading_title(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let hashes = trimmed
        .chars()
        .take_while(|&character| character == '#')
        .count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = trimmed.get(hashes..)?;
    let text = rest.strip_prefix(' ')?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

fn empty_section_error(title: Option<&str>) -> ExportContentError {
    match title {
        Some(title) if !title.is_empty() => ExportContentError::InvalidDraft(format!(
            "draft has an empty section body under ## {title}"
        )),
        _ => ExportContentError::InvalidDraft("draft has an empty section body".into()),
    }
}

/// Validates formal draft Markdown: exactly one H1, at least one H2, a
/// non-empty body under every H2, no heading-level skips among H1-H3, and no
/// placeholder text. Returns the trimmed Markdown on success.
///
/// H3–H6 under an H2 count as body content. A structure like
/// `## 功能\n### 模块 A\n正文` is valid; only a bare H2 with no following
/// prose or subsections is rejected.
pub fn validate_draft(markdown: &str) -> Result<String, ExportContentError> {
    let trimmed = markdown.trim().to_string();
    if trimmed.is_empty() {
        return Err(ExportContentError::InvalidDraft("draft is empty".into()));
    }
    if let Some((needle, snippet)) = find_draft_placeholder(&trimmed) {
        return Err(ExportContentError::InvalidDraft(format!(
            "draft contains placeholder {needle:?} near: {snippet}"
        )));
    }
    let mut h1_count = 0usize;
    let mut h2_count = 0usize;
    let mut previous_level = 0usize;
    let mut current_body = String::new();
    let mut section_open = false;
    let mut current_h2_title: Option<String> = None;
    let mut in_fence = false;
    for line in trimmed.lines() {
        let line_trimmed = line.trim_start();
        if line_trimmed.starts_with("```") || line_trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            if section_open {
                current_body.push_str(line);
                current_body.push('\n');
            }
            continue;
        }
        if !in_fence && let Some(level) = heading_level(line) {
            if level <= 3 && level > previous_level + 1 {
                return Err(ExportContentError::InvalidDraft(
                    "draft heading level skips a level".into(),
                ));
            }
            if level <= 2 {
                // Only H1/H2 close an H2 section. H3+ belong to the open H2 body.
                if section_open && current_body.trim().is_empty() {
                    return Err(empty_section_error(current_h2_title.as_deref()));
                }
                current_body.clear();
                section_open = false;
                current_h2_title = None;
                if level == 1 {
                    h1_count += 1;
                } else {
                    h2_count += 1;
                    section_open = true;
                    current_h2_title = heading_title(line);
                }
                previous_level = level;
                continue;
            }
            // H3–H6: keep the H2 open and count the heading as body structure.
            if section_open {
                current_body.push_str(line);
                current_body.push('\n');
            }
            previous_level = level;
            continue;
        }
        if section_open {
            current_body.push_str(line);
            current_body.push('\n');
        }
    }
    if section_open && current_body.trim().is_empty() {
        return Err(empty_section_error(current_h2_title.as_deref()));
    }
    if h1_count != 1 {
        return Err(ExportContentError::InvalidDraft(format!(
            "draft must have exactly one H1, found {h1_count}"
        )));
    }
    if h2_count == 0 {
        return Err(ExportContentError::InvalidDraft(
            "draft has no H2 section".into(),
        ));
    }
    Ok(trimmed)
}

/// Applies blueprint patch operations, returning the new blueprint and one
/// applied-or-skipped result per operation. The full blueprint is revalidated
/// before it is returned.
pub fn apply_blueprint_patch(
    blueprint: &ExportBlueprint,
    ops: &[BlueprintPatchOp],
) -> Result<(ExportBlueprint, Vec<ExportPatchResult>), ExportContentError> {
    let mut current = blueprint.clone();
    let mut results = Vec::with_capacity(ops.len());
    for op in ops {
        let mut result = ExportPatchResult {
            applied: false,
            reason: None,
        };
        match op {
            BlueprintPatchOp::Update {
                section_id,
                section,
            } => {
                if let Some(position) = current
                    .sections
                    .iter()
                    .position(|existing| existing.id == *section_id)
                {
                    current.sections[position] = section.clone();
                    result.applied = true;
                } else {
                    result.reason = Some(format!("section {section_id} not found"));
                }
            }
            BlueprintPatchOp::Insert {
                after_section_id,
                section,
            } => {
                if current
                    .sections
                    .iter()
                    .any(|existing| existing.id == section.id)
                {
                    result.reason = Some(format!("section {} already exists", section.id));
                } else {
                    let position = match after_section_id {
                        Some(after) => current
                            .sections
                            .iter()
                            .position(|existing| existing.id == *after)
                            .map(|position| position + 1),
                        None => Some(current.sections.len()),
                    };
                    match position {
                        Some(position) => {
                            current.sections.insert(position, section.clone());
                            result.applied = true;
                        }
                        None => result.reason = Some("anchor section not found".into()),
                    }
                }
            }
            BlueprintPatchOp::Delete { section_id } => {
                if let Some(position) = current
                    .sections
                    .iter()
                    .position(|existing| existing.id == *section_id)
                {
                    current.sections.remove(position);
                    result.applied = true;
                } else {
                    result.reason = Some(format!("section {section_id} not found"));
                }
            }
            BlueprintPatchOp::Reorder {
                ordered_section_ids,
            } => {
                let existing: Vec<String> = current
                    .sections
                    .iter()
                    .map(|section| section.id.clone())
                    .collect();
                if ordered_section_ids.len() == existing.len()
                    && ordered_section_ids.iter().all(|id| existing.contains(id))
                {
                    current.sections.sort_by_key(|section| {
                        ordered_section_ids
                            .iter()
                            .position(|id| id == &section.id)
                            .unwrap_or(usize::MAX)
                    });
                    result.applied = true;
                } else {
                    result.reason = Some("reorder list does not match current sections".into());
                }
            }
        }
        results.push(result);
    }
    let revalidated = serialize_blueprint(&current);
    parse_blueprint(&revalidated)?;
    Ok((current, results))
}

fn draft_h1_title(markdown: &str) -> String {
    for line in markdown.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("# ") {
            return rest.trim().to_string();
        }
    }
    String::new()
}

fn split_draft_sections(markdown: &str) -> Vec<(String, String)> {
    let mut sections = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in markdown.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("## ") {
            if let Some(section) = current.take() {
                sections.push((section.0, section.1.trim().to_string()));
            }
            current = Some((rest.trim().to_string(), String::new()));
        } else if let Some(section) = current.as_mut() {
            section.1.push_str(line);
            section.1.push('\n');
        }
    }
    if let Some(section) = current.take() {
        sections.push((section.0, section.1.trim().to_string()));
    }
    sections
}

/// Applies formal draft patch operations, returning the new Markdown and one
/// applied-or-skipped result per operation. The result is revalidated.
pub fn apply_draft_patch(
    draft_markdown: &str,
    ops: &[DraftPatchOp],
) -> Result<(String, Vec<ExportPatchResult>), ExportContentError> {
    let mut sections = split_draft_sections(draft_markdown);
    let mut results = Vec::with_capacity(ops.len());
    for op in ops {
        let mut result = ExportPatchResult {
            applied: false,
            reason: None,
        };
        match op {
            DraftPatchOp::Replace { heading, markdown } => {
                if let Some(section) = sections
                    .iter_mut()
                    .find(|(existing, _)| existing == heading)
                {
                    section.1 = markdown.clone();
                    result.applied = true;
                } else {
                    result.reason = Some(format!("heading {heading} not found"));
                }
            }
            DraftPatchOp::Insert {
                after_heading,
                heading,
                markdown,
            } => {
                if sections.iter().any(|(existing, _)| existing == heading) {
                    result.reason = Some(format!("heading {heading} already exists"));
                } else {
                    let position = match after_heading {
                        Some(after) => sections
                            .iter()
                            .position(|(existing, _)| existing == after)
                            .map(|position| position + 1),
                        None => Some(sections.len()),
                    };
                    match position {
                        Some(position) => {
                            sections.insert(position, (heading.clone(), markdown.clone()));
                            result.applied = true;
                        }
                        None => result.reason = Some("anchor heading not found".into()),
                    }
                }
            }
            DraftPatchOp::Delete { heading } => {
                if let Some(position) = sections
                    .iter()
                    .position(|(existing, _)| existing == heading)
                {
                    sections.remove(position);
                    result.applied = true;
                } else {
                    result.reason = Some(format!("heading {heading} not found"));
                }
            }
            DraftPatchOp::Reorder { ordered_headings } => {
                let existing: Vec<String> = sections
                    .iter()
                    .map(|(heading, _)| heading.clone())
                    .collect();
                if ordered_headings.len() == existing.len()
                    && ordered_headings
                        .iter()
                        .all(|heading| existing.contains(heading))
                {
                    sections.sort_by_key(|(heading, _)| {
                        ordered_headings
                            .iter()
                            .position(|ordered| ordered == heading)
                            .unwrap_or(usize::MAX)
                    });
                    result.applied = true;
                } else {
                    result.reason = Some("reorder list does not match current headings".into());
                }
            }
        }
        results.push(result);
    }
    let mut output = format!("# {}\n", draft_h1_title(draft_markdown));
    for (heading, body) in &sections {
        output.push_str(&format!("\n## {heading}\n\n{body}\n"));
    }
    let new_markdown = output.trim().to_string();
    validate_draft(&new_markdown)?;
    Ok((new_markdown, results))
}

/// Parses the single fenced `delivery` JSON envelope an export agent returns.
/// Requires exactly one delivery block and no non-whitespace outside it.
pub fn parse_export_delivery(raw: &str) -> Result<ExportDelivery, ExportContentError> {
    let block = extract_delivery_block(raw).map_err(|error| match error {
        DeliveryError::MissingBlock => ExportContentError::MissingDeliveryBlock,
        DeliveryError::MultipleBlocks => ExportContentError::MultipleDeliveryBlocks,
        DeliveryError::UnterminatedBlock => ExportContentError::UnterminatedDeliveryBlock,
        _ => ExportContentError::InvalidDeliveryJson(error.to_string()),
    })?;
    if !raw[..block.visible_end].trim().is_empty() || !raw[block.block_end..].trim().is_empty() {
        return Err(ExportContentError::TrailingDeliveryContent);
    }
    serde_json::from_str(block.body.trim())
        .map_err(|error| ExportContentError::InvalidDeliveryJson(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blueprint_round_trips_and_rejects_unmapped_included_sections() {
        let blueprint = fixture_blueprint();
        let markdown = serialize_blueprint(&blueprint);
        assert_eq!(parse_blueprint(&markdown).unwrap(), blueprint);

        let invalid = markdown.replace("- source: basic-info", "- source: -");
        assert!(matches!(
            parse_blueprint(&invalid),
            Err(ExportContentError::InvalidBlueprint(_))
        ));
    }

    #[test]
    fn draft_rejects_placeholders_and_requires_a_body_below_every_h2() {
        assert!(validate_draft("# PRD\n\n## 目标\n\n可度量目标").is_ok());
        assert!(validate_draft("# PRD\n\n## 目标\n\nTBD").is_err());
        assert!(validate_draft("# PRD\n\n## 目标\n\nTODO: 待写").is_err());
        assert!(validate_draft("# PRD\n\n## 目标\n\n- TODO").is_err());
        assert!(validate_draft("# PRD\n\n## 目标\n\n[TODO] 后续补充细节").is_err());
        assert!(validate_draft("# PRD\n\n## 空章节\n\n## 下一章\n\n正文").is_err());
        // H2 with only nested H3+ content is a normal PRD shape and must pass.
        assert!(
            validate_draft(
                "# PRD\n\n## 功能模块\n\n### 模块 A\n\n职责说明\n\n### 模块 B\n\n输入输出"
            )
            .is_ok()
        );
        let empty_named = validate_draft("# PRD\n\n## 空章节\n\n## 下一章\n\n正文").unwrap_err();
        assert!(
            matches!(
                &empty_named,
                ExportContentError::InvalidDraft(message)
                    if message.contains("空章节")
            ),
            "unexpected error: {empty_named:?}"
        );
    }

    #[test]
    fn draft_allows_product_paths_and_domain_words_with_todo() {
        // Contract-check product copy uses /todos routes and 待办中心.
        // Only unfinished stubs should fail, not product vocabulary.
        assert!(
            validate_draft("# PRD\n\n## 待办中心\n\n集中视图路由为 `/todos`，展示待复核任务。")
                .is_ok()
        );
        assert!(validate_draft("# PRD\n\n## 功能\n\n系统提供 Todos 列表与归档能力。").is_ok());
        assert!(
            validate_draft(
                "# PRD\n\n## 待确认问题清单\n\n本节记录已确认的开放问题处理策略，不含未完成占位。"
            )
            .is_ok()
        );
        // Bare "TODO" mid-sentence is product-adjacent; only stub forms fail.
        assert!(validate_draft("# PRD\n\n## 功能\n\n用户可从 Todo 入口进入待办。").is_ok());
        assert!(validate_draft("# PRD\n\n## 功能\n\nTODO: 此处未写完").is_err());
    }

    #[test]
    fn delivery_parser_accepts_one_delivery_fence_and_rejects_prose() {
        let raw = "\u{60}\u{60}\u{60}delivery\n{\"kind\":\"export_draft\",\"markdown\":\"# PRD\\n\\n## 目标\\n\\n正文\",\"sourceMap\":[]}\n\u{60}\u{60}\u{60}";
        assert!(matches!(
            parse_export_delivery(raw).unwrap(),
            ExportDelivery::ExportDraft { .. }
        ));
        assert!(parse_export_delivery("解释").is_err());
    }

    #[test]
    fn blueprint_rejects_empty_headings_with_field_error() {
        let markdown = "\
# 标题

## 目标

- id: goal
- inclusion: confirmed
- presentation: paragraphs
- source: basic-info
- headings:
- rationale: 对外交付
";
        let err = parse_blueprint(markdown).unwrap_err();
        assert!(
            matches!(
                &err,
                ExportContentError::InvalidBlueprint(message)
                    if message.contains("headings and rationale are required")
            ),
            "unexpected error: {err:?}"
        );
    }

    fn fixture_blueprint() -> ExportBlueprint {
        ExportBlueprint {
            title: "示例导出蓝图".into(),
            sections: vec![ExportBlueprintSection {
                title: "目标".into(),
                id: "goal".into(),
                inclusion: ExportInclusion::Confirmed,
                presentation: ExportPresentation::Paragraphs,
                source: WorkflowNodeId::BasicInfo,
                headings: "建设目标".into(),
                rationale: "对外交付".into(),
            }],
        }
    }
}
