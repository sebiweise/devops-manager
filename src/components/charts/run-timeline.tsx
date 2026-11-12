import type { Segment, SegmentKind } from "@/lib/chart-scale";
import { cn } from "@/lib/utils";

export type TimelineRow = {
  id: string;
  name: string;
  /** e.g. "success · runner-1" */
  detail: string;
  segments: ReadonlyArray<Segment>;
  critical: boolean;
};

const SEGMENT_CLASS: Record<SegmentKind, string> = {
  queue:
    "bg-muted-foreground/50 bg-[radial-gradient(var(--background)_1px,transparent_1.5px)] bg-[length:4px_4px]",
  wait: "bg-series-2 bg-[repeating-linear-gradient(45deg,transparent_0_3px,var(--background)_3px_5px)]",
  run: "bg-series-1",
};

/**
 * Gantt-style timeline of the jobs of one attempt: queue (dotted), approval
 * wait (hatched) and execution (solid) per job. HTML instead of SVG so long
 * job names wrap and the chart stays responsive.
 */
export function RunTimeline({
  label,
  rows,
  spanS,
  kindLabels,
  criticalLabel,
  formatS,
}: {
  label: string;
  rows: ReadonlyArray<TimelineRow>;
  spanS: number;
  kindLabels: Record<SegmentKind, string>;
  criticalLabel: string;
  formatS: (s: number) => string;
}) {
  const span = Math.max(1, spanS);
  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / span) * 100))}%`;
  return (
    <div role="img" aria-label={label} className="flex flex-col gap-1">
      {rows.map((row) => (
        <div
          key={row.id}
          className="grid grid-cols-1 items-center gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,14rem)_1fr]"
        >
          <div className="min-w-0 text-xs">
            <div
              className={cn(
                "truncate font-medium",
                row.critical && "underline decoration-2 underline-offset-2",
              )}
              title={row.name}
            >
              {row.name}
            </div>
            <div className="truncate text-muted-foreground">
              {row.detail}
              {row.critical ? ` · ${criticalLabel}` : ""}
            </div>
          </div>
          <div className="relative h-5 rounded-sm bg-muted">
            {row.segments.map((seg, i) => (
              <div
                key={i}
                title={`${kindLabels[seg.kind]}: ${formatS(seg.to - seg.from)}`}
                className={cn(
                  "absolute inset-y-0.5 min-w-px rounded-[2px]",
                  SEGMENT_CLASS[seg.kind],
                )}
                style={{
                  left: pct(seg.from),
                  width: `calc(${pct(seg.to)} - ${pct(seg.from)})`,
                }}
              />
            ))}
          </div>
        </div>
      ))}
      <div
        aria-hidden="true"
        className="grid grid-cols-1 text-[11px] text-muted-foreground sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-x-3"
      >
        <span className="hidden sm:block" />
        <div className="flex justify-between">
          <span>0s</span>
          <span>{formatS(span / 2)}</span>
          <span>{formatS(span)}</span>
        </div>
      </div>
    </div>
  );
}

/** Legend swatches of the timeline, matching SEGMENT_CLASS. */
export function TimelineLegend({
  kindLabels,
}: {
  kindLabels: Record<SegmentKind, string>;
}) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {(Object.keys(SEGMENT_CLASS) as SegmentKind[]).map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("inline-block h-3 w-5 rounded-sm", SEGMENT_CLASS[k])}
          />
          {kindLabels[k]}
        </li>
      ))}
    </ul>
  );
}
