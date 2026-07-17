import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { IconButton, Icon } from "../ui";

type RightWorkspacePaneProps = {
  title: string;
  paneWidth: number;
  onClose: () => void;
  onPaneWidth: (width: number) => void;
  children: ReactNode;
};

export function RightWorkspacePane({ title, paneWidth, onClose, onPaneWidth, children }: RightWorkspacePaneProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = { startX: event.clientX, startWidth: paneWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    onPaneWidth(Math.round(dragRef.current.startWidth + dragRef.current.startX - event.clientX));
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === "ArrowLeft" ? paneWidth + 16
      : event.key === "ArrowRight" ? paneWidth - 16
        : event.key === "Home" ? 320
          : event.key === "End" ? 720
            : null;
    if (next === null) return;
    event.preventDefault();
    onPaneWidth(next);
  }

  return (
    <>
      <div
        className="right-workspace-resizer"
        role="separator"
        aria-label="调整工作区宽度"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={720}
        aria-valuenow={paneWidth}
        tabIndex={0}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
      />
      <aside className="right-workspace-pane" style={{ "--workspace-pane-width": `${paneWidth}px` } as React.CSSProperties}>
        <header className="right-workspace-header">
          <h2>{title}</h2>
          <IconButton aria-label="关闭工作区面板" onClick={onClose}><Icon name="close" /></IconButton>
        </header>
        <div className="right-workspace-body">{children}</div>
      </aside>
    </>
  );
}
