import type { KeyboardEvent, ReactNode } from "react";
import { IconButton } from "./Button";

export function TabList({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!matchesArrow(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']:not([disabled])"));
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 || tabs.length === 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    tabs[(current + delta + tabs.length) % tabs.length].focus();
  }
  return <div className={`ui-tab-list ${className}`.trim()} role="tablist" aria-label={label} onKeyDown={handleKeyDown}>{children}</div>;
}

function matchesArrow(key: string) {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

export function Tab({
  id,
  active,
  label,
  dirty = false,
  onSelect,
  onClose,
}: {
  id: string;
  active: boolean;
  label: string;
  dirty?: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <div className={`ui-tab ${active ? "is-active" : ""}`}>
      <button id={`${id}-tab`} role="tab" aria-selected={active} aria-controls={`${id}-panel`} tabIndex={active ? 0 : -1} onClick={onSelect} type="button">
        {dirty ? <span className="ui-tab-dirty" aria-label="有未保存修改" /> : null}
        <span>{label}</span>
      </button>
      {onClose ? <IconButton className="ui-tab-close" aria-label={`关闭${label}`} onClick={onClose}>×</IconButton> : null}
    </div>
  );
}
