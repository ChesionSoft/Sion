import { useEffect, useRef, useState } from "react";
import type { ChatModelSelection, Provider, ReasoningEffort } from "../../types";

const REASONING_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

function labelFor(effort: ReasoningEffort): string {
  return REASONING_OPTIONS.find((option) => option.value === effort)?.label ?? "中";
}

export function ConversationModelMenu(props: {
  providers: Provider[];
  selection: ChatModelSelection | null;
  disabled: boolean;
  saving: boolean;
  onSelection: (selection: ChatModelSelection) => Promise<void>;
}) {
  const { providers, selection, disabled, saving, onSelection } = props;
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<"model" | "reasoning" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        close();
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setSubmenu(null);
    triggerRef.current?.focus();
  }

  async function chooseModel(providerId: string, model: string) {
    const next: ChatModelSelection = { providerId, model, reasoningEffort: selection?.reasoningEffort ?? "medium" };
    await onSelection(next);
    close();
  }
  async function chooseReasoning(effort: ReasoningEffort) {
    if (!selection) return;
    await onSelection({ ...selection, reasoningEffort: effort });
    close();
  }

  const triggerLabel = selection ? `${selection.model} · ${labelFor(selection.reasoningEffort)}` : "选择模型";
  return (
    <div className="conversation-model-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="conversation-model-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || saving}
        onClick={() => { setOpen((current) => !current); setSubmenu(null); }}
      >
        {saving ? "保存中…" : triggerLabel}
      </button>
      {open ? (
        <div className="conversation-model-panel" role="menu">
          <button type="button" role="menuitem" className={submenu === "model" ? "is-active" : ""} onClick={() => setSubmenu(submenu === "model" ? null : "model")}>模型</button>
          <button type="button" role="menuitem" className={submenu === "reasoning" ? "is-active" : ""} onClick={() => setSubmenu(submenu === "reasoning" ? null : "reasoning")}>推理强度</button>
          {submenu === "model" ? (
            <div className="conversation-model-submenu">
              {providers.map((provider) => (
                <div key={provider.id} className="conversation-model-group">
                  <div className="conversation-model-group-title">{provider.name}</div>
                  {provider.models.map((model) => {
                    const usable = Number.isSafeInteger(model.contextWindowTokens) && (model.contextWindowTokens ?? 0) > 0;
                    const active = selection?.providerId === provider.id && selection?.model === model.name;
                    return (
                      <button
                        key={model.name}
                        type="button"
                        role="menuitem"
                        className={active ? "is-selected" : ""}
                        disabled={!usable}
                        title={usable ? undefined : "该模型缺少上下文窗口"}
                        onClick={() => void chooseModel(provider.id, model.name)}
                      >
                        {model.name}{usable ? null : <span>（待补充上下文）</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : null}
          {submenu === "reasoning" ? (
            <div className="conversation-model-submenu">
              {REASONING_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitem"
                  className={selection?.reasoningEffort === option.value ? "is-selected" : ""}
                  disabled={!selection}
                  onClick={() => void chooseReasoning(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
