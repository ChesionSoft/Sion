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
// Deterministic serialization + editable line-format parsing.
// ---------------------------------------------------------------------------

/** Collapse embedded newlines to spaces so each metadata field stays on one line. */
function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Serialize a blueprint to stable, human-editable Markdown. Every section
 * carries its metadata as visible `- key: value` lines so the stored file is
 * self-describing and round-trips through `parseBlueprint`. Empty source /
 * heading arrays serialize as a single `-` so the field is never blank.
 */
export function serializeBlueprint(blueprint: FormalPrdBlueprint): string {
  const lines: string[] = [`# ${blueprint.title}`, ""];
  for (const section of blueprint.sections) {
    lines.push(`## ${section.title}`);
    lines.push(`- id: ${section.id}`);
    lines.push(`- inclusion: ${section.inclusion}`);
    lines.push(`- presentation: ${section.presentation}`);
    lines.push(`- source: ${section.sourceNodeIds.join(", ") || "-"}`);
    lines.push(`- headings: ${section.sourceHeadings.map(singleLine).join(" / ") || "-"}`);
    lines.push(`- rationale: ${singleLine(section.rationale)}`, "");
  }
  return lines.join("\n");
}

const BLUEPRINT_META_KEYS = ["id", "inclusion", "presentation", "source", "headings", "rationale"] as const;
type BlueprintMetaKey = (typeof BLUEPRINT_META_KEYS)[number];

/** Raw section fields extracted from Markdown; `validateBlueprint` narrows the enums. */
type RawBlueprintSection = {
  id: string;
  title: string;
  inclusion: string;
  presentation: string;
  sourceNodeIds: string[];
  sourceHeadings: string[];
  rationale: string;
};

const H1_PATTERN = /^#\s+(.+?)\s*$/;
const H2_PATTERN = /^##\s+(.+?)\s*$/;

function parseBlueprintSectionMeta(sectionTitle: string, lines: string[]): RawBlueprintSection {
  const meta: Partial<Record<BlueprintMetaKey, string>> = {};
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!line.startsWith("- ")) {
      throw new Error(`章节「${sectionTitle}」存在非元数据行：${line}`);
    }
    const rest = line.slice(2);
    const colonIdx = rest.indexOf(": ");
    if (colonIdx === -1) {
      throw new Error(`章节「${sectionTitle}」元数据行格式错误：${line}`);
    }
    const key = rest.slice(0, colonIdx);
    const value = rest.slice(colonIdx + 2);
    if (!BLUEPRINT_META_KEYS.includes(key as BlueprintMetaKey)) {
      throw new Error(`章节「${sectionTitle}」存在未知元数据键：${key}`);
    }
    if (key in meta) {
      throw new Error(`章节「${sectionTitle}」重复元数据键：${key}`);
    }
    meta[key as BlueprintMetaKey] = value;
  }
  for (const required of BLUEPRINT_META_KEYS) {
    if (meta[required] === undefined) {
      throw new Error(`章节「${sectionTitle}」缺少元数据：${required}`);
    }
  }
  const sourceRaw = meta.source as string;
  const headingsRaw = meta.headings as string;
  return {
    id: meta.id as string,
    title: sectionTitle,
    inclusion: meta.inclusion as string,
    presentation: meta.presentation as string,
    sourceNodeIds:
      sourceRaw === "-"
        ? []
        : sourceRaw.split(",").map((s) => s.trim()).filter(Boolean),
    sourceHeadings:
      headingsRaw === "-"
        ? []
        : headingsRaw.split(" / ").map((s) => s.trim()).filter(Boolean),
    rationale: meta.rationale as string,
  };
}

/**
 * Parse the editable line-format blueprint Markdown back into a validated
 * `FormalPrdBlueprint`. Requires exactly one level-1 title; sections split on
 * level-2 headings and must carry all six metadata fields as contiguous
 * `- key: value` lines. Prose between metadata fields is rejected rather than
 * silently dropped. The result is run through `validateBlueprint` so enum and
 * source-mapping invariants still hold.
 */
export function parseBlueprint(markdown: string): FormalPrdBlueprint {
  const lines = markdown.split(/\r?\n/);

  const h1Matches = lines
    .map((line) => line.match(H1_PATTERN))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (h1Matches.length !== 1) {
    throw new Error("正式 PRD 蓝图必须且只能包含一个一级标题");
  }
  const title = h1Matches[0][1];
  const h1LineIdx = lines.findIndex((line) => H1_PATTERN.test(line));

  const sections: { title: string; metaLines: string[] }[] = [];
  let current: { title: string; metaLines: string[] } | null = null;
  for (let i = h1LineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(H2_PATTERN);
    if (h2) {
      if (current) sections.push(current);
      current = { title: h2[1], metaLines: [] };
      continue;
    }
    if (current) {
      current.metaLines.push(line);
    } else if (line.trim() !== "") {
      throw new Error(`一级标题与首个章节之间存在非空内容：${line}`);
    }
  }
  if (current) sections.push(current);
  if (sections.length === 0) {
    throw new Error("正式 PRD 蓝图必须包含至少一个章节");
  }

  const parsedSections = sections.map((s) => parseBlueprintSectionMeta(s.title, s.metaLines));
  return validateBlueprint({ title, sections: parsedSections });
}

