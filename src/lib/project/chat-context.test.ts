import { describe, expect, it } from "vitest";
import {
  buildDependencyContextMarkdown,
  collectBudgetedConversation,
  collectBudgetedFileSections,
  MAX_CONTEXT_MARKDOWN_CHARS,
  MAX_FILE_CONTEXT_CHARS,
  MAX_HISTORY_CHARS,
  truncateForPrompt,
} from "./chat-context";
import type { ProjectNode } from "./types";

function node(id: ProjectNode["id"], markdown: string): ProjectNode {
  return {
    id,
    status: "generated",
    markdown,
    revision: 1,
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

describe("buildDependencyContextMarkdown", () => {
  it("includes only dependsOn nodes, not every other node", () => {
    const nodes = [
      node("basic-info", "# Basic"),
      node("goals", "# Goals"),
      node("roles-permissions", "# Roles"),
      node("feature-design", "# Features"),
    ];
    const md = buildDependencyContextMarkdown("feature-design", nodes);
    expect(md).toContain("# Basic");
    expect(md).toContain("# Goals");
    expect(md).toContain("# Roles");
    // business-flow is a dependency of feature-design but absent from nodes list -> skip
    expect(md).not.toContain("# Features");
  });

  it("returns empty string when node has no dependencies", () => {
    expect(buildDependencyContextMarkdown("basic-info", [node("basic-info", "# X")])).toBe("");
  });

  it("truncates each dependency section and the total payload", () => {
    const huge = "字".repeat(MAX_CONTEXT_MARKDOWN_CHARS);
    const nodes = [
      node("basic-info", huge),
      node("goals", huge),
      node("feature-design", "# F"),
    ];
    const md = buildDependencyContextMarkdown("feature-design", nodes);
    expect(md.length).toBeLessThanOrEqual(MAX_CONTEXT_MARKDOWN_CHARS);
    expect(md).toMatch(/已截断|truncated/i);
  });
});

describe("collectBudgetedFileSections", () => {
  it("stops adding files once the character budget is exhausted", () => {
    const sections = collectBudgetedFileSections([
      { name: "a.txt", content: "a".repeat(MAX_FILE_CONTEXT_CHARS - 10) },
      { name: "b.txt", content: "b".repeat(1000) },
    ]);
    expect(sections.length).toBe(1);
    expect(sections[0]).toContain("a.txt");
  });

  it("includes a truncation note when content is cut", () => {
    const sections = collectBudgetedFileSections([
      { name: "big.txt", content: "x".repeat(MAX_FILE_CONTEXT_CHARS + 500) },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].length).toBeLessThanOrEqual(MAX_FILE_CONTEXT_CHARS);
    expect(sections[0]).toMatch(/截断|truncated/i);
  });
});

describe("prompt text budgets", () => {
  it("never exceeds a budget after adding its truncation marker", () => {
    expect(truncateForPrompt("x".repeat(100), 12)).toHaveLength(12);
  });

  it("keeps the newest conversation entries in chronological order", () => {
    const messages = collectBudgetedConversation(
      [
        { content: "old".repeat(MAX_HISTORY_CHARS) },
        { content: "newest" },
      ],
      MAX_HISTORY_CHARS,
    );
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)?.content).toBe("newest");
    expect(messages.reduce((total, message) => total + message.content.length, 0))
      .toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    // The older entry is clipped; the newest entry must never be dropped.
    expect(messages[0].content).toMatch(/截断/);
  });
});
