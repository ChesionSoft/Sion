import type { ProjectNode } from "./types";

/**
 * Extract bullet items from a `## <headingText>` section in markdown.
 * Returns the text after the leading `- ` for each bullet, stopping at
 * the next same-or-higher-level heading. Placeholder bullets "暂无" and
 * "暂无。" are filtered out. Returns empty array if section is missing.
 */
export function extractSectionBullets(markdown: string, headingText: string): string[] {
  const lines = markdown.split("\n");
  const targetHeading = `## ${headingText}`;
  let inSection = false;
  const results: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (inSection) {
        // We've hit the next heading at same or higher level — stop
        break;
      }
      if (line === targetHeading) {
        inSection = true;
      }
      continue;
    }

    if (!inSection) continue;

    if (line.startsWith("- ")) {
      const bullet = line.slice(2).trim();
      if (bullet === "暂无" || bullet === "暂无。") continue;
      results.push(bullet);
    }
  }

  return results;
}

/**
 * Merge legacy `assumptions` and `openQuestions` arrays into the markdown.
 * Appends entries as bullets into the corresponding "设计假设" / "待确认问题"
 * sections, creating the section if missing. Deduplicates against existing
 * bullets. Returns the markdown unchanged if both arrays are empty/undefined.
 */
export function mergeLegacyNodeListsIntoMarkdown(
  markdown: string,
  assumptions?: string[],
  openQuestions?: string[],
): string {
  let result = markdown;

  if (assumptions && assumptions.length > 0) {
    result = mergeListIntoSection(result, "设计假设", assumptions);
  }

  if (openQuestions && openQuestions.length > 0) {
    result = mergeListIntoSection(result, "待确认问题", openQuestions);
  }

  return result;
}

function mergeListIntoSection(markdown: string, headingText: string, items: string[]): string {
  const existing = extractSectionBullets(markdown, headingText);
  const existingSet = new Set(existing);
  const newItems = items.filter((item) => !existingSet.has(item));

  if (newItems.length === 0) return markdown;

  const lines = markdown.split("\n");
  const targetHeading = `## ${headingText}`;
  const headingIndex = lines.findIndex((line) => line === targetHeading);

  if (headingIndex === -1) {
    // Section doesn't exist — append it at the end
    const sectionLines = ["", targetHeading, "", ...newItems.map((item) => `- ${item}`), ""];
    return [...lines, ...sectionLines].join("\n");
  }

  // Find the end of the section (next heading at same or higher level, or end of file)
  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith("#")) {
      sectionEnd = i;
      break;
    }
  }

  // Insert new items before sectionEnd
  const before = lines.slice(0, sectionEnd);
  const after = lines.slice(sectionEnd);
  const insertLines = newItems.map((item) => `- ${item}`);

  return [...before, ...insertLines, ...after].join("\n");
}

/**
 * Collect all unique assumptions from all nodes by extracting from
 * the "设计假设" section of each node's markdown.
 */
export function collectNodeAssumptions(nodes: ProjectNode[]): string[] {
  const all = nodes.flatMap((node) => extractSectionBullets(node.markdown, "设计假设"));
  return [...new Set(all)];
}

/**
 * Collect all unique open questions from all nodes by extracting from
 * the "待确认问题" section of each node's markdown.
 */
export function collectNodeOpenQuestions(nodes: ProjectNode[]): string[] {
  const all = nodes.flatMap((node) => extractSectionBullets(node.markdown, "待确认问题"));
  return [...new Set(all)];
}
