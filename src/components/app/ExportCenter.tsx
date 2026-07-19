import { useEffect, useRef, useState } from "react";
import {
  getExportArtifact,
  getExportWorkspace,
  saveExportModelSelection,
} from "../../api";
import {
  resolveDefaultExportModelSelection,
  resolveExportProjectId,
} from "../../export-state";
import { isLatestRequest, requestScope } from "../../ui-state";
import { EmptyState, SelectField } from "../ui";
import { ArtifactNavigator, EXPORT_ARTIFACT_LABELS } from "../export/ArtifactNavigator";
import { ArtifactPreview } from "../export/ArtifactPreview";
import { BlueprintPreparationBar } from "../export/BlueprintPreparationBar";
import type {
  ExportArtifactContent,
  ExportArtifactKind,
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

export function ExportCenter({
  projects,
  activeProjectId,
  rememberedProjectId,
  providers,
  refreshToken,
  onSelectProject,
}: ExportCenterProps) {
  const resolvedProjectId = resolveExportProjectId(
    projects,
    activeProjectId,
    rememberedProjectId,
  );

  // Report the resolved id back so App remembers the export selection.
  useEffect(() => {
    onSelectProject(resolvedProjectId);
  }, [resolvedProjectId, onSelectProject]);

  const [snapshot, setSnapshot] = useState<ExportWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<ExportArtifactKind | null>(null);
  const [content, setContent] = useState<ExportArtifactContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const workspaceScope = useRef<string | null>(null);
  const contentScope = useRef<string | null>(null);

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
  }, [resolvedProjectId, selectedKind, refreshToken]);

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

  return (
    <section className="export-center">
      <header className="export-center-header">
        <h1>导出中心</h1>
        <SelectField
          label="项目"
          value={resolvedProjectId ?? ""}
          onChange={(event) => onSelectProject(event.target.value)}
          disabled={loading}
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
          onSelect={() => setSelectedKind("blueprint")}
        />
      ) : null}

      <div className="export-workbench">
        <ArtifactNavigator
          artifacts={snapshot?.deliveryArtifacts ?? []}
          selectedKind={selectedKind === "blueprint" ? null : selectedKind}
          onSelect={(kind) => setSelectedKind(kind)}
        />
        <div className="export-preview">
          <ArtifactPreview
            content={content}
            loading={contentLoading}
            label={selectedLabel}
          />
        </div>
        <aside className="export-review">
          <p className="export-review-placeholder">评审任务账本与编辑操作将在后续步骤启用。</p>
        </aside>
      </div>
    </section>
  );
}