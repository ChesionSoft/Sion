"use client";

import Link from "next/link";
import { FileDownIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ExportPanel({ projectId }: { projectId: string }) {
  return (
    <Link
      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      href={`/projects/${projectId}/exports`}
    >
      <FileDownIcon data-icon="inline-start" />
      导出中心
    </Link>
  );
}
