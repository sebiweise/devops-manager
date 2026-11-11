// @vitest-environment jsdom
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { ChartFrame } from "./chart-frame";
import { DataTable } from "./data-table";
import { Legend } from "./legend";
import { LineChart } from "./line-chart";
import { RunTimeline } from "./run-timeline";
import { Sparkline } from "./sparkline";
import { StackedBarChart } from "./stacked-bar-chart";

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
});
