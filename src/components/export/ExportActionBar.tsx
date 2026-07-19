import { useState } from "react";
import { ConversationModelMenu } from "../workspace/ConversationModelMenu";
import { Button } from "../ui";
import { ReviewLedger } from "./ReviewLedger";
import type {
  ChatModelSelection,
  ExportReviewTask,
  Provider,
} from "../../types";

export type ExportActionBarProps = {
  providers: Provider[];
  modelSelection: ChatModelSelection | null;
  onModelChange: (selection: ChatModelSelection) => Promise<void> | void;
  savingModel?: boolean;
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
  reviewTasks,
  reviewEnabled,
  reviewBusy,
  onCreateReview,
  onApplyReview,
}: ExportActionBarProps) {
  const [instruction, setInstruction] = useState("");
  const canCreateReview =
    reviewEnabled && !reviewBusy && instruction.trim().length > 0;

  return (
    <footer className="export-action-bar">
      <div className="export-action-model">
        <ConversationModelMenu
          providers={providers}
          selection={modelSelection}
          disabled={reviewBusy}
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
            hideCreateButton
            instruction={instruction}
            onInstructionChange={setInstruction}
          />
        ) : (
          <p className="export-review-placeholder">
            评审任务账本仅用于蓝图与正式正文。
          </p>
        )}
      </div>
      <div className="export-action-run">
        <Button
          variant="primary"
          disabled={!canCreateReview}
          onClick={() => {
            onCreateReview(instruction.trim());
            setInstruction("");
          }}
        >
          生成修改建议
        </Button>
      </div>
    </footer>
  );
}
