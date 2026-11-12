import { cn } from "@/lib/utils";

/**
 * Horizontal meter: the used amount (solid), the month-end projection
 * (hatched) and a marker at the included amount. HTML with `role="img"` and
 * an `aria-label` that states all three numbers; the text legend repeats the
 * patterns, so the meaning does not depend on colour alone.
 */
export function Gauge({
  label,
  usedPct,
  projectedPct,
  markerPct,
  over,
  legend,
}: {
  label: string;
  usedPct: number;
  projectedPct: number;
  /** Position of the "included" marker, or null without one. */
  markerPct: number | null;
  /** Used is above the marker: the bar turns destructive (and stays labelled). */
  over: boolean;
  legend: { used: string; projected: string; marker: string | null };
}) {
  const clamp = (v: number) => `${Math.min(100, Math.max(0, v))}%`;
  const projectedWidth = Math.max(0, projectedPct - usedPct);
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={label}
        className="relative h-6 overflow-hidden rounded-md bg-muted"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0",
            over ? "bg-status-critical" : "bg-series-1",
          )}
          style={{ width: clamp(usedPct) }}
        />
        {projectedWidth > 0 ? (
          <div
            className="absolute inset-y-0 bg-series-1/40 bg-[repeating-linear-gradient(45deg,transparent_0_3px,var(--background)_3px_5px)]"
            style={{ left: clamp(usedPct), width: clamp(projectedWidth) }}
          />
        ) : null}
        {markerPct != null ? (
          <div
            className="absolute inset-y-0 w-0.5 bg-foreground"
            style={{ left: `calc(${clamp(markerPct)} - 1px)` }}
          />
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "inline-block size-3 rounded-sm",
              over ? "bg-status-critical" : "bg-series-1",
            )}
          />
          {legend.used}
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-3 rounded-sm bg-series-1/40 bg-[repeating-linear-gradient(45deg,transparent_0_2px,var(--background)_2px_3px)]"
          />
          {legend.projected}
        </li>
        {legend.marker ? (
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-0.5 bg-foreground"
            />
            {legend.marker}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
