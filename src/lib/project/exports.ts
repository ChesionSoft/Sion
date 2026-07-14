import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Packer } from "docx";
import { buildFormalPrdDocument } from "./docx";
import { runDocxQa, type DocxQaReport } from "./docx-qa";
import {
  serializeBlueprint,
  validateDraft,
  type FormalPrdBlueprint,
} from "./formal-prd";
import { assembleProjectDesignMarkdown, createAgentsMarkdown, createSpecMarkdown, createTasksMarkdown } from "./markdown";
import type { ProjectStore } from "./store";
import type { Project, ProjectNode } from "./types";

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
  /** Last DOCX structural-QA report, so the UI can show why finalization blocked. */
  qaReport?: DocxQaReport;
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

async function removeArtifacts(store: ProjectStore, projectId: string, filenames: string[]): Promise<void> {
  await Promise.all(
    filenames.map((filename) =>
      unlink(store.exportPath(projectId, filename)).catch(() => {
        // An artifact that does not exist is already invalidated.
      }),
    ),
  );
}

async function assertEligibleBlueprintSources(
  store: ProjectStore,
  projectId: string,
  blueprint: FormalPrdBlueprint,
): Promise<void> {
  const nodesById = new Map((await store.getProjectNodes(projectId)).map((node) => [node.id, node]));
  for (const section of blueprint.sections) {
    if (section.inclusion === "omit") continue;
    for (const nodeId of section.sourceNodeIds) {
      const node: ProjectNode | undefined = nodesById.get(nodeId);
      if (!node || node.status !== "confirmed") {
        throw new Error("正式 PRD 只能引用已确认节点内容");
      }
    }
  }
}

async function assertArtifactDigest(
  store: ProjectStore,
  projectId: string,
  filename: string,
  expectedDigest: string | undefined,
  submittedDigest?: string,
  message = "导出产物摘要不匹配，请重新确认",
): Promise<string> {
  if (!expectedDigest) throw new Error(message);
  let content: string;
  try {
    content = await readFile(store.exportPath(projectId, filename), "utf8");
  } catch {
    throw new Error(message);
  }
  const currentDigest = digest(content);
  if (currentDigest !== expectedDigest || (submittedDigest && currentDigest !== submittedDigest)) {
    throw new Error(message);
  }
  return content;
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
  await assertEligibleBlueprintSources(store, projectId, blueprint);
  const content = serializeBlueprint(blueprint);
  await writeFile(store.exportPath(projectId, "export-blueprint.md"), content, "utf8");
  await removeArtifacts(store, projectId, [
    "formal-prd-draft.md",
    "formal-prd-qa-report.md",
    "项目开发设计文档.docx",
  ]);
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
  await assertArtifactDigest(
    store,
    projectId,
    "export-blueprint.md",
    state.blueprintDigest,
    artifactDigest,
    "蓝图摘要不匹配，请重新确认",
  );
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
  await assertEligibleBlueprintSources(store, projectId, state.blueprint);
  const sourceMap = state.blueprint.sections
    .filter((section) => section.inclusion !== "omit")
    .map((section) => ({
      sectionId: section.id,
      sourceNodeIds: section.sourceNodeIds,
      headings: section.sourceHeadings,
    }));
  const draft = validateDraft({ markdown: draftMarkdown, sourceMap });
  await writeFile(store.exportPath(projectId, "formal-prd-draft.md"), draft.markdown, "utf8");
  await removeArtifacts(store, projectId, ["formal-prd-qa-report.md", "项目开发设计文档.docx"]);
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
  await assertArtifactDigest(
    store,
    projectId,
    "formal-prd-draft.md",
    state.draftDigest,
    artifactDigest,
    "正文摘要不匹配，请重新确认",
  );
  const next: ExportStageState = {
    ...state,
    draftApprovedDigest: state.draftDigest,
    updatedAt: new Date().toISOString(),
  };
  await persistState(store, projectId, next);
  return next;
}

/**
 * Finalization dependencies. Both are injectable so the staged approval flow
 * can be unit-tested without invoking the real server-side DOCX structural QA.
 * Defaults build the formal DOCX from the approved draft and run the real
 * pure-Node structural QA (no LibreOffice / Poppler).
 */
export type FinalizeDeps = {
  buildDocx?: (project: Project, draftMarkdown: string) => Promise<Buffer>;
  runDocxQa?: (docxPath: string) => Promise<DocxQaReport>;
};

export type FinalizeResult = {
  status: 200 | 422;
  qaReport: DocxQaReport;
  stage: ExportStageState;
};

/**
 * Finalize the formal PRD: build the formal Word document from the approved
 * draft, validate it through server-side DOCX structural QA, and only retain
 * the DOCX when QA passes. On failure the DOCX is removed and a 422 result
 * (with the persisted QA report) is returned. Requires `canFinalize(state)`;
 * the route enforces the 409 gate, this function guards again defensively.
 */
export async function finalizeFormalPrdExport(
  store: ProjectStore,
  projectId: string,
  deps: FinalizeDeps = {},
): Promise<FinalizeResult> {
  const state = await readStageState(store, projectId);
  if (!canFinalize(state)) {
    throw new Error("请先确认导出蓝图与正式正文后再生成正式 Word");
  }

  const project = await store.getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  await assertArtifactDigest(store, projectId, "export-blueprint.md", state.blueprintDigest);
  const draftMarkdown = await assertArtifactDigest(
    store,
    projectId,
    "formal-prd-draft.md",
    state.draftDigest,
    undefined,
    "已确认正文摘要不匹配，请重新确认",
  );
  const buildDocx = deps.buildDocx ?? defaultBuildDocx;
  const runQa = deps.runDocxQa ?? ((docxPath: string) => runDocxQa(docxPath));

  const docxPath = store.exportPath(projectId, "项目开发设计文档.docx");
  const buffer = await buildDocx(project, draftMarkdown);
  await writeFile(docxPath, buffer);

  const qaReport = await runQa(docxPath);
  await writeFile(store.exportPath(projectId, "formal-prd-qa-report.md"), renderQaReportMarkdown(qaReport), "utf8");

  if (!qaReport.passed) {
    await unlink(docxPath).catch(() => {
      // DOCX already absent; the failure result still holds.
    });
    const next: ExportStageState = { ...state, qaStatus: "failed", qaReport, updatedAt: new Date().toISOString() };
    await persistState(store, projectId, next);
    return { status: 422, qaReport, stage: next };
  }

  // QA passed: write the four internal Markdown exports alongside the formal
  // Word, and record the successful QA state.
  await exportProjectDocuments(store, projectId);
  const next: ExportStageState = { ...state, qaStatus: "passed", qaReport, updatedAt: new Date().toISOString() };
  await persistState(store, projectId, next);
  return { status: 200, qaReport, stage: next };
}

async function defaultBuildDocx(project: Project, draftMarkdown: string): Promise<Buffer> {
  return Buffer.from(await Packer.toBuffer(buildFormalPrdDocument(project, draftMarkdown)));
}

function renderQaReportMarkdown(report: DocxQaReport): string {
  const lines = [
    "# 正式 PRD DOCX 结构与内容校验报告",
    "",
    `- 通过：${report.passed ? "是" : "否"}`,
    `- 校验时间：${report.checkedAt}`,
    `- 结构单元数（标题数）：${report.structuralUnitCount}`,
    "",
  ];
  if (report.issues.length === 0) {
    lines.push("无问题。");
  } else {
    lines.push("## 问题");
    for (const issue of report.issues) {
      lines.push(`- [${issue.code}] ${issue.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
