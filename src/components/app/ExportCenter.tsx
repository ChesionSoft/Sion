import { useEffect, useRef, useState } from "react";
import {
  ExportClientError,
  applyExportCandidate,
  applyExportReview,
  approveExportArtifact,
  cancelExportAction,
  discardExportCandidate,
  exportDocxSaveAs,
  getExportArtifact,
  getExportWorkspace,
  saveExportArtifact,
  saveExportModelSelection,
  startExportAction,
  startExportReview,
} from "../../api";
import {
  nextExportAction,
  resolveDefaultExportModelSelection,
  resolveExportProjectId,
} from "../../export-state";
import { lineDiff } from "../../export-diff";
import { isLatestRequest, requestScope } from "../../ui-state";
import { Button, EmptyState, SelectField } from "../ui";
import { ArtifactNavigator, EXPORT_ARTIFACT_LABELS } from "../export/ArtifactNavigator";
import { ArtifactPreview } from "../export/ArtifactPreview";
import { BlueprintPreparationBar } from "../export/BlueprintPreparationBar";
import { ExportActionBar } from "../export/ExportActionBar";
import type {
  ChatModelSelection,
  ExportAction,
  ExportArtifactContent,
  ExportArtifactKind,
  ExportCandidate,
  ExportWorkspaceSnapshot,
  Provider,
  RecentProject,
} from "../../types";

export type ExportCenterProps = {
  projects: RecentProject[];
  activeProjectId: string | null;
  rememberedProjectId: string | null;
  providers: Provider[];
  refreshToken: number;
  onSelectProject: (projectId: string | null) => void;
  onNotice: (message: string) => void;
};

const utcNow = () => new Date().toISOString();

const PRIMARY_LABELS: Record<
  ExportAction | "approve_blueprint" | "approve_draft" | "complete",
  string
> = {
  generate_blueprint: "生成导出蓝图",
  regenerate_blueprint: "重新生成蓝图",
  generate_draft: "生成正式正文",
  regenerate_draft: "重新生成正文",
  finalize_docx: "生成正式 Word",
  generate_engineering_attachments: "重建工程附件",
  approve_blueprint: "批准蓝图",
  approve_draft: "批准正文",
  complete: "导出已完成",
};

const GENERATION_ACTIONS: ExportAction[] = [
  "generate_blueprint",
  "regenerate_blueprint",
  "generate_draft",
  "regenerate_draft",
];

const currentMarkdownFromContent = (content: ExportArtifactContent | null): string => {
  if (!content) {
    return "";
  }
  if (content.kind === "markdown" || content.kind === "source") {
    return content.markdown;
  }
  return "";
};

