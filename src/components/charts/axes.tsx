/** Plot geometry shared by the SVG charts (viewBox units). */
export const PLOT = {
  width: 640,
  height: 220,
  left: 56,
  right: 8,
  top: 8,
  bottom: 24,
} as const;

export const innerWidth = PLOT.width - PLOT.left - PLOT.right;
export const innerHeight = PLOT.height - PLOT.top - PLOT.bottom;

/** Indexes of the x labels to print, at most `max`, always the last one. */
export function labelIndexes(count: number, max = 7): number[] {
  if (count <= 0) return [];
  if (count <= max) return [...Array(count).keys()];
  const step = Math.ceil((count - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  if (out[out.length - 1] !== count - 1) {
    if (count - 1 - out[out.length - 1]! < step / 2) out.pop();
    out.push(count - 1);
  }
  return out;
}

export function YAxis({
  ticks,
  max,
  format,
}: {
  ticks: ReadonlyArray<number>;
  max: number;
  format: (v: number) => string;
}) {
  return (
    <g aria-hidden="true">
      {ticks.map((v) => {
        const y = PLOT.top + innerHeight - (v / max) * innerHeight;
        return (
          <g key={v}>
            <line
              x1={PLOT.left}
              x2={PLOT.width - PLOT.right}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PLOT.left - 6}
              y={y}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground text-[11px]"
            >
              {format(v)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function XLabels({
  labels,
  x,
}: {
  labels: ReadonlyArray<string>;
  x: (i: number) => number;
}) {
  return (
    <g aria-hidden="true">
      {labelIndexes(labels.length).map((i) => (
        <text
          key={i}
          x={x(i)}
          y={PLOT.height - 6}
          // Edge labels are anchored inwards so they are never clipped.
          textAnchor={
            x(i) > PLOT.width - PLOT.right - 28
              ? "end"
              : x(i) < PLOT.left + 28
                ? "start"
                : "middle"
          }
          className="fill-muted-foreground text-[11px]"
        >
          {labels[i]}
        </text>
      ))}
    </g>
  );
}
