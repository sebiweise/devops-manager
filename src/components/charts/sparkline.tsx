import { useTranslations } from "next-intl";
import { niceMax } from "@/lib/chart-scale";

/**
 * 14-day sparkline of runs per day; the failed share of each day is drawn
 * hatched in the destructive colour. Its aria-label states the totals; the
 * per-day values sit behind a native "Show as table" disclosure, so keyboard
 * and screen-reader users reach them without hovering the SVG tooltips.
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
    <div className="flex flex-col items-start gap-1">
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
                className="fill-status-good"
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
      <SparklineTable points={points} />
    </div>
  );
}

function SparklineTable({
  points,
}: {
  points: ReadonlyArray<{ day: string; runs: number; failures: number }>;
}) {
  const t = useTranslations("charts");
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        {t("showTable")}
      </summary>
      <table className="mt-1 tabular-nums">
        <thead>
          <tr>
            <th scope="col" className="pr-2 text-left font-medium">
              {t("day")}
            </th>
            <th scope="col" className="pr-2 text-right font-medium">
              {t("runs")}
            </th>
            <th scope="col" className="text-right font-medium">
              {t("failure")}
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}>
              <th scope="row" className="pr-2 text-left font-normal">
                {p.day}
              </th>
              <td className="pr-2 text-right">{p.runs}</td>
              <td className="text-right">{p.failures}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
