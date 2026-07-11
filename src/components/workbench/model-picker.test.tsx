import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./model-picker";
import type { ModelProvider } from "@/lib/project/types";

const providers: ModelProvider[] = [
  {
    id: "p1",
    name: "Prov",
    apiBaseUrl: "https://x",
    apiKey: "k",
    protocol: "chat_completions",
    models: [{ name: "m1" }, { name: "m2", isDefault: true }],
    isDefault: true,
    createdAt: "",
    updatedAt: "",
  },
];

function renderPicker(overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const handlers = {
    onProviderIdChange: vi.fn(),
    onModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
  };
  const utils = render(
    <ModelPicker
      providers={providers}
      providerId="p1"
      model="m1"
      reasoningEffort="medium"
      {...handlers}
      {...overrides}
    />,
  );
  return { ...utils, ...handlers };
}

describe("ModelPicker", () => {
  it("renders nothing when there are no providers", () => {
    const { container } = render(
      <ModelPicker
        providers={[]}
        providerId=""
        model=""
        reasoningEffort="medium"
        onProviderIdChange={() => {}}
        onModelChange={() => {}}
        onReasoningEffortChange={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the menu and selects a model", async () => {
    const { onModelChange } = renderPicker();
    await userEvent.click(screen.getByRole("button", { name: /模型/ }));
    // The model list is a submenu revealed by hovering its toggle (which shows
    // the current model name); clicking the toggle would toggle it closed.
    await userEvent.hover(screen.getByRole("button", { name: "m1" }));
    await userEvent.click(screen.getByText("m2"));
    expect(onModelChange).toHaveBeenCalledWith("m2");
  });

  it("changes reasoning effort", async () => {
    const { onReasoningEffortChange } = renderPicker();
    await userEvent.click(screen.getByRole("button", { name: /模型/ }));
    await userEvent.click(screen.getByText("高"));
    expect(onReasoningEffortChange).toHaveBeenCalledWith("high");
  });
});
