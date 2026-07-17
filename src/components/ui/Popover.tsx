import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { shouldClosePopoverAfterAction } from "./popover-state";

export function Popover({
  label,
  trigger,
  children,
  align = "end",
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  return (
    <div className="ui-popover" ref={rootRef}>
      <Button variant="ghost" aria-label={label} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>{trigger}</Button>
      {open ? <div className={`ui-popover-panel ui-popover-${align}`} id={panelId} onClickCapture={(event) => { if (shouldClosePopoverAfterAction(event.target)) setOpen(false); }}>{children}</div> : null}
    </div>
  );
}
