import { z } from "zod";

/**
 * Formal PRD export contracts.
 *
 * The formal PRD is a curated, reviewable delivery artifact derived from
 * project nodes. Node Markdown is the sole fact source; the formal draft must
 * never be a raw 11-node concatenation. Only `confirmed`,
 * `confirmed-summary`, and explicitly selected `required-disclosure` material
 * may appear in the final Word document. `omit` material, open questions,
 * agent recommendations, history, process checklists, and unresolved
 * placeholders are forbidden.
 */

export const inclusionSchema = z.enum([
  "confirmed",
  "confirmed-summary",
  "omit",
  "required-disclosure",
]);
export type FormalPrdInclusion = z.infer<typeof inclusionSchema>;

export const presentationSchema = z.enum([
  "paragraphs",
  "bullets",
  "table",
  "flow",
  "appendix",
]);
export type FormalPrdPresentation = z.infer<typeof presentationSchema>;

const workflowNodeIdSchema = z.enum([
  "basic-info",
  "goals",
  "roles-permissions",
  "business-flow",
  "feature-design",
  "page-interaction",
  "data-structure",
  "api-design",
  "architecture-deployment",
  "development-tasks",
  "risks-open-questions",
  "final-export",
]);

const blueprintSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  inclusion: inclusionSchema,
  presentation: presentationSchema,
  sourceNodeIds: z.array(workflowNodeIdSchema),
  sourceHeadings: z.array(z.string()),
  rationale: z.string(),
});

export type FormalPrdSection = z.infer<typeof blueprintSectionSchema>;

export const blueprintSchema = z
  .object({
    title: z.string().min(1),
    sections: z.array(blueprintSectionSchema).min(1),
  })
  .refine(
    (blueprint) =>
      blueprint.sections.every(
        (section) => section.inclusion === "omit" || section.sourceNodeIds.length > 0,
      ),
    { message: "non-omit section must map to at least one workflow node" },
  );

export type FormalPrdBlueprint = z.infer<typeof blueprintSchema>;

const sourceMapEntrySchema = z.object({
  sectionId: z.string().optional(),
  sourceNodeIds: z.array(workflowNodeIdSchema).min(1),
  headings: z.array(z.string()).optional(),
});

export type FormalPrdSourceMapEntry = z.infer<typeof sourceMapEntrySchema>;

export const draftSchema = z.object({
  markdown: z.string().min(1),
  sourceMap: z.array(sourceMapEntrySchema),
});

export type FormalPrdDraft = z.infer<typeof draftSchema>;

// ---------------------------------------------------------------------------
// Lint — forbidden process noise and unresolved placeholders.
// ---------------------------------------------------------------------------

const forbiddenPattern =
  /\b(?:TBD|TODO)\b|待确认|待补充|后续补充|agent\s*(?:建议|分析)|历史结论/iu;

export type FormalPrdLintIssue = {
  code: "forbidden_phrase";
  line: number;
  message: string;
};

export function lintFormalPrdMarkdown(markdown: string): FormalPrdLintIssue[] {
  return markdown.split("\n").flatMap((line, index) =>
    forbiddenPattern.test(line)
      ? [
          {
            code: "forbidden_phrase" as const,
            line: index + 1,
            message: "正式 PRD 不得包含过程性或未确认文案",
          },
        ]
      : [],
  );
}

// ---------------------------------------------------------------------------
// Validation entry points.
// ---------------------------------------------------------------------------

export function validateBlueprint(input: unknown): FormalPrdBlueprint {
  return blueprintSchema.parse(input);
}

export function validateDraft(input: unknown): FormalPrdDraft {
  const draft = draftSchema.parse(input);
  const issues = lintFormalPrdMarkdown(draft.markdown);
  if (issues.length > 0) {
    throw new Error(JSON.stringify(issues));
  }
  return draft;
}

// ---------------------------------------------------------------------------
// Deterministic serialization.
// ---------------------------------------------------------------------------

/**
 * Serialize a blueprint to stable Markdown. The `rationale` and source mapping
 * are retained as HTML comments so the stored file is self-describing, but a
 * rendered view shows only the title and section headings.
 */
export function serializeBlueprint(blueprint: FormalPrdBlueprint): string {
  const lines: string[] = [`# ${blueprint.title}`, ""];
  for (const section of blueprint.sections) {
    lines.push(`## ${section.title}`);
    const sourceRef =
      section.sourceNodeIds.length > 0
        ? section.sourceNodeIds.join(", ")
        : "-";
    const headings =
      section.sourceHeadings.length > 0 ? section.sourceHeadings.join(" / ") : "-";
    lines.push(
      `<!-- inclusion=${section.inclusion} presentation=${section.presentation} source=${sourceRef} headings=${headings} rationale=${section.rationale} -->`,
    );
    lines.push("");
  }
  return lines.join("\n");
}