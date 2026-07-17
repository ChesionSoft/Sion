import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { RightTabId } from "../../types";
import { IconButton, Tab, TabList } from "../ui";

export function WorkspaceTabs({
  tabIds,
  activeTabId,
  paneWidth,
  labels,
  dirtyTabIds = [],
  onSelect,
  onClose,
  onClosePane,
  onPaneWidth,
  children,
}: {
  tabIds: RightTabId[];
  activeTabId: RightTabId | null;
  paneWidth: number;
  labels: Record<string, string>;
  dirtyTabIds?: RightTabId[];
  onSelect: (tabId: RightTabId) => void;
  onClose: (tabId: RightTabId) => void;
  onClosePane: () => void;
  onPaneWidth: (width: number) => void;
  children: ReactNode;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  if (tabIds.length === 0) return null;

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
      <div className="workspace-resizer" role="separator" aria-label="调整工作区宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={720} aria-valuenow={paneWidth} tabIndex={0} onKeyDown={resizeWithKeyboard} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} />
      <aside className="workspace-side-pane" style={{ "--workspace-pane-width": `${paneWidth}px` } as React.CSSProperties}>
        <header className="workspace-tabs-header">
          <TabList label="工作区分页">
            {tabIds.map((tabId) => <Tab key={tabId} id={tabId} active={tabId === activeTabId} label={labels[tabId] ?? "页面"} dirty={dirtyTabIds.includes(tabId)} onSelect={() => onSelect(tabId)} onClose={() => onClose(tabId)} />)}
          </TabList>
          <IconButton className="workspace-close-pane" aria-label="关闭工作区面板" onClick={onClosePane}>×</IconButton>
        </header>
        <div className="workspace-tab-panel" id={activeTabId ? `${activeTabId}-panel` : undefined} role="tabpanel" aria-labelledby={activeTabId ? `${activeTabId}-tab` : undefined}>{children}</div>
      </aside>
    </>
  );
}
