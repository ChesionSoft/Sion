import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  serializeBlueprint,
  validateDraft,
  type FormalPrdBlueprint,
} from "./formal-prd";
import { assembleProjectDesignMarkdown, createAgentsMarkdown, createSpecMarkdown, createTasksMarkdown } from "./markdown";
import type { ProjectStore } from "./store";

export type ExportedFile = {
  filename: string;
  path: string;
};

export type ExportProjectDocumentsResult = {
  files: ExportedFile[];
};

/**
 * Persisted staged-export approval state. Saved as `formal-prd-state.json`
 * inside the project exports directory (intentionally outside EXPORT_FILENAMES,
 * so it is never served or listed). `canFinalize` only consults the digest
 * fields; `blueprint` is stored so the draft stage can derive its source map
 * without re-parsing the serialized blueprint file.
 */
export type ExportStageState = {
  blueprint?: FormalPrdBlueprint;
  blueprintDigest?: string;
  blueprintApprovedDigest?: string;
  draftDigest?: string;
  draftApprovedDigest?: string;
  qaStatus?: "passed" | "failed";
  updatedAt: string;
};

export function canFinalize(state: ExportStageState): boolean {
  return Boolean(
    state.blueprintDigest &&
      state.blueprintDigest === state.blueprintApprovedDigest &&
      state.draftDigest &&
      state.draftDigest === state.draftApprovedDigest,
  );
}

const STATE_FILENAME = "formal-prd-state.json";

function statePath(store: ProjectStore, projectId: string): string {
  return path.join(store.projectDir(projectId), "exports", STATE_FILENAME);
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function readStageState(store: ProjectStore, projectId: string): Promise<ExportStageState> {
  try {
    const raw = await readFile(statePath(store, projectId), "utf8");
    return JSON.parse(raw) as ExportStageState;
  } catch {
    return { updatedAt: "" };
  }
}

async function persistState(store: ProjectStore, projectId: string, state: ExportStageState): Promise<void> {
  await writeFile(statePath(store, projectId), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Serialize and persist the blueprint, record its digest, and clear any prior
 * draft/approval/QA state so the draft must be regenerated and re-approved
 * against the new blueprint.
 */
export async function writeBlueprintArtifact(
  store: ProjectStore,
  projectId: string,
  blueprint: FormalPrdBlueprint,
): Promise<ExportStageState> {
  const content = serializeBlueprint(blueprint);
  await writeFile(store.exportPath(projectId, "export-blueprint.md"), content, "utf8");
  const prev = await readStageState(store, projectId);
  const state: ExportStageState = {
    ...prev,
    blueprint,
    blueprintDigest: digest(content),
    blueprintApprovedDigest: undefined,
    draftDigest: undefined,
    draftApprovedDigest: undefined,
    qaStatus: undefined,
    updatedAt: new Date().toISOString(),
  };
  await persistState(store, projectId, state);
  return state;
}

/**
 * Approve the current blueprint. The request digest must match the blueprint
 * digest currently on disk; otherwise the approval is rejected (stale or
 * mismatched blueprint).
 */
export async function approveBlueprintArtifact(
  store: ProjectStore,
  projectId: string,
  artifactDigest: string,
): Promise<ExportStageState> {
  const state = await readStageState(store, projectId);
  if (!state.blueprintDigest || state.blueprintDigest !== artifactDigest) {
    throw new Error("蓝图摘要不匹配，请重新确认");
  }
  const next: ExportStageState = {
    ...state,
    blueprintApprovedDigest: state.blueprintDigest,
    updatedAt: new Date().toISOString(),
  };
  await persistState(store, projectId, next);
  return next;
}

/**
 * Write the formal PRD draft. Requires an approved blueprint; the draft source
 * map is derived from the approved blueprint's non-omit sections, so the draft
 * can never reference material the blueprint did not curate. The draft Markdown
 * is lint-validated to keep process noise out of the formal artifact.
 */
export async function writeDraftArtifact(
  store: ProjectStore,
  projectId: string,
  draftMarkdown: string,
): Promise<ExportStageState> {
  const state = await readStageState(store, projectId);
  if (!state.blueprint || !state.blueprintDigest || state.blueprintApprovedDigest !== state.blueprintDigest) {
    throw new Error("请先确认导出蓝图");
  }
  const sourceMap = state.blueprint.sections
    .filter((section) => section.inclusion !== "omit")
    .map((section) => ({
      sectionId: section.id,
      sourceNodeIds: section.sourceNodeIds,
      headings: section.sourceHeadings,
    }));
  const draft = validateDraft({ markdown: draftMarkdown, sourceMap });
  await writeFile(store.exportPath(projectId, "formal-prd-draft.md"), draft.markdown, "utf8");
  const next: ExportStageState = {
    ...state,
    draftDigest: digest(draft.markdown),
    draftApprovedDigest: undefined,
    qaStatus: undefined,
    updatedAt: new Date().toISOString(),
  };
  await persistState(store, projectId, next);
  return next;
}

/**
 * Approve the current draft. The request digest must match the draft digest
 * currently on disk.
 */
export async function approveDraftArtifact(
  store: ProjectStore,
  projectId: string,
  artifactDigest: string,
): Promise<ExportStageState> {
  const state = await readStageState(store, projectId);
  if (!state.draftDigest || state.draftDigest !== artifactDigest) {
    throw new Error("正文摘要不匹配，请重新确认");
  }
  const next: ExportStageState = {
    ...state,
    draftApprovedDigest: state.draftDigest,
    updatedAt: new Date().toISOString(),
  };
  await persistState(store, projectId, next);
  return next;
}

/**
 * Write the four internal Markdown exports (PROJECT_DESIGN / SPEC / TASKS /
 * AGENTS) derived from node content. These are internal working artifacts, not
 * inputs to the formal PRD; the formal Word document is produced separately by
 * the finalize stage from the approved formal draft.
 */
export async function exportProjectDocuments(
  store: ProjectStore,
  projectId: string,
  masterMarkdown?: string,
): Promise<ExportProjectDocumentsResult> {
  const project = await store.getProject(projectId);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const nodes = await store.getProjectNodes(projectId);
  const projectDesign = masterMarkdown ?? assembleProjectDesignMarkdown(project, nodes);
  const spec = createSpecMarkdown(project, nodes);
  const tasks = createTasksMarkdown(project, nodes);
  const agents = createAgentsMarkdown(project);

  const entries = [
    { filename: "PROJECT_DESIGN.md", content: projectDesign },
    { filename: "SPEC.md", content: spec },
    { filename: "TASKS.md", content: tasks },
    { filename: "AGENTS.md", content: agents },
  ] as const;

  const exported: ExportedFile[] = [];
  for (const entry of entries) {
    await writeFile(store.exportPath(projectId, entry.filename), entry.content, "utf8");
    exported.push({ filename: entry.filename, path: store.exportPath(projectId, entry.filename) });
  }

  return { files: exported };
}