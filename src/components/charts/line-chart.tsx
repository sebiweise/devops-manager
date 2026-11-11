import { linePath, niceMax, ticks } from "@/lib/chart-scale";
import { innerHeight, innerWidth, PLOT, XLabels, YAxis } from "./axes";
import { DASHES, TONES, type Dash, type Tone } from "./tones";

export type LineSeries = {
  key: string;
  label: string;
  tone: Tone;
  dash?: Dash;
};

export type LinePoint = {
  x: string;
  title: string;
  values: Record<string, number | null>;
};

/** Lines with gaps for missing values; every point has a tooltip. */
export function LineChart({
  label,
  points,
  series,
  formatY = (v) => String(Math.round(v)),
  maxY,
}: {
  label: string;
  points: ReadonlyArray<LinePoint>;
  series: ReadonlyArray<LineSeries>;
  formatY?: (v: number) => string;
  /** Fixed top of the scale (e.g. 1 for rates). */
  maxY?: number;
}) {
  const all = points.flatMap((p) =>
    series.map((s) => p.values[s.key]).filter((v): v is number => v != null),
  );
  const max = maxY ?? niceMax(Math.max(0, ...all));
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
  const x = (i: number) =>
    points.length > 1 ? PLOT.left + step * i : PLOT.left + innerWidth / 2;
  const y = (v: number) =>
    PLOT.top + innerHeight - (Math.min(v, max) / max) * innerHeight;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
      className="h-auto w-full"
    >
      <YAxis ticks={ticks(max)} max={max} format={formatY} />
      {series.map((s) => (
        <g key={s.key}>
          <path
            d={linePath(
              points.map((p) => p.values[s.key] ?? null),
              x,
              y,
            )}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={DASHES[s.dash ?? "solid"]}
            className={TONES[s.tone].stroke}
          />
          {points.map((p, i) => {
            const v = p.values[s.key];
            if (v == null) return null;
            return (
              <circle
                key={p.title}
                cx={x(i)}
                cy={y(v)}
                r={points.length > 60 ? 1.5 : 3}
                className={TONES[s.tone].fill}
              >
                <title>{`${p.title}: ${s.label} ${formatY(v)}`}</title>
              </circle>
            );
          })}
        </g>
      ))}
      <XLabels labels={points.map((p) => p.x)} x={x} />
    </svg>
  );
}
