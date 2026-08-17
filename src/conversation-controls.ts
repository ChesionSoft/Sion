// Pure conversation control helpers: model selection, one-message file
// attachments, and context-indicator state. No Tauri imports; these are
// consumed by the conversation workspace components.

import type { ChatModelSelection, ChatSession, ContextEstimate, NodeId, Provider } from "./types.ts";

export const activeSessionForNode = (
  sessions: ChatSession[],
  sessionId: string | null,
  nodeId: NodeId | null,
): ChatSession | null => {
  if (!sessionId || !nodeId) return null;
  return sessions.find((session) => session.id === sessionId && session.nodeId === nodeId) ?? null;
};

const hasUsableContextWindow = (contextWindowTokens: number | null) =>
  Number.isSafeInteger(contextWindowTokens) && (contextWindowTokens ?? 0) > 0;

export const selectableModels = (providers: Provider[]) =>
  providers.flatMap((provider) =>
    provider.models
      .filter((model) => hasUsableContextWindow(model.contextWindowTokens))
      .map((model) => ({ provider, model })),
  );

export const selectableHarnessModels = (providers: Provider[]) =>
  selectableModels(providers).filter(({ model }) => model.toolCalling);

export const defaultModelSelection = (providers: Provider[]): ChatModelSelection | null => {
  const selectable = selectableHarnessModels(providers);
  const preferredProvider = providers.find((item) => item.isDefault);
  const preferred = selectable.find(
    ({ provider, model }) => provider.id === preferredProvider?.id && model.isDefault,
  )
    ?? selectable.find(({ provider }) => provider.id === preferredProvider?.id)
    ?? selectable.find(({ model }) => model.isDefault)
    ?? selectable[0];
  return preferred
    ? { providerId: preferred.provider.id, model: preferred.model.name, reasoningEffort: "medium" }
    : null;
};

export const selectionIsValid = (
  selection: ChatModelSelection | null,
  providers: Provider[],
) =>
  Boolean(
    selection &&
      selectableHarnessModels(providers).some(
        ({ provider, model }) =>
          provider.id === selection.providerId && model.name === selection.model,
      ),
  );

export const selectionIsValidForExport = (
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
}) =>
  state.nodeAvailable
  && Boolean(state.draft.trim())
  && selectionIsValid(state.selection, state.providers)
  && !state.savingSelection;

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
