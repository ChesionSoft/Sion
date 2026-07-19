// Pure export selectors: project selection, default model derivation, artifact
// grouping, the next action, and event scoping. No IPC or React state here —
// these are deterministic functions the page layer consumes.

import type {
  ChatModelSelection,
  ExportAction,
  ExportArtifactKind,
  ExportArtifactSummary,
  ExportApproval,
  ExportRunEvent,
  ExportWorkspaceInvalidatedEvent,
  ExportWorkspaceSnapshot,
  Provider,
  ReasoningEffort,
  RecentProject,
} from "./types";

/**
 * Resolves the export project id with current-project-first, remembered-second,
 * most-recent-third priority. Returns null only when there are no projects.
 */
export const resolveExportProjectId = (
  projects: RecentProject[],
  activeProjectId: string | null,
  rememberedProjectId: string | null,
): string | null => {
  if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
    return activeProjectId;
  }
  if (rememberedProjectId && projects.some((project) => project.id === rememberedProjectId)) {
    return rememberedProjectId;
  }
  const sorted = [...projects].sort((left, right) =>
    (right.openedAt ?? "").localeCompare(left.openedAt ?? ""),
  );
  return sorted[0]?.id ?? null;
};

/**
 * Derives the default model selection from the configured providers: the default
 * provider, then its default model, then its first model, with medium reasoning
 * effort. Returns null when no configured provider has a model. Never returns
 * or uses API-key material.
 */
export const resolveDefaultExportModelSelection = (
  providers: Provider[],
): ChatModelSelection | null => {
  const ordered = [...providers].sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return 0;
  });
  const provider = ordered.find((candidate) => candidate.models.length > 0);
  if (!provider) {
    return null;
  }
  const model =
    provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  const selection: ChatModelSelection = {
    providerId: provider.id,
    model: model.name,
    reasoningEffort: "medium" as ReasoningEffort,
  };
  return selection;
};

export type ExportArtifactGroup = {
  id: "formal" | "engineering";
  label: string;
  items: ExportArtifactSummary[];
};

const FORMAL_KINDS: ExportArtifactKind[] = [
  "formal_draft",
  "qa_report",
  "formal_docx",
];
const ENGINEERING_KINDS: ExportArtifactKind[] = [
  "project_design",
  "spec",
  "tasks",
  "agents",
];

/**
 * Groups delivery artifact summaries, excluding the blueprint. The blueprint is
 * deliberately filtered here so a caller that passes it in cannot surface it as
 * a delivery artifact.
 */
export const exportArtifactGroups = (
  artifacts: ExportArtifactSummary[],
): ExportArtifactGroup[] => {
  const byKind = new Map<ExportArtifactKind, ExportArtifactSummary>();
  for (const artifact of artifacts) {
    if (artifact.kind === "blueprint") {
      continue;
    }
    byKind.set(artifact.kind, artifact);
  }
  const pick = (kinds: ExportArtifactKind[]): ExportArtifactSummary[] =>
    kinds
      .map((kind) => byKind.get(kind))
      .filter((item): item is ExportArtifactSummary => Boolean(item));
  return [
    {
      id: "formal",
      label: "正式交付",
      items: pick(FORMAL_KINDS),
    },
    {
      id: "engineering",
      label: "工程附件",
      items: pick(ENGINEERING_KINDS),
    },
  ];
};

const isApproved = (approval: ExportApproval | null | undefined): boolean =>
  Boolean(approval);

/**
 * Returns the next export action for a snapshot, or "complete" when every stage
 * is done. Approval actions are handled by the synchronous approval command;
 * generation, finalization, and attachment-retry actions call
 * `export_action_start`.
 */
export const nextExportAction = (
  snapshot: ExportWorkspaceSnapshot,
): { action: ExportAction | "approve_blueprint" | "approve_draft" | "complete" } => {
  const blueprintAvailable = snapshot.blueprint.available;
  if (!blueprintAvailable) {
    return { action: "generate_blueprint" };
  }
  if (!isApproved(snapshot.approvals.blueprint)) {
    return { action: "approve_blueprint" };
  }
  const draft = snapshot.deliveryArtifacts.find(
    (item) => item.kind === "formal_draft",
  );
  if (!draft || !draft.available) {
    return { action: "generate_draft" };
  }
  if (!isApproved(snapshot.approvals.draft)) {
    return { action: "approve_draft" };
  }
  const docx = snapshot.deliveryArtifacts.find(
    (item) => item.kind === "formal_docx",
  );
  if (!docx || !docx.available || docx.stale) {
    return { action: "finalize_docx" };
  }
  const batchFailed =
    typeof snapshot.attachmentBatchStatus !== "string" &&
    "failed" in snapshot.attachmentBatchStatus;
  const engineeringMissing = ENGINEERING_KINDS.some((kind) => {
    const artifact = snapshot.deliveryArtifacts.find((item) => item.kind === kind);
    return !artifact || !artifact.available || artifact.stale;
  });
  if (batchFailed || engineeringMissing) {
    return { action: "generate_engineering_attachments" };
  }
  return { action: "complete" };
};

type ExportEvent =
  | ExportRunEvent
  | ExportWorkspaceInvalidatedEvent
  | { projectId: string };

/**
 * Accepts an export event only when both the project id and (for run events) the
 * run id match the current project and active run. Events from other projects,
 * old runs, or cancelled runs never mutate the current page.
 */
export const acceptExportEvent = (
  event: ExportEvent,
  projectId: string | null,
  activeRunId: string | null,
): boolean => {
  if (!projectId || event.projectId !== projectId) {
    return false;
  }
  if ("runId" in event) {
    return activeRunId === event.runId;
  }
  return true;
};