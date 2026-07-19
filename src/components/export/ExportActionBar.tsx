import { ConversationModelMenu } from "../workspace/ConversationModelMenu";
import { Button } from "../ui";
import { ReviewLedger } from "./ReviewLedger";
import type {
  ChatModelSelection,
  ExportReviewTask,
  ExportRunSummary,
  Provider,
} from "../../types";

export type ExportActionBarProps = {
  providers: Provider[];
  modelSelection: ChatModelSelection | null;
  onModelChange: (selection: ChatModelSelection) => Promise<void> | void;
  savingModel?: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled: boolean;
  activeRun: ExportRunSummary | null;
  onCancel: () => void;
  requiresModel: boolean;
  reviewTasks: ExportReviewTask[];
  reviewEnabled: boolean;
  reviewBusy: boolean;
  onCreateReview: (instruction: string) => void;
  onApplyReview: (taskId: string, selectedChangeIds: string[]) => void;
};

export function ExportActionBar({
  providers,
  modelSelection,
  onModelChange,
  savingModel,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  activeRun,
  onCancel,
  requiresModel,
  reviewTasks,
  reviewEnabled,
  reviewBusy,
  onCreateReview,
  onApplyReview,
}: ExportActionBarProps) {
  const runInProgress = activeRun
    ? activeRun.status === "running" || activeRun.status === "queued"
    : false;
  const modelUnavailable = requiresModel && !modelSelection;
  return (
    <footer className="export-action-bar">
      <div className="export-action-model">
        <ConversationModelMenu
          providers={providers}
          selection={modelSelection}
          disabled={runInProgress}
          saving={Boolean(savingModel)}
          onSelection={async (selection) => {
            await onModelChange(selection);
          }}
        />
      </div>
      <div className="export-action-review">
        {reviewEnabled ? (
          <ReviewLedger
            tasks={reviewTasks}
            busy={reviewBusy}
            onCreateTask={onCreateReview}
            onApplyTask={onApplyReview}
          />
        ) : (
          <p className="export-review-placeholder">
            评审任务账本仅用于蓝图与正式正文。
          </p>
        )}
      </div>
      <div className="export-action-run">
        {runInProgress ? (
          <span className="export-action-status">
            {activeRun?.publicSummary ?? "运行中…"}
          </span>
        ) : null}
        <Button
          variant="primary"
          onClick={onPrimary}
          disabled={primaryDisabled || modelUnavailable || runInProgress}
        >
          {primaryLabel}
        </Button>
        {runInProgress ? (
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
        ) : null}
      </div>
    </footer>
  );
}
