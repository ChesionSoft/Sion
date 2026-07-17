import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export type DialogProps = {
  open: boolean;
  title: string;
  description?: string;
  size?: "confirm" | "short" | "medium" | "large";
  closeLabel: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
};

export function Dialog({ open, title, description, size = "short", closeLabel, onClose, footer, children }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>("[autofocus], " + FOCUSABLE);
      (first ?? panelRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="ui-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className={`ui-dialog ui-dialog-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <header className="ui-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <IconButton aria-label={closeLabel} onClick={onClose}>×</IconButton>
        </header>
        <div className="ui-dialog-body">{children}</div>
        {footer ? <footer className="ui-dialog-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
