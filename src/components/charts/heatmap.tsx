import { intensity } from "@/lib/runners-view";
import { cn } from "@/lib/utils";

/** Literal classes so Tailwind sees them; step 0 is "no data". */
const STEPS = [
  "bg-muted",
  "bg-seq-1",
  "bg-seq-2",
  "bg-seq-3",
  "bg-seq-4",
] as const;

export type HeatmapCell = { value: number | null; title: string };

/**
 * Row × column heatmap (e.g. weekday × hour of the queue p95). HTML grid with
 * `role="img"` and an `aria-label`; every cell has a tooltip, the scale has
 * a text legend, and the frame's table view carries the numbers, so the
 * meaning does not depend on colour alone.
 */
export function Heatmap({
  label,
  rows,
  columns,
  cells,
  max,
  scaleLabels,
}: {
  label: string;
  rows: ReadonlyArray<string>;
  /** Column headers; only every sixth is printed. */
  columns: ReadonlyArray<string>;
  cells: ReadonlyArray<ReadonlyArray<HeatmapCell>>;
  max: number;
  /** [no data, low, high] */
  scaleLabels: readonly [string, string, string];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={label}
        className="grid gap-px text-[10px] text-muted-foreground"
        style={{
          gridTemplateColumns: `minmax(1.75rem,auto) repeat(${columns.length}, minmax(0, 1fr))`,
        }}
      >
        <span />
        {columns.map((c, i) => (
          <span key={c} className="text-center" aria-hidden="true">
            {i % 6 === 0 ? c : ""}
          </span>
        ))}
        {rows.map((r, ri) => (
          <div key={r} className="contents">
            <span className="pr-1" aria-hidden="true">
              {r}
            </span>
            {columns.map((c, ci) => {
              const cell = cells[ri]?.[ci];
              const step = intensity(cell?.value ?? null, max);
              return (
                <span
                  key={c}
                  title={cell?.title}
                  className={cn("h-4 rounded-[2px]", STEPS[step])}
                />
              );
            })}
          </div>
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("inline-block size-3 rounded-sm", STEPS[0])}
          />
          {scaleLabels[0]}
        </li>
        <li className="flex items-center gap-1.5">
          {scaleLabels[1]}
          {STEPS.slice(1).map((s) => (
            <span
              key={s}
              aria-hidden="true"
              className={cn("inline-block size-3 rounded-sm", s)}
            />
          ))}
          {scaleLabels[2]}
        </li>
      </ul>
    </div>
  );
}
