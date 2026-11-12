import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { ChartFrame } from "./chart-frame";
import { DataTable } from "./data-table";
import { Gauge } from "./gauge";
import { Heatmap } from "./heatmap";
import { Legend } from "./legend";
import { LineChart } from "./line-chart";
import { RunTimeline } from "./run-timeline";
import { Sparkline } from "./sparkline";
import { StackedBarChart } from "./stacked-bar-chart";
import { StateStrip } from "./state-strip";

/**
 * Accessibility contract of the charts (design §7): role="img" with an
 * aria-label, a figure with a figcaption, a "Show as table" toggle, text
 * legends, and patterns or dashes so meaning does not depend on colour.
 */

const days = [
  { x: "11-09", title: "2026-11-09", values: { success: 3, failure: 1 } },
  { x: "11-10", title: "2026-11-10", values: { success: 0, failure: 0 } },
  { x: "11-11", title: "2026-11-11", values: { success: 5, failure: 2 } },
];

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("StackedBarChart", () => {
  const html = render(
    <StackedBarChart
      id="t1"
      label="Runs per day"
      points={days}
      series={[
        { key: "success", label: "Success", tone: "success" },
        { key: "failure", label: "Failure", tone: "failure", pattern: "hatch" },
      ]}
    />,
  );

  it("is an image with an aria-label and per-bar tooltips", () => {
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Runs per day"');
    expect(html).toContain("<title>2026-11-11: Success 5, Failure 2</title>");
  });

  it("overlays a pattern on patterned series and has no NaN geometry", () => {
    expect(html).toContain('fill="url(#t1-hatch)"');
    expect(html).not.toContain("NaN");
  });

  it("renders an empty data set without errors", () => {
    const empty = render(
      <StackedBarChart
        id="t2"
        label="Empty"
        points={[]}
        series={[{ key: "success", label: "Success", tone: "success" }]}
      />,
    );
    expect(empty).toContain('aria-label="Empty"');
    expect(empty).not.toContain("NaN");
  });
});

describe("LineChart", () => {
  it("breaks at missing values and dashes secondary series", () => {
    const html = render(
      <LineChart
        label="Duration"
        points={[
          { x: "a", title: "a", values: { p50: 10, p95: 20 } },
          { x: "b", title: "b", values: { p50: null, p95: 25 } },
          { x: "c", title: "c", values: { p50: 12, p95: 30 } },
        ]}
        series={[
          { key: "p50", label: "p50", tone: "primary" },
          { key: "p95", label: "p95", tone: "secondary", dash: "dashed" },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Duration"');
    expect(html).toContain('stroke-dasharray="6 4"');
    // Two "M" commands: the p50 line restarts after the gap.
    const p50 = /<path d="([^"]+)"/.exec(html)![1]!;
    expect(p50.match(/M/g)).toHaveLength(2);
    expect(html).not.toContain("NaN");
  });
});

describe("Sparkline and RunTimeline", () => {
  it("labels the sparkline with its totals", () => {
    const html = render(
      <Sparkline
        id="s1"
        label="14 runs, 2 failed"
        points={[
          { day: "2026-11-10", runs: 4, failures: 2 },
          { day: "2026-11-11", runs: 10, failures: 0 },
        ]}
      />,
    );
    expect(html).toContain('aria-label="14 runs, 2 failed"');
    expect(html).toContain('fill="url(#s1-hatch)"');
  });

  it("offers the per-day values as a table disclosure", () => {
    const html = render(
      <Sparkline
        id="s2"
        label="4 runs, 2 failed"
        points={[{ day: "2026-11-10", runs: 4, failures: 2 }]}
      />,
    );
    expect(html).toContain("<details");
    expect(html).toContain(">Show as table</summary>");
    expect(html).toContain(
      '<th scope="row" class="pr-2 text-left font-normal">2026-11-10</th>',
    );
  });

  it("positions timeline segments in percent of the span", () => {
    const html = render(
      <RunTimeline
        label="Timeline of 1 job"
        rows={[
          {
            id: "1",
            name: "build",
            detail: "success · runner-1",
            critical: true,
            segments: [
              { kind: "queue", from: 0, to: 25 },
              { kind: "run", from: 25, to: 100 },
            ],
          },
        ]}
        spanS={100}
        kindLabels={{ queue: "Queue", wait: "Approval wait", run: "Execution" }}
        criticalLabel="critical path"
        formatS={(s) => `${s}s`}
      />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Timeline of 1 job"');
    expect(html).toContain("left:25%");
    expect(html).toContain("critical path");
  });
});

describe("ChartFrame", () => {
  const html = render(
    <ChartFrame
      title="Runs per day"
      description="By conclusion"
      chart={<svg role="img" aria-label="chart" />}
      legend={
        <Legend
          items={[
            { label: "Success", tone: "success", kind: "bar" },
            { label: "p95", tone: "secondary", kind: "line", dash: "dashed" },
          ]}
        />
      }
      table={
        <DataTable caption="Runs per day" columns={["Day"]} rows={[["x"]]} />
      }
    />,
  );

  it("wraps the chart in a captioned figure with a table toggle", () => {
    expect(html).toMatch(/<figure[^>]*aria-labelledby="[^"]+"/);
    expect(html).toContain("<figcaption");
    expect(html).toContain("Runs per day");
    expect(html).toContain(">Show as table</button>");
    expect(html).toContain('aria-pressed="false"');
  });

  it("shows the chart and a text legend first, not the table", () => {
    expect(html).toContain('aria-label="chart"');
    expect(html).toContain("Success");
    expect(html).not.toContain("<table");
  });
});

describe("Heatmap, Gauge and StateStrip (M2)", () => {
  it("heatmap cells carry tooltips and intensity steps, empty cells stay muted", () => {
    const html = render(
      <Heatmap
        label="Queue heatmap"
        rows={["Mon"]}
        columns={["00", "01"]}
        max={100}
        scaleLabels={["no jobs", "short", "long"]}
        cells={[
          [
            { value: 100, title: "Mon 00:00" },
            { value: null, title: "Mon 01:00" },
          ],
        ]}
      />,
    );
    expect(html).toContain('aria-label="Queue heatmap"');
    expect(html).toContain(
      'title="Mon 00:00" class="h-4 rounded-[2px] bg-seq-4"',
    );
    expect(html).toContain(
      'title="Mon 01:00" class="h-4 rounded-[2px] bg-muted"',
    );
    expect(html).toContain("no jobs");
  });

  it("gauge positions used, projection and the included marker", () => {
    const html = render(
      <Gauge
        label="gauge"
        usedPct={25}
        projectedPct={75}
        markerPct={50}
        over={false}
        legend={{ used: "Used", projected: "Projected", marker: "Included" }}
      />,
    );
    expect(html).toContain('aria-label="gauge"');
    expect(html).toContain("width:25%");
    expect(html).toContain("left:25%;width:50%");
    expect(html).toContain("left:calc(50% - 1px)");
    expect(html).toContain("Included");
  });

  it("state strip positions segments and names every state", () => {
    const html = render(
      <StateStrip
        label="status"
        segments={[{ kind: "busy", from: 0.5, to: 1 }]}
        stateLabels={{ busy: "busy", idle: "idle", offline: "offline" }}
        startLabel="a"
        endLabel="b"
      />,
    );
    expect(html).toContain('aria-label="status"');
    expect(html).toContain("left:50%");
    expect(html).toContain('title="busy"');
    expect(html).toContain(">idle</li>");
    expect(html).toContain(">offline</li>");
  });
});
