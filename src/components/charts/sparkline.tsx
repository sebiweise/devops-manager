import { niceMax } from "@/lib/chart-scale";

/**
 * 14-day sparkline of runs per day; the failed share of each day is drawn
 * hatched in the destructive colour. It sits in a table row whose cells
 * hold the same numbers, and its aria-label states the totals.
 */
export function Sparkline({
  id,
  label,
  points,
}: {
  id: string;
  label: string;
  points: ReadonlyArray<{ day: string; runs: number; failures: number }>;
}) {
  const width = 84;
  const height = 24;
  const max = niceMax(Math.max(0, ...points.map((p) => p.runs)));
  const slot = width / Math.max(1, points.length);
  const bar = Math.max(1, slot - 1);
  const h = (v: number) => (v / max) * (height - 2);
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
    >
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
            <title>{`${p.day}: ${p.runs} / ${p.failures}`}</title>
            <rect
              x={x}
              y={height - total}
              width={bar}
              height={total - failed}
              className="fill-chart-2"
            />
            {failed > 0 ? (
              <>
                <rect
                  x={x}
                  y={height - failed}
                  width={bar}
                  height={failed}
                  className="fill-destructive"
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
