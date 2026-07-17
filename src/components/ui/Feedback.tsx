import type { ReactNode } from "react";
import { Button, IconButton } from "./Button";

export type NoticeKind = "success" | "warning" | "error";

export function Notice({ kind, children, onDismiss }: { kind: NoticeKind; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`ui-notice ui-notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <StatusDot kind={kind} />
      <div className="ui-notice-copy">{children}</div>
      {onDismiss ? <IconButton aria-label="关闭通知" onClick={onDismiss}>×</IconButton> : null}
    </div>
  );
}

export function StatusDot({ kind = "neutral", label }: { kind?: NoticeKind | "neutral" | "running"; label?: string }) {
  return <span className={`ui-status-dot ui-status-${kind}`} aria-label={label} role={label ? "img" : undefined} />;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <section className="ui-empty-state">
      <span className="ui-empty-mark" aria-hidden="true">◇</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <Button variant="primary" onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}
