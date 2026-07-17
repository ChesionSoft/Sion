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

export const toggleAttachment = (ids: string[], fileId: string) =>
  ids.includes(fileId) ? ids.filter((id) => id !== fileId) : [...ids, fileId];

export const contextIndicatorKind = (estimate: Pick<ContextEstimate, "status">) =>
  estimate.status;
