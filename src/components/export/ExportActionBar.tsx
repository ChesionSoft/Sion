import { Button, SelectField } from "../ui";
import type {
  ChatModelSelection,
  ExportRunSummary,
  Provider,
  ReasoningEffort,
} from "../../types";

export type ExportActionBarProps = {
  providers: Provider[];
  modelSelection: ChatModelSelection | null;
  onModelChange: (selection: ChatModelSelection) => void;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled: boolean;
  activeRun: ExportRunSummary | null;
  onCancel: () => void;
  requiresModel: boolean;
};

const REASONING_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

export function ExportActionBar({
  providers,
  modelSelection,
  onModelChange,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  activeRun,
  onCancel,
  requiresModel,
}: ExportActionBarProps) {
  const activeProvider = providers.find((p) => p.id === modelSelection?.providerId) ?? null;
  const modelOptions = activeProvider?.models ?? [];
  const runInProgress = activeRun
    ? activeRun.status === "running" || activeRun.status === "queued"
    : false;
  const modelUnavailable = requiresModel && !modelSelection;
  return (
    <footer className="export-action-bar">
      <div className="export-action-models">
        <SelectField
          label="模型供应商"
          value={modelSelection?.providerId ?? ""}
          disabled={runInProgress}
          onChange={(event) => {
            const provider = providers.find((p) => p.id === event.target.value);
            const model = provider?.models.find((m) => m.isDefault) ?? provider?.models[0];
            if (provider && model) {
              onModelChange({
                providerId: provider.id,
                model: model.name,
                reasoningEffort: modelSelection?.reasoningEffort ?? "medium",
              });
            }
          }}
        >
          {providers.length === 0 ? <option value="">未配置供应商</option> : null}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="模型"
          value={modelSelection?.model ?? ""}
          disabled={runInProgress || !activeProvider}
          onChange={(event) => {
            if (modelSelection) {
              onModelChange({ ...modelSelection, model: event.target.value });
            }
          }}
        >
          {modelOptions.map((model) => (
            <option key={model.name} value={model.name}>
              {model.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="推理强度"
          value={modelSelection?.reasoningEffort ?? "medium"}
          disabled={runInProgress}
          onChange={(event) => {
            if (modelSelection) {
              onModelChange({
                ...modelSelection,
                reasoningEffort: event.target.value as ReasoningEffort,
              });
            }
          }}
        >
          {REASONING_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
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