import { useEffect, useRef, useState } from "react";
import type { ChatModelSelection, Provider, ReasoningEffort } from "../../types";
import { selectionIsValid } from "../../conversation-controls";

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

  function openMainMenu() {
    setOpen(true);
    setSubmenu(null);
    window.requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLButtonElement>(".conversation-model-main-panel button")?.focus();
    });
  }

  function openSubmenu(next: "model" | "reasoning", focusFirst = false) {
    setSubmenu(next);
    if (focusFirst) {
      window.requestAnimationFrame(() => {
        containerRef.current?.querySelector<HTMLButtonElement>(".conversation-model-submenu button:not(:disabled)")?.focus();
      });
    }
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const target = event.target as HTMLElement;
    if (event.key === "ArrowRight") {
      const next = target.dataset.submenu as "model" | "reasoning" | undefined;
      if (next) {
        event.preventDefault();
        openSubmenu(next, true);
      }
      return;
    }
    if (event.key === "ArrowLeft" && target.closest(".conversation-model-submenu")) {
      event.preventDefault();
      setSubmenu(null);
      containerRef.current?.querySelector<HTMLButtonElement>(`[data-submenu="${submenu}"]`)?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const menu = target.closest<HTMLElement>('[role="menu"]');
    const buttons = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    const current = buttons.indexOf(target as HTMLButtonElement);
    if (current < 0 || buttons.length === 0) return;
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + offset + buttons.length) % buttons.length]?.focus();
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

  const validSelection = selectionIsValid(selection, providers);
  const triggerLabel = selection
    ? validSelection
      ? `${selection.model} · ${labelFor(selection.reasoningEffort)}`
      : "模型已失效 · 请重新选择"
    : "选择模型";
  return (
    <div className="conversation-model-menu" ref={containerRef} onKeyDown={handleMenuKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="conversation-model-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || saving}
        onClick={() => { if (open) close(); else openMainMenu(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMainMenu();
          }
        }}
      >
        {saving ? "保存中…" : triggerLabel}
      </button>
      {open ? (
        <div className="conversation-model-popover">
          <div className="conversation-model-main-panel" role="menu" aria-label="模型运行参数">
            <button data-submenu="model" type="button" role="menuitem" className={submenu === "model" ? "is-active" : ""} onClick={() => openSubmenu("model")}>
              <span>模型</span><small>{validSelection ? selection?.model : "请选择"}</small><i aria-hidden="true">›</i>
            </button>
            <button data-submenu="reasoning" type="button" role="menuitem" className={submenu === "reasoning" ? "is-active" : ""} onClick={() => openSubmenu("reasoning")}>
              <span>推理强度</span><small>{selection ? labelFor(selection.reasoningEffort) : "中"}</small><i aria-hidden="true">›</i>
            </button>
          </div>
          {submenu === "model" ? (
            <div className="conversation-model-submenu" role="menu" aria-label="选择模型">
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
            <div className="conversation-model-submenu" role="menu" aria-label="选择推理强度">
              {REASONING_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitem"
                  className={selection?.reasoningEffort === option.value ? "is-selected" : ""}
                  disabled={!validSelection}
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
