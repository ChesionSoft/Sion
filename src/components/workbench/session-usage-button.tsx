"use client";

import { PieChartIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TurnTokenUsage } from "@/lib/project/types";

const SOURCE_LABELS: Record<TurnTokenUsage["source"], string> = {
  exact: "精确",
  estimated: "估算",
  mixed: "含估算",
};

const INPUT_COLOR = "var(--primary)";
const OUTPUT_COLOR = "var(--muted-foreground)";

/**
 * A small donut showing the input/output token split. The output ring is the
 * full circle; the input arc covers `input/total` of it starting at 12 o'clock.
 * With a zero total the chart collapses to a single muted ring.
 */
function UsageDonut({ input, output, total }: { input: number; output: number; total: number }) {
  const inputPct = total > 0 ? (input / total) * 100 : 0;
  return (
    <svg
      aria-label={`输入 ${input} token，输出 ${output} token`}
      className="h-20 w-20 shrink-0"
      role="img"
      viewBox="0 0 36 36"
    >
      <circle cx="18" cy="18" fill="none" r="15.915" strokeWidth="4" style={{ stroke: OUTPUT_COLOR }} />
      <circle
        cx="18"
        cy="18"
        fill="none"
        r="15.915"
        strokeDasharray={`${inputPct} ${100 - inputPct}`}
        strokeWidth="4"
        style={{ stroke: INPUT_COLOR }}
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

/**
 * Session-wide token usage trigger. Styled like the adjacent "新会话" button;
 * clicking opens a popover with a donut chart, the input/output legend, the
 * total, and the source label / call count.
 */
export function SessionUsageButton({ usage }: { usage: TurnTokenUsage }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button className="h-7 gap-1 px-2.5 text-xs" size="sm" type="button" variant="outline" />
        }
      >
        <PieChartIcon className="h-3.5 w-3.5" />
        会话用量
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <p className="mb-2 text-xs font-medium text-muted-foreground">会话用量</p>
        <div className="flex items-center gap-3">
          <UsageDonut input={usage.inputTokens} output={usage.outputTokens} total={usage.totalTokens} />
          <div className="flex flex-col gap-1.5">
            <p className="text-base font-semibold">{usage.totalTokens.toLocaleString()} token</p>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: INPUT_COLOR }} />
              输入 {usage.inputTokens.toLocaleString()}
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: OUTPUT_COLOR }} />
              输出 {usage.outputTokens.toLocaleString()}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="outline">{SOURCE_LABELS[usage.source]}</Badge>
          {usage.callCount > 1 ? <span>· {usage.callCount} 次调用</span> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}