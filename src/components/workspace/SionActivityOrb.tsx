import type { CSSProperties } from "react";

/** Compact C2 ring indicator derived only from Sion's real turn lifecycle.
 * The phase remains semantic for callers, while every live state deliberately
 * uses the same calm AIcss C2 pulse instead of changing its geometry. */
export type SionActivityOrbPhase = "queued" | "thinking" | "reasoning" | "output" | "delivery";

const DOT_COUNT: Record<SionActivityOrbPhase, number> = {
  queued: 8,
  thinking: 8,
  reasoning: 8,
  output: 8,
  delivery: 8,
};

export function SionActivityOrb({ phase }: { phase: SionActivityOrbPhase }) {
  return (
    <span className={`sion-activity-orb is-${phase}`} aria-hidden="true">
      {Array.from({ length: DOT_COUNT[phase] }, (_, index) => (
        <i
          key={index}
          style={{ "--orb-delay": `${-((7 - index) / 8) * 2000}ms` } as CSSProperties}
        />
      ))}
    </span>
  );
}
