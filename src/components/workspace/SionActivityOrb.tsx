import type { CSSProperties } from "react";

/** Compact, phase-specific activity indicator derived only from Sion's real
 * turn lifecycle. The dot arrangements mirror AIcss's orb families while
 * remaining small enough to sit inside a conversation timeline. */
export type SionActivityOrbPhase = "queued" | "thinking" | "reasoning" | "output" | "delivery";

const DOT_COUNT: Record<SionActivityOrbPhase, number> = {
  queued: 8,
  thinking: 3,
  reasoning: 4,
  output: 3,
  delivery: 7,
};

export function SionActivityOrb({ phase }: { phase: SionActivityOrbPhase }) {
  return (
    <span className={`sion-activity-orb is-${phase}`} aria-hidden="true">
      {Array.from({ length: DOT_COUNT[phase] }, (_, index) => (
        <i key={index} style={{ "--orb-index": index } as CSSProperties} />
      ))}
    </span>
  );
}
