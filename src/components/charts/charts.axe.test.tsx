// @vitest-environment jsdom
import axe from "axe-core";
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
 * axe-core over every chart building block as the insights pages render it
 * (design §7, M1 acceptance): no critical or serious violations. Full pages
 * need a session and a database; their charts, tables and sparklines are
 * these components.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <main>
        <h1>Insights</h1>
        {node}
      </main>
    </NextIntlClientProvider>,
  );
}

async function violations(html: string) {
  document.documentElement.lang = "en";
  document.title = "Insights";
  document.body.innerHTML = html;
  const result = await axe.run(document.body, {
    resultTypes: ["violations"],
    // jsdom loads no stylesheet and has no canvas; contrast is a design-token
    // concern, checked in the browser.
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

const days = [
  { x: "11-09", title: "2026-11-09", values: { success: 3, failure: 1 } },
  { x: "11-10", title: "2026-11-10", values: { success: 0, failure: 0 } },
  { x: "11-11", title: "2026-11-11", values: { success: 5, failure: 2 } },
];

describe("charts pass axe", () => {
  it("catches an unlabelled chart (the check itself works)", async () => {
    const html = render(<svg role="img" width={10} height={10} />);
    expect((await violations(html)).join()).toContain("svg-img-alt");
  });

  it("chart frame with stacked bars and a legend", async () => {
    const html = render(
      <ChartFrame
        title="Runs per day"
        description="By conclusion"
        chart={
          <StackedBarChart
            id="a1"
            label="Runs per day, 11 runs"
            points={days}
            series={[
              { key: "success", label: "Success", tone: "success" },
              {
                key: "failure",
                label: "Failure",
                tone: "failure",
                pattern: "hatch",
              },
            ]}
          />
        }
        legend={
          <Legend
            items={[
              { label: "Success", tone: "success", kind: "bar" },
              { label: "Failure", tone: "failure", kind: "bar" },
            ]}
          />
        }
        table={
          <DataTable
            caption="Runs per day"
            columns={["Day", "Success", "Failure"]}
            rows={[["2026-11-09", "3", "1"]]}
          />
        }
      />,
    );
    expect(await violations(html)).toEqual([]);
  });

  it("data table (the table view of every chart)", async () => {
    const html = render(
      <DataTable
        caption="Runs per day"
        columns={["Day", "Success", "Failure"]}
        rows={[
          ["2026-11-09", "3", "1"],
          ["2026-11-10", "0", "0"],
        ]}
      />,
    );
    expect(await violations(html)).toEqual([]);
  });

  it("line chart with a dashed series", async () => {
    const html = render(
      <LineChart
        label="Run duration per day"
        points={[
          { x: "a", title: "a", values: { p50: 10, p95: 20 } },
          { x: "b", title: "b", values: { p50: null, p95: 25 } },
        ]}
        series={[
          { key: "p50", label: "p50", tone: "primary" },
          { key: "p95", label: "p95", tone: "secondary", dash: "dashed" },
        ]}
      />,
    );
    expect(await violations(html)).toEqual([]);
  });

  it("sparklines in table rows, with their table disclosure", async () => {
    const html = render(
      <table>
        <caption>Repositories</caption>
        <thead>
          <tr>
            <th scope="col">Repository</th>
            <th scope="col">Last 14 days</th>
          </tr>
        </thead>
        <tbody>
          {["repo-a", "repo-b"].map((name) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>
                <Sparkline
                  id={`spark-${name}`}
                  label="Runs over the last 14 days: 14 runs, 2 failed."
                  points={[
                    { day: "2026-11-10", runs: 4, failures: 2 },
                    { day: "2026-11-11", runs: 10, failures: 0 },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>,
    );
    expect(await violations(html)).toEqual([]);
  });

  it("run timeline", async () => {
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
    expect(await violations(html)).toEqual([]);
  });

  it("heatmap in a chart frame (M2 queue by weekday and hour)", async () => {
    const html = render(
      <ChartFrame
        title="Queue p95 by weekday and hour"
        chart={
          <Heatmap
            label="Heatmap of the p95 queue time by weekday and hour"
            rows={["Mon", "Tue"]}
            columns={["00", "01", "02"]}
            max={300}
            scaleLabels={["no jobs", "short", "long"]}
            cells={[
              [
                { value: 300, title: "Mon 00:00: 3 jobs, queue p95 5m 00s" },
                { value: null, title: "Mon 01:00: 0 jobs" },
                { value: 30, title: "Mon 02:00: 1 job, queue p95 30s" },
              ],
              [
                { value: null, title: "Tue 00:00: 0 jobs" },
                { value: 10, title: "Tue 01:00: 1 job, queue p95 10s" },
                { value: null, title: "Tue 02:00: 0 jobs" },
              ],
            ]}
          />
        }
        table={
          <DataTable
            caption="Queue p95 by weekday and hour"
            columns={["Weekday", "Hour", "Queue p95"]}
            rows={[["Mon", "00:00", "5m 00s"]]}
          />
        }
      />,
    );
    expect(await violations(html)).toEqual([]);
  });

  it("included-minutes gauge (M2 costs)", async () => {
    const html = render(
      <Gauge
        label="1,500 of 3,000 included minutes used; projected 4,500 by the end of the month."
        usedPct={33}
        projectedPct={100}
        markerPct={67}
        over={false}
        legend={{
          used: "Used: 1,500 min",
          projected: "Projected: 4,500 min",
          marker: "Included: 3,000 min",
        }}
      />,
    );
    expect(await violations(html)).toEqual([]);
  });

  it("runner status strip (M2 runner detail)", async () => {
    const html = render(
      <StateStrip
        label="Status of runner runner-1: busy 25%, idle 50%, offline 25%"
        segments={[
          { kind: "busy", from: 0, to: 0.25 },
          { kind: "idle", from: 0.25, to: 0.75 },
          { kind: "offline", from: 0.75, to: 1 },
        ]}
        stateLabels={{ busy: "busy", idle: "idle", offline: "offline" }}
        startLabel="11/11/26, 10:00"
        endLabel="11/11/26, 12:00"
      />,
    );
    expect(await violations(html)).toEqual([]);
  });
});
