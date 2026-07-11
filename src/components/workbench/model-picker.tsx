"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModelProvider, ReasoningEffort } from "@/lib/project/types";

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
];

export type ModelPickerProps = {
  providers: ModelProvider[];
  providerId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  onProviderIdChange: (id: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  /** Which side of the trigger the menu opens on. Defaults to "top" (chat input bar). */
  placement?: "top" | "bottom";
};

export function ModelPicker({
  providers,
  providerId,
  model,
  reasoningEffort,
  onProviderIdChange,
  onModelChange,
  onReasoningEffortChange,
  placement = "top",
}: ModelPickerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selectedProvider = providers.find((p) => p.id === providerId);
  const selectedReasoning =
    REASONING_OPTIONS.find((o) => o.value === reasoningEffort) ?? REASONING_OPTIONS[1];

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setSubmenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setSubmenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function selectModel(provider: ModelProvider, modelName: string) {
    onProviderIdChange(provider.id);
    onModelChange(modelName);
    setMenuOpen(false);
    setSubmenuOpen(false);
  }

  if (providers.length === 0) return null;

  const menuY = placement === "top" ? "bottom-10" : "top-10";
  const submenuY = placement === "top" ? "bottom-0" : "top-0";

  return (
    <div className="relative flex shrink-0 items-center gap-2" ref={ref}>
      <button
        aria-label={`模型 ${model || selectedProvider?.models.find((m) => m.isDefault)?.name || selectedProvider?.models[0]?.name || "未选择"}，推理 ${selectedReasoning.label}`}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border bg-background px-3 text-xs font-medium shadow-sm transition hover:bg-muted/60"
        onClick={() => {
          setMenuOpen((open) => !open);
          setSubmenuOpen(false);
        }}
        type="button"
      >
        <span className="truncate">
          {model || selectedProvider?.models.find((m) => m.isDefault)?.name || selectedProvider?.models[0]?.name || "选择模型"}
        </span>
        <span className="text-muted-foreground">{selectedReasoning.label}</span>
        <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {menuOpen ? (
        <div className={cn("absolute right-0 z-30 w-52 rounded-xl border bg-popover p-1.5 text-sm shadow-xl", menuY)}>
          <p className="px-2 py-1 text-xs text-muted-foreground">推理强度</p>
          {REASONING_OPTIONS.map((option) => (
            <button
              key={option.value}
              className="flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-sm hover:bg-muted"
              onClick={() => onReasoningEffortChange(option.value)}
              type="button"
            >
              <span>{option.label}</span>
              {reasoningEffort === option.value ? <CheckIcon className="h-4 w-4" /> : null}
            </button>
          ))}

          <div className="my-1 h-px bg-border" />

          <button
            className={cn(
              "flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-sm hover:bg-muted",
              submenuOpen && "bg-muted",
            )}
            onClick={() => setSubmenuOpen((open) => !open)}
            onMouseEnter={() => setSubmenuOpen(true)}
            type="button"
          >
            <span className="truncate">{model || "模型"}</span>
            <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
          </button>

          {submenuOpen ? (
            <div className={cn("absolute right-[calc(100%+6px)] z-40 max-h-72 w-56 overflow-auto rounded-xl border bg-popover p-1.5 shadow-xl", submenuY)}>
              <p className="px-2 py-1 text-xs text-muted-foreground">选择模型</p>
              {providers.map((provider) => (
                <div key={provider.id}>
                  {providers.length > 1 ? (
                    <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{provider.name}</p>
                  ) : null}
                  {provider.models.map((m) => {
                    const active = provider.id === providerId && m.name === model;
                    return (
                      <button
                        key={`${provider.id}-${m.name}`}
                        className="flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
                        onClick={() => selectModel(provider, m.name)}
                        type="button"
                      >
                        <span className="truncate">{m.name}</span>
                        {active ? <CheckIcon className="h-4 w-4 shrink-0" /> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
