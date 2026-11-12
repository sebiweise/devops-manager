import { useTranslations } from "next-intl";
import { niceMax } from "@/lib/chart-scale";

export type SparkPoint = { day: string; runs: number; failures: number };

/**
 * Sparkline of runs per day; the failed share of each day is drawn in the
 * critical status colour with a hatch, so it is not told apart by colour
 * alone. Decorative in a table row (UI overhaul §1.7): `aria-hidden`, with a
 * `<title>` for pointer users. The values are reachable through the
 * table-level TrendTable ("Show trend as table") or the row's own figures.
 */
export function Sparkline({
  id,
  label,
  points,
  width = 84,
  height = 24,
  fill = false,
}: {
  id: string;
  /** Summary for the tooltip, e.g. "112 runs, 4 failed in 14 days". */
  label: string;
  points: ReadonlyArray<SparkPoint>;
  width?: number;
  height?: number;
  /** Stretch to the container width (the viewBox keeps the geometry). */
  fill?: boolean;
}) {
  const max = niceMax(Math.max(0, ...points.map((p) => p.runs)));
  const slot = width / Math.max(1, points.length);
  // A 1px surface gap between bars from 4px slots up.
  const bar = Math.max(1, slot - (slot >= 4 ? 1.5 : 1));
  const h = (v: number) => (v / max) * (height - 2);
  return (
    <svg
      aria-hidden="true"
      width={fill ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fill ? "none" : undefined}
      className="block overflow-visible"
    >
      <title>{label}</title>
      <defs>
        <pattern
          id={`${id}-hatch`}
          width="3"
          height="3"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect
            width="1"
            height="3"
            className="fill-background"
            opacity="0.7"
          />
        </pattern>
      </defs>
      <line
        x1={0}
        x2={width}
        y1={height - 0.5}
        y2={height - 0.5}
        className="stroke-border"
      />
      {points.map((p, i) => {
        const total = h(p.runs);
        const failed = h(Math.min(p.failures, p.runs));
        const x = i * slot;
        return (
          <g key={p.day}>
            <rect
              x={x}
              y={height - total}
              width={bar}
              height={Math.max(0, total - failed)}
              rx={bar >= 4 ? 1 : 0}
              className="fill-series-1"
            />
            {failed > 0 ? (
              <>
                <rect
                  x={x}
                  y={height - failed}
                  width={bar}
                  height={failed}
                  className="fill-status-critical"
                />
                <rect
                  x={x}
                  y={height - failed}
                  width={bar}
                  height={failed}
                  fill={`url(#${id}-hatch)`}
                />
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The table view of a column of sparklines (one toggle per table, UI
 * overhaul §1.7): one row per entity, one column per day, "runs / failed".
 */
export function TrendTable({
  caption,
  rows,
}: {
  caption: string;
  rows: ReadonlyArray<{ key: string; label: string; points: SparkPoint[] }>;
}) {
  const t = useTranslations("charts");
  const days = rows[0]?.points.map((p) => p.day) ?? [];
  if (rows.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="w-fit cursor-pointer text-muted-foreground select-none hover:text-foreground">
        {t("trendTable")}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="pr-3 text-left font-medium">
                {t("trendTableEntity")}
              </th>
              {days.map((d) => (
                <th
                  key={d}
                  scope="col"
                  className="px-1 text-right font-medium whitespace-nowrap"
                >
                  {d.slice(5)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t">
                <th
                  scope="row"
                  className="pr-3 text-left font-normal whitespace-nowrap"
                >
                  {r.label}
                </th>
                {r.points.map((p) => (
                  <td key={p.day} className="px-1 text-right whitespace-nowrap">
                    {p.runs}
                    {p.failures > 0 ? (
                      <span className="text-muted-foreground">
                        {" "}
                        / {p.failures}
                      </span>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-muted-foreground">{t("trendTableHint")}</p>
      </div>
    </details>
  );
}