// ---------------------------------------------------------------------------
// Blueprint revision patches.
// ---------------------------------------------------------------------------

const blueprintPatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), section: blueprintSectionSchema, afterSectionId: z.string().min(1).optional() }),
  z.object({ op: z.literal("remove"), sectionId: z.string().min(1) }),
  z.object({ op: z.literal("update"), sectionId: z.string().min(1), fields: blueprintSectionSchema.omit({ id: true }).partial() }),
  z.object({ op: z.literal("reorder"), sectionId: z.string().min(1), afterSectionId: z.string().min(1).optional() }),
]);

export const blueprintPatchSchema = z.object({
  artifactDigest: z.string().min(1),
  ops: z.array(blueprintPatchOpSchema).min(1),
});

export type BlueprintPatchOp = z.infer<typeof blueprintPatchOpSchema>;
export type BlueprintPatch = z.infer<typeof blueprintPatchSchema>;
export type BlueprintPatchResult = {
  op: BlueprintPatchOp;
  status: "applied" | "skipped";
  reason?: string;
};

export function validateBlueprintPatch(input: unknown): BlueprintPatch {
  return blueprintPatchSchema.parse(input);
}

/**
 * Apply blueprint revision ops to a fresh copy of the sections. `afterSectionId`
 * means insert/move immediately after that section; omitted means append. A
 * missing target or anchor skips only that operation (with a Chinese reason);
 * every submitted op yields one result entry. The final blueprint is re-run
 * through `validateBlueprint` so a non-omit section can never lose its source
 * mapping.
 */
export function applyBlueprintPatches(
  blueprint: FormalPrdBlueprint,
  patch: BlueprintPatch,
): { blueprint: FormalPrdBlueprint; applied: BlueprintPatchResult[] } {
  let sections: FormalPrdSection[] = blueprint.sections.map((s) => ({ ...s }));
  const applied: BlueprintPatchResult[] = [];

  for (const op of patch.ops) {
    if (op.op === "add") {
      if (op.afterSectionId) {
        const anchorIdx = sections.findIndex((s) => s.id === op.afterSectionId);
        if (anchorIdx === -1) {
          applied.push({ op, status: "skipped", reason: `锚点章节不存在：${op.afterSectionId}` });
          continue;
        }
        sections = [...sections.slice(0, anchorIdx + 1), op.section, ...sections.slice(anchorIdx + 1)];
      } else {
        sections = [...sections, op.section];
      }
      applied.push({ op, status: "applied" });
    } else if (op.op === "remove") {
      const idx = sections.findIndex((s) => s.id === op.sectionId);
      if (idx === -1) {
        applied.push({ op, status: "skipped", reason: `目标章节不存在：${op.sectionId}` });
        continue;
      }
      sections = [...sections.slice(0, idx), ...sections.slice(idx + 1)];
      applied.push({ op, status: "applied" });
    } else if (op.op === "update") {
      const idx = sections.findIndex((s) => s.id === op.sectionId);
      if (idx === -1) {
        applied.push({ op, status: "skipped", reason: `目标章节不存在：${op.sectionId}` });
        continue;
      }
      sections = [...sections.slice(0, idx), { ...sections[idx], ...op.fields }, ...sections.slice(idx + 1)];
      applied.push({ op, status: "applied" });
    } else {
      // op.op === "reorder"
      const idx = sections.findIndex((s) => s.id === op.sectionId);
      if (idx === -1) {
        applied.push({ op, status: "skipped", reason: `目标章节不存在：${op.sectionId}` });
        continue;
      }
      const [moved] = sections.splice(idx, 1);
      let insertAt = sections.length;
      if (op.afterSectionId) {
        const anchorIdx = sections.findIndex((s) => s.id === op.afterSectionId);
        if (anchorIdx === -1) {
          sections.splice(idx, 0, moved);
          applied.push({ op, status: "skipped", reason: `锚点章节不存在：${op.afterSectionId}` });
          continue;
        }
        insertAt = anchorIdx + 1;
      }
      sections.splice(insertAt, 0, moved);
      applied.push({ op, status: "applied" });
    }
  }

  const next = validateBlueprint({ ...blueprint, sections });
  return { blueprint: next, applied };
}

// ---------------------------------------------------------------------------
// Draft revision patches (applied by formal-prd-patcher.ts).
// ---------------------------------------------------------------------------

const draftPatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), heading: z.string().min(1), body: z.string() }),
  z.object({ op: z.literal("remove"), heading: z.string().min(1) }),
  z.object({
    op: z.literal("insert"),
    heading: z.string().min(1),
    body: z.string(),
    afterHeading: z.string().min(1).optional(),
  }),
]);

export const draftPatchSchema = z.object({
  artifactDigest: z.string().min(1),
  ops: z.array(draftPatchOpSchema).min(1),
});

export type DraftPatchOp = z.infer<typeof draftPatchOpSchema>;
export type DraftPatch = z.infer<typeof draftPatchSchema>;
export type DraftPatchResult = {
  op: DraftPatchOp;
  status: "applied" | "skipped";
  reason?: string;
};

export function validateDraftPatch(input: unknown): DraftPatch {
  return draftPatchSchema.parse(input);
}
