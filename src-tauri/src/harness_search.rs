//! In-memory literal/token search over approved project documents.
//!
//! `search_allowed_context` operates only on the current delivery, the
//! effective Agent rule, direct dependency Markdown, and current-project
//! attachment extractions. It has no embeddings, no durable index, and no disk
//! writes; every search is a plain in-memory scan of the frozen turn's index.

// The tool registry gains its callers in Tasks 7 and 8.
#![allow(dead_code)]

/// One searchable document. `label` is a safe public label (never a path).
#[derive(Debug, Clone)]
pub(crate) struct SearchDocument {
    pub(crate) label: String,
    pub(crate) text: String,
}

/// A bounded search result with a short excerpt around the first match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SearchHit {
    pub(crate) label: String,
    pub(crate) excerpt: String,
}

/// The per-turn in-memory search index built once from approved documents.
#[derive(Debug, Clone)]
pub(crate) struct HarnessSearchIndex {
    documents: Vec<SearchDocument>,
}

impl HarnessSearchIndex {
    pub(crate) fn new(documents: Vec<SearchDocument>) -> Self {
        Self { documents }
    }

    /// Literal/token search: every whitespace-separated query token must appear
    /// (case-insensitive) in the document. Returns at most `max_results` hits
    /// with excerpts of at most `max_excerpt_chars`.
    pub(crate) fn search(
        &self,
        query: &str,
        max_results: usize,
        max_excerpt_chars: usize,
    ) -> Vec<SearchHit> {
        let tokens = tokenize(query);
        if tokens.is_empty() {
            return Vec::new();
        }
        let mut hits = Vec::new();
        for document in &self.documents {
            let lower = document.text.to_lowercase();
            if !tokens.iter().all(|token| lower.contains(token)) {
                continue;
            }
            let Some(excerpt) = excerpt_around(&document.text, &lower, &tokens[0], max_excerpt_chars)
            else {
                continue;
            };
            hits.push(SearchHit {
                label: document.label.clone(),
                excerpt,
            });
            if hits.len() >= max_results {
                break;
            }
        }
        hits
    }
}

fn tokenize(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|token| token.to_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

/// Returns a bounded excerpt from `text` centered on the first occurrence of
/// `first_token` in the lowercased `lower` copy. The excerpt is taken from the
/// original text so casing is preserved; it never exceeds `max_chars` characters.
fn excerpt_around(
    text: &str,
    lower: &str,
    first_token: &str,
    max_chars: usize,
) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let byte_pos = lower.find(first_token)?;
    let char_pos = lower[..byte_pos].chars().count();
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return None;
    }
    let half = max_chars.saturating_div(2);
    let start = char_pos.saturating_sub(half);
    let end = (start + max_chars).min(chars.len());
    let start = if end == chars.len() {
        chars.len().saturating_sub(max_chars)
    } else {
        start
    };
    let mut excerpt: String = chars[start..end].iter().collect();
    if start > 0 {
        excerpt.insert(0, '…');
    }
    if end < chars.len() {
        excerpt.push('…');
    }
    Some(excerpt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> HarnessSearchIndex {
        HarnessSearchIndex::new(vec![
            SearchDocument {
                label: "当前交付稿".into(),
                text: "项目边界：仅本地桌面应用，不包含浏览器自动化。".into(),
            },
            SearchDocument {
                label: "有效规则".into(),
                text: "只读依赖节点，非 confirmed 状态只作参考。".into(),
            },
            SearchDocument {
                label: "附件：brief.md".into(),
                text: "客户要求支持多语言（Chinese 和 English）。".into(),
            },
        ])
    }

    #[test]
    fn search_finds_documents_matching_every_token() {
        let hits = index().search("本地 桌面", 8, 80);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].label, "当前交付稿");
        assert!(hits[0].excerpt.contains("本地桌面应用"));
    }

    #[test]
    fn empty_or_whitespace_query_returns_no_hits() {
        assert!(index().search("   ", 8, 80).is_empty());
        assert!(index().search("", 8, 80).is_empty());
    }

    #[test]
    fn search_is_case_insensitive_and_bounded() {
        let hits = index().search("ENGLISH", 8, 40);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].label, "附件：brief.md");
        assert!(hits[0].excerpt.chars().count() <= 40 + 2);
    }

    #[test]
    fn search_never_matches_partial_tokens() {
        // "本" alone must not match "本地" because token matching is per-token.
        let hits = index().search("多语言 参考", 8, 80);
        assert!(hits.is_empty());
    }

    #[test]
    fn excerpt_is_bounded_and_marks_truncation() {
        let text = "甲".repeat(200);
        let index = HarnessSearchIndex::new(vec![SearchDocument {
            label: "长文".into(),
            text,
        }]);
        let hits = index.search("甲", 8, 50);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].excerpt.chars().count() <= 52);
        assert!(hits[0].excerpt.ends_with('…'));
    }
}
