import { cn } from "@/lib/utils";

/** Literal classes per state: solid, hatched, dotted (not colour alone). */
const STATE_CLASS = {
  busy: "bg-chart-2",
  idle: "bg-chart-1/60 bg-[repeating-linear-gradient(45deg,transparent_0_3px,var(--background)_3px_5px)]",
  offline:
    "bg-muted-foreground/50 bg-[radial-gradient(var(--background)_1px,transparent_1.5px)] bg-[length:4px_4px]",
} as const;

export type StripState = keyof typeof STATE_CLASS;

export type StateSegment = {
  kind: StripState;
  /** Fractions of the window, 0..1. */
  from: number;
  to: number;
};

/**
 * One row of contiguous states over a time window (e.g. a runner's status
 * from its samples). Gaps are unknown and stay empty. HTML with
 * `role="img"`; each segment has a tooltip and the legend names the states.
 */
export function StateStrip({
  label,
  segments,
  stateLabels,
  startLabel,
  endLabel,
}: {
  label: string;
  segments: ReadonlyArray<StateSegment>;
  stateLabels: Record<StripState, string>;
  startLabel: string;
  endLabel: string;
}) {
  const pct = (f: number) => `${Math.min(100, Math.max(0, f * 100))}%`;
  return (
    <div className="flex flex-col gap-1">
      <div
        role="img"
        aria-label={label}
        className="relative h-6 rounded-md bg-muted"
      >
        {segments.map((s, i) => (
          <div
            key={i}
            title={stateLabels[s.kind]}
            className={cn(
              "absolute inset-y-0.5 min-w-px rounded-[2px]",
              STATE_CLASS[s.kind],
            )}
            style={{
              left: pct(s.from),
              width: `calc(${pct(s.to)} - ${pct(s.from)})`,
            }}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="flex justify-between text-[11px] text-muted-foreground"
      >
        <span>{startLabel}</span>
        <span>{endLabel}</span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(Object.keys(STATE_CLASS) as StripState[]).map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("inline-block h-3 w-5 rounded-sm", STATE_CLASS[k])}
            />
            {stateLabels[k]}
          </li>
        ))}
      </ul>
    </div>
  );
}
