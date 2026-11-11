import { niceMax, stack, ticks } from "@/lib/chart-scale";
import { innerHeight, innerWidth, PLOT, XLabels, YAxis } from "./axes";
import { TONES, type BarPattern, type Tone } from "./tones";

export type BarSeries = {
  key: string;
  label: string;
  tone: Tone;
  pattern?: BarPattern;
};

export type BarPoint = {
  /** Axis label, e.g. "11-04". */
  x: string;
  /** Full label for the tooltip, e.g. "2026-11-04". */
  title: string;
  values: Record<string, number>;
};

/**
 * Stacked bars (one per point), drawn as SVG without animation. `id` makes
 * the pattern ids unique on the page.
 */
export function StackedBarChart({
  id,
  label,
  points,
  series,
  formatY = (v) => String(Math.round(v)),
}: {
  id: string;
  label: string;
  points: ReadonlyArray<BarPoint>;
  series: ReadonlyArray<BarSeries>;
  formatY?: (v: number) => string;
}) {
  const keys = series.map((s) => s.key);
  const totals = points.map((p) =>
    keys.reduce((sum, k) => sum + Math.max(0, p.values[k] ?? 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const slot = innerWidth / Math.max(1, points.length);
  const barWidth = Math.max(1, Math.min(32, slot * 0.7));
  const x = (i: number) => PLOT.left + slot * i + slot / 2;
  const y = (v: number) => PLOT.top + innerHeight - (v / max) * innerHeight;
  const byKey = new Map(series.map((s) => [s.key, s]));

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
      className="h-auto w-full"
    >
      <defs>
        <pattern
          id={`${id}-hatch`}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect
            width="2"
            height="6"
            className="fill-background"
            opacity="0.6"
          />
        </pattern>
        <pattern
          id={`${id}-dots`}
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
        >
          <circle
            cx="2.5"
            cy="2.5"
            r="1"
            className="fill-background"
            opacity="0.7"
          />
        </pattern>
        <pattern
          id={`${id}-cross`}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
        >
          <rect
            width="6"
            height="1.5"
            className="fill-background"
            opacity="0.6"
          />
        </pattern>
      </defs>
      <YAxis ticks={ticks(max)} max={max} format={formatY} />
      {points.map((p, i) => {
        const segments = stack(p.values, keys);
        const tip = `${p.title}: ${series
          .map((s) => `${s.label} ${p.values[s.key] ?? 0}`)
          .join(", ")}`;
        return (
          <g key={p.title}>
            <title>{tip}</title>
            {segments.map((seg) => {
              const s = byKey.get(seg.key)!;
              const top = y(seg.y1);
              const height = Math.max(0, y(seg.y0) - top);
              const rect = {
                x: x(i) - barWidth / 2,
                y: top,
                width: barWidth,
                height,
              };
              return (
                <g key={seg.key}>
                  <rect {...rect} className={TONES[s.tone].fill} />
                  {s.pattern && s.pattern !== "none" ? (
                    <rect {...rect} fill={`url(#${id}-${s.pattern})`} />
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      })}
      <XLabels labels={points.map((p) => p.x)} x={x} />
    </svg>
  );
}
