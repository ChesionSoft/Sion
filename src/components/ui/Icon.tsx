import type { ReactNode, SVGProps } from "react";
import type { IconName } from "../../workspace-config.ts";

export function Icon({
  name,
  size = 16,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  const paths = {
    projects: <path d="M3.5 6.5h6l2 2h9v10h-17z" />,
    export: <><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5M4 19h16" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
    "project-document": <><path d="M5 3.5h9l5 5v12H5z" /><path d="M14 3.5v5h5M8 13h8M8 17h6" /></>,
    delivery: <><path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4" /><path d="m9 14 2 2 4-5" /></>,
    agent: <><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M9 12h.01M15 12h.01M8 8 6 6M16 8l2-2" /></>,
    "file-pool": <><path d="M3.5 6.5h6l2 2h9v10h-17z" /><path d="M8 13h8M12 10v6" /></>,
    "chat-history": <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h6" /></>,
    "run-history": <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" /></>,
    "sidebar-collapse": <path d="m14 6-6 6 6 6" />,
    "sidebar-expand": <path d="m10 6 6 6-6 6" />,
    back: <><path d="m10 6-6 6 6 6" /><path d="M4 12h16" /></>,
    close: <path d="m7 7 10 10M17 7 7 17" />,
  } satisfies Record<IconName, ReactNode>;
  return (
    <svg
      className={`ui-icon ${className ?? ""}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