export function ExportCenter({
  projects,
  activeProjectId,
  rememberedProjectId,
  providers,
  refreshToken,
  onSelectProject,
  onNotice,
}: ExportCenterProps) {
  const resolvedProjectId = resolveExportProjectId(
    projects,
    activeProjectId,
    rememberedProjectId,
  );

  const [snapshot, setSnapshot] = useState<ExportWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<ExportArtifactKind | null>(null);
  const [content, setContent] = useState<ExportArtifactContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<ExportAction | null>(null);
  const [busy, setBusy] = useState(false);
  const workspaceScope = useRef<string | null>(null);
  const contentScope = useRef<string | null>(null);

  const refresh = (projectId: string) => {
    const scope = requestScope(projectId, `refresh-${refreshToken}-${Date.now()}`);
    workspaceScope.current = scope;
    getExportWorkspace(projectId)
      .then((next) => {
        if (isLatestRequest(scope, workspaceScope.current)) {
          setSnapshot(next);
        }
      })
      .catch((loadError) => {
        if (isLatestRequest(scope, workspaceScope.current)) {
          setError(String(loadError));
        }
      });
  };

  useEffect(() => {
    if (!resolvedProjectId) {
      setSnapshot(null);
      setError(null);
      return;
    }
    const scope = requestScope(resolvedProjectId, String(refreshToken));
    workspaceScope.current = scope;
    setLoading(true);
    setError(null);
    getExportWorkspace(resolvedProjectId)
      .then((next) => {
        if (!isLatestRequest(scope, workspaceScope.current)) {
          return;
        }
        if (!next.modelSelection) {
          const defaults = resolveDefaultExportModelSelection(providers);
          if (defaults) {
            saveExportModelSelection(resolvedProjectId, defaults, utcNow())
              .then((updated) => {
                if (isLatestRequest(scope, workspaceScope.current)) {
                  setSnapshot(updated);
                }
              })
              .catch(() => {
                if (isLatestRequest(scope, workspaceScope.current)) {
                  setSnapshot(next);
                }
              });
            return;
          }
        }
        setSnapshot(next);
      })
      .catch((loadError) => {
        if (isLatestRequest(scope, workspaceScope.current)) {
          setError(String(loadError));
        }
      })
      .finally(() => {
        if (isLatestRequest(scope, workspaceScope.current)) {
          setLoading(false);
        }
      });
  }, [resolvedProjectId, refreshToken, providers]);

  useEffect(() => {
    if (snapshot && selectedKind === null) {
      setSelectedKind("blueprint");
    }
  }, [snapshot, selectedKind]);

  useEffect(() => {
    if (editing) {
      return;
    }
    if (!resolvedProjectId || !selectedKind) {
      setContent(null);
      return;
    }
    const scope = requestScope(resolvedProjectId, selectedKind, String(refreshToken));
    contentScope.current = scope;
    setContentLoading(true);
    getExportArtifact(resolvedProjectId, selectedKind, "preview")
      .then((next) => {
        if (isLatestRequest(scope, contentScope.current)) {
          setContent(next);
        }
      })
      .catch((loadError) => {
        if (isLatestRequest(scope, contentScope.current)) {
          setContent({ kind: "error", message: String(loadError) });
        }
      })
      .finally(() => {
        if (isLatestRequest(scope, contentScope.current)) {
          setContentLoading(false);
        }
      });
  }, [resolvedProjectId, selectedKind, refreshToken, editing]);

  if (projects.length === 0) {
    return (
      <section className="export-center">
        <EmptyState
          title="还没有可导出的项目"
          description="先在项目页创建或发现一个本地项目，然后回到这里生成导出蓝图与正式交付物。"
        />
      </section>
    );
  }

  const blueprint = snapshot?.blueprint;
  const selectedLabel = selectedKind ? EXPORT_ARTIFACT_LABELS[selectedKind] : null;
  const selectedArtifact =
    selectedKind === "blueprint"
      ? snapshot?.blueprint
      : (snapshot?.deliveryArtifacts.find((item) => item.kind === selectedKind) ?? null);
  const expectedRevision = selectedArtifact?.revision ?? 0;
  const expectedDigest = selectedArtifact?.digest ?? "";
  const canEdit = selectedKind === "blueprint" || selectedKind === "formal_draft";
  const candidate =
    snapshot?.pendingCandidates.find((item) => item.targetKind === selectedKind) ?? null;
  const reviewTasks =
    snapshot?.reviewTasks.filter((task) => task.targetKind === selectedKind) ?? [];
  const activeRun = snapshot?.activeRun ?? null;
  const next = snapshot ? nextExportAction(snapshot) : { action: "generate_blueprint" as const };
  const runInProgress =
    activeRun?.status === "running" || activeRun?.status === "queued";
  const sourceWarnings = snapshot?.sourceWarnings ?? [];
  const formalDraft = snapshot?.deliveryArtifacts.find((item) => item.kind === "formal_draft");
  const formalDocx = snapshot?.deliveryArtifacts.find((item) => item.kind === "formal_docx");
  const actionsLocked = busy || runInProgress || editLoading;

  const artifactForKind = (kind: ExportArtifactKind) => {
    if (!snapshot) {
      return null;
    }
    if (kind === "blueprint") {
      return snapshot.blueprint;
    }
    return snapshot.deliveryArtifacts.find((item) => item.kind === kind) ?? null;
  };

  const handleEditStart = () => {
    if (!resolvedProjectId || !selectedKind) {
      return;
    }
    setEditError(null);
    getExportArtifact(resolvedProjectId, selectedKind, "source")
      .then((source) => {
        if (source.kind === "source" || source.kind === "markdown") {
          setEditBuffer(source.markdown);
          setEditing(true);
        } else if (source.kind === "empty") {
          setEditBuffer("");
          setEditing(true);
        } else {
          setEditError(source.kind === "error" ? source.message : "该产物暂不支持编辑。");
        }
      })
      .catch((loadError) => setEditError(String(loadError)));
  };

  const handleEditSave = () => {
    if (!resolvedProjectId || !selectedKind) {
      return;
    }
    setEditLoading(true);
    setEditError(null);
    saveExportArtifact(
      resolvedProjectId,
      selectedKind,
      expectedRevision,
      expectedDigest,
      editBuffer,
      utcNow(),
    )
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setEditing(false);
        onNotice("已保存。");
      })
      .catch((failure: unknown) => {
        if (failure instanceof ExportClientError && failure.detail.kind === "revision_conflict") {
          setEditError(
            `内容已被其他操作更新，最新修订 ${failure.detail.latestRevision ?? expectedRevision}。请取消后重新编辑。`,
          );
          refresh(resolvedProjectId);
        } else {
          setEditError(String(failure));
        }
      })
      .finally(() => setEditLoading(false));
  };

  const handleApplyCandidate = (target: ExportCandidate) => {
    if (!resolvedProjectId) {
      return;
    }
    setBusy(true);
    applyExportCandidate(resolvedProjectId, target.id, expectedRevision, expectedDigest, utcNow())
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        onNotice("已应用候选内容。");
      })
      .catch((failure: unknown) => {
        onNotice(`应用失败：${String(failure)}`);
      })
      .finally(() => setBusy(false));
  };

  const handleDiscardCandidate = (target: ExportCandidate) => {
    if (!resolvedProjectId) {
      return;
    }
    if (!window.confirm("确定丢弃该候选？")) {
      return;
    }
    setBusy(true);
    discardExportCandidate(resolvedProjectId, target.id, utcNow())
      .then((nextSnapshot) => setSnapshot(nextSnapshot))
      .catch((failure: unknown) => onNotice(`丢弃失败：${String(failure)}`))
      .finally(() => setBusy(false));
  };

  const handleCreateReview = (instruction: string) => {
    if (!resolvedProjectId || !selectedKind || !snapshot?.modelSelection) {
      onNotice("请先选择模型再发起评审。");
      return;
    }
    setBusy(true);
    startExportReview(
      resolvedProjectId,
      selectedKind,
      instruction,
      expectedRevision,
      expectedDigest,
      snapshot.modelSelection,
      utcNow(),
    )
      .then((nextSnapshot) => setSnapshot(nextSnapshot))
      .catch((failure: unknown) => onNotice(`评审失败：${String(failure)}`))
      .finally(() => setBusy(false));
  };

  const handleApplyReview = (taskId: string, selectedChangeIds: string[]) => {
    if (!resolvedProjectId) {
      return;
    }
    setBusy(true);
    applyExportReview(
      resolvedProjectId,
      taskId,
      selectedChangeIds,
      expectedRevision,
      expectedDigest,
      utcNow(),
    )
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        onNotice("已应用选中的修改。");
      })
      .catch((failure: unknown) => onNotice(`应用失败：${String(failure)}`))
      .finally(() => setBusy(false));
  };

  const executeExportAction = (action: ExportAction, acknowledgeSourceWarnings: boolean) => {
    if (!resolvedProjectId || !snapshot) {
      return;
    }
    setBusy(true);
    startExportAction(
      resolvedProjectId,
      action,
      snapshot.modelSelection,
      null,
      null,
      acknowledgeSourceWarnings,
      utcNow(),
    )
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setPendingAction(null);
      })
      .catch((failure: unknown) => {
        onNotice(`操作失败：${String(failure)}`);
        setPendingAction(null);
      })
      .finally(() => setBusy(false));
  };

  const requestExportAction = (action: ExportAction) => {
    if (!resolvedProjectId || !snapshot) {
      return;
    }
    if (GENERATION_ACTIONS.includes(action) && sourceWarnings.length > 0) {
      setPendingAction(action);
      return;
    }
    executeExportAction(action, false);
  };

  const handlePrimary = () => {
    if (!resolvedProjectId || !snapshot) {
      return;
    }
    const action = next.action;
    if (action === "approve_blueprint") {
      handleApprove("blueprint");
      return;
    }
    if (action === "approve_draft") {
      handleApprove("formal_draft");
      return;
    }
    if (action === "complete") {
      return;
    }
    requestExportAction(action);
  };

  const handleConfirmWarnings = () => {
    if (!pendingAction) {
      return;
    }
    executeExportAction(pendingAction, true);
  };

  const handleApprove = (kind: ExportArtifactKind) => {
    if (!resolvedProjectId || !snapshot) {
      return;
    }
    const artifact = artifactForKind(kind);
    if (!artifact || !artifact.available) {
      onNotice("产物尚未生成，无法批准。");
      return;
    }
    setBusy(true);
    approveExportArtifact(
      resolvedProjectId,
      kind,
      artifact.revision,
      artifact.digest,
      utcNow(),
    )
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        onNotice("已批准。");
      })
      .catch((failure: unknown) => onNotice(`批准失败：${String(failure)}`))
      .finally(() => setBusy(false));
  };

  const handleCancelRun = () => {
    if (!resolvedProjectId || !activeRun) {
      return;
    }
    cancelExportAction(resolvedProjectId, activeRun.runId, utcNow())
      .then((nextSnapshot) => setSnapshot(nextSnapshot))
      .catch((failure: unknown) => onNotice(`取消失败：${String(failure)}`));
  };

  const handleModelChange = async (selection: ChatModelSelection) => {
    if (!resolvedProjectId) {
      return;
    }
    try {
      const nextSnapshot = await saveExportModelSelection(
        resolvedProjectId,
        selection,
        utcNow(),
      );
      setSnapshot(nextSnapshot);
    } catch (failure: unknown) {
      onNotice(`保存模型失败：${String(failure)}`);
    }
  };

  const handleSaveAs = () => {
    if (!resolvedProjectId) {
      return;
    }
    setBusy(true);
    exportDocxSaveAs(resolvedProjectId)
      .then((result) => {
        if (!result.exported) {
          onNotice("已取消另存为。");
          return;
        }
        onNotice(result.path ? `已另存为：${result.path}` : "已另存为正式 Word。");
      })
      .catch((failure: unknown) => onNotice(`另存为失败：${String(failure)}`))
      .finally(() => setBusy(false));
  };

  const requiresModel = GENERATION_ACTIONS.includes(next.action as ExportAction);

  const beforeMarkdown =
    editing && editBuffer
      ? editBuffer
      : currentMarkdownFromContent(content);
  const candidateDiff = candidate ? lineDiff(beforeMarkdown, candidate.markdown) : [];

  return (
    <section className="export-center">
      <header className="export-center-header">
        <h1>导出中心</h1>
        <SelectField
          label="项目"
          value={resolvedProjectId ?? ""}
          onChange={(event) => onSelectProject(event.target.value || null)}
          disabled={loading || editing}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </SelectField>
      </header>

      {error ? <div className="export-preview-error">{error}</div> : null}

      {blueprint ? (
        <BlueprintPreparationBar
          blueprint={blueprint}
          approval={snapshot?.approvals.blueprint ?? null}
          selected={selectedKind === "blueprint"}
          onSelect={() => !editing && setSelectedKind("blueprint")}
          onEdit={
            canEdit && selectedKind === "blueprint" && !runInProgress
              ? handleEditStart
              : undefined
          }
          onRegenerate={
            blueprint.available && !editing
              ? () => requestExportAction("regenerate_blueprint")
              : undefined
          }
          onApprove={
            selectedKind === "blueprint" ? () => handleApprove("blueprint") : undefined
          }
          canApprove={Boolean(blueprint.available && !snapshot?.approvals.blueprint)}
          actionsDisabled={actionsLocked}
        />
      ) : null}

      {pendingAction && sourceWarnings.length > 0 ? (
        <div className="export-warning-confirm">
          <strong>来源节点已变化或不完整</strong>
          <ul>
            {sourceWarnings.map((nodeId) => (
              <li key={nodeId}>{nodeId}</li>
            ))}
          </ul>
          <div className="export-warning-confirm-actions">
            <Button variant="primary" onClick={handleConfirmWarnings} disabled={busy}>
              仍按当前已批准内容继续
            </Button>
            <Button variant="ghost" onClick={() => setPendingAction(null)} disabled={busy}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      <div className="export-workbench">
        <ArtifactNavigator
          artifacts={snapshot?.deliveryArtifacts ?? []}
          selectedKind={selectedKind === "blueprint" ? null : selectedKind}
          onSelect={(kind) => !editing && setSelectedKind(kind)}
        />
        <div className="export-preview">
          {editing ? (
            <ArtifactPreview
              content={null}
              loading={false}
              label={selectedLabel}
              canEdit={false}
              editing
              editBuffer={editBuffer}
              editError={editError}
              onEditBufferChange={setEditBuffer}
              onEditStart={handleEditStart}
              onEditSave={handleEditSave}
              onEditCancel={() => {
                setEditing(false);
                setEditError(null);
              }}
            />
          ) : candidate ? (
            <div className="export-candidate">
              <div className="export-candidate-header">
                <strong>重新生成候选</strong>
                <small>与当前内容对比，确认后替换。</small>
              </div>
              <pre className="export-diff-lines">
                {candidateDiff.map((line, index) => (
                  <span key={index} className={`export-diff-line is-${line.kind}`}>
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} {line.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
              <div className="export-candidate-actions">
                <Button
                  variant="primary"
                  disabled={actionsLocked}
                  onClick={() => handleApplyCandidate(candidate)}
                >
                  应用候选
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => handleDiscardCandidate(candidate)}
                >
                  丢弃
                </Button>
              </div>
            </div>
          ) : (
            <ArtifactPreview
              content={content}
              loading={contentLoading}
              label={selectedLabel}
              canEdit={canEdit && !runInProgress}
              editing={false}
              editBuffer=""
              editError={null}
              onEditBufferChange={setEditBuffer}
              onEditStart={handleEditStart}
              onEditSave={handleEditSave}
              onEditCancel={() => setEditing(false)}
              onRegenerate={
                selectedKind === "formal_draft" && formalDraft?.available
                  ? () => requestExportAction("regenerate_draft")
                  : undefined
              }
              onSaveAs={
                selectedKind === "formal_docx" && formalDocx?.available
                  ? handleSaveAs
                  : undefined
              }
              actionsDisabled={actionsLocked}
            />
          )}
        </div>
      </div>

      {snapshot ? (
        <ExportActionBar
          providers={providers}
          modelSelection={snapshot.modelSelection}
          onModelChange={handleModelChange}
          primaryLabel={PRIMARY_LABELS[next.action]}
          onPrimary={handlePrimary}
          primaryDisabled={
            busy || loading || next.action === "complete" || runInProgress
          }
          activeRun={activeRun}
          onCancel={handleCancelRun}
          requiresModel={requiresModel}
          reviewTasks={reviewTasks}
          reviewEnabled={
            selectedKind === "blueprint" || selectedKind === "formal_draft"
          }
          reviewBusy={actionsLocked}
          onCreateReview={handleCreateReview}
          onApplyReview={handleApplyReview}
        />
      ) : null}
    </section>
  );
}
