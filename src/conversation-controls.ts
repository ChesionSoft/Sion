// Pure conversation control helpers: model selection, one-message file
// attachments, and context-indicator state. No Tauri imports; these are
// consumed by the conversation workspace components.

import type { ChatModelSelection, ContextEstimate, Provider } from "./types.ts";

export const selectableModels = (providers: Provider[]) =>
  providers.flatMap((provider) =>
    provider.models
      .filter(
        (model) =>
          Number.isSafeInteger(model.contextWindowTokens) &&
          (model.contextWindowTokens ?? 0) > 0,
      )
      .map((model) => ({ provider, model })),
  );

export const defaultModelSelection = (providers: Provider[]): ChatModelSelection | null => {
  const provider = providers.find((item) => item.isDefault) ?? providers[0];
  if (!provider) return null;
  const model = provider.models.find((item) => item.isDefault) ?? provider.models[0];
  return model?.contextWindowTokens
    ? { providerId: provider.id, model: model.name, reasoningEffort: "medium" }
    : null;
};

export const selectionIsValid = (
  selection: ChatModelSelection | null,
  providers: Provider[],
) =>
  Boolean(
    selection &&
      selectableModels(providers).some(
        ({ provider, model }) =>
          provider.id === selection.providerId && model.name === selection.model,
      ),
  );

export const conversationCanSend = (state: {
  nodeAvailable: boolean;
  draft: string;
  selection: ChatModelSelection | null;
  providers: Provider[];
  savingSelection: boolean;
  estimating: boolean;
  estimate: ContextEstimate | null;
  estimateError: string | null;
}) =>
  state.nodeAvailable
  && Boolean(state.draft.trim())
  && selectionIsValid(state.selection, state.providers)
  && !state.savingSelection
  && !state.estimating
  && state.estimate !== null
  && state.estimate.status !== "blocked"
  && !state.estimateError;

export const toggleAttachment = (ids: string[], fileId: string) =>
  ids.includes(fileId) ? ids.filter((id) => id !== fileId) : [...ids, fileId];

export const contextIndicatorKind = (estimate: Pick<ContextEstimate, "status">) =>
  estimate.status;

export const providerModelValidationError = (rows: Array<{
  name: string;
  contextWindow: string;
  isDefault: boolean;
}>): string | null => {
  const names = rows.map((row) => row.name.trim());
  if (names.some((name, index) => name && names.indexOf(name) !== index)) {
    return "模型名称不能重复";
  }
  if (rows.filter((row) => row.isDefault).length !== 1) {
    return "需要恰好一个默认模型";
  }
  if (names.some((name) => !name)) {
    return "请填写所有模型名称";
  }
  if (rows.some((row) => !(Number.isSafeInteger(Number(row.contextWindow)) && Number(row.contextWindow) > 0))) {
    return "每个模型需要正整数的上下文窗口";
  }
  return null;
};
