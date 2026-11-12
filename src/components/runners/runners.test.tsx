import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ConcurrencyDto,
  PoolDto,
  RunnerDetail,
  UtilisationDto,
} from "@/server/data/runners";
import { bucketOf, emptyHistogram } from "@/server/metrics/histogram";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { StatusBadge } from "@/components/data/status-badge";
import { LabelList, UtilisationMeter } from "./runner-badges";
import {
  ConcurrencyChart,
  DurationVsPoolChart,
  PoolHeatmap,
  RunnerStatusChart,
  RunnerUtilisationChart,
} from "./runner-charts";

/**
 * Runner and queue building blocks (design §6.5, §7): state as text, STUCK
 * and no-matching-runner flags, utilisation with the sample interval or
 * "insufficient samples", and the charts with aria-labels and table views.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : de}
      timeZone="UTC"
      now={new Date("2026-11-11T12:00:00Z")}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const util = (u: Partial<UtilisationDto>): UtilisationDto => ({
  busyS: 0,
  onlineS: 0,
  windowS: 604_800,
  coverage: 0,
  value: null,
  insufficientSamples: true,
  medianSampleIntervalS: null,
  ...u,
});

describe("runner badges", () => {
  it("states the runner state as icon plus text", () => {
    expect(render(<StatusBadge kind="busy" />)).toContain("Busy");
    expect(render(<StatusBadge kind="offline" />)).toContain("Offline");
    expect(render(<StatusBadge kind="idle" />, "de")).toContain("Frei");
  });

  it("shows utilisation as a meter with the sample interval as tooltip", () => {
    const html = render(
      <UtilisationMeter
        u={util({
          value: 0.42,
          coverage: 0.9,
          insufficientSamples: false,
          medianSampleIntervalS: 600,
        })}
      />,
    );
    expect(html).toContain("42%");
    expect(html).toContain('title="± one sample interval (10m 00s)"');
    expect(html).toContain("width:42%");
  });

  it("shows insufficient samples below 50% coverage instead of a number", () => {
    const html = render(
      <UtilisationMeter
        u={util({ value: null, coverage: 0.3, medianSampleIntervalS: 900 })}
      />,
    );
    expect(html).toContain("Insufficient samples");
    expect(html).toContain("± one sample interval (15m 00s)");
    expect(html).not.toContain("%");
    expect(render(<UtilisationMeter u={util({})} />)).toContain(
      "no samples yet",
    );
  });

  it("lists labels, the first ones and +N with max", () => {
    const html = render(<LabelList labels={["self-hosted", "linux"]} />);
    expect(html).toContain("self-hosted");
    expect(render(<LabelList labels={[]} />)).toContain("—");
    const short = render(
      <LabelList labels={["linux", "self-hosted", "x64", "gpu"]} max={2} />,
    );
    expect(short).toContain("+2");
    expect(short).toContain('title="linux, self-hosted, x64, gpu"');
    expect(short).not.toContain(">x64<");
  });
});

const pool: PoolDto = {
  labelKey: "linux,self-hosted",
  labels: ["self-hosted", "linux"],
  runnerKind: "SELF_HOSTED",
  jobs: 12,
  minutes: 90,
  billableMinEst: 0,
  avgConcurrency: 0.4,
  peakConcurrency: 2,
  queueP50: 5,
  queueP95: 300,
  utilisation: null,
  runners: 1,
  heatmap: [
    { weekday: 1, hour: 9, jobs: 4, queueP95: 300 },
    { weekday: 3, hour: 14, jobs: 2, queueP95: 30 },
  ],
};

describe("runner charts", () => {
  it("concurrency: labelled lines with peaks and a table toggle", () => {
    const data: ConcurrencyDto = {
      from: "2026-11-10T12:00:00.000Z",
      to: "2026-11-11T12:00:00.000Z",
      bucketS: 300,
      labelKey: null,
      buckets: [
        {
          t: "2026-11-11T09:00:00.000Z",
          running: 2,
          queued: 1,
          runningAvg: 1.5,
          queuedAvg: 0.5,
        },
        {
          t: "2026-11-11T09:05:00.000Z",
          running: 1,
          queued: 0,
          runningAvg: 1,
          queuedAvg: 0,
        },
      ],
      peakRunning: 2,
      peakQueued: 1,
      avgRunning: 1.25,
    };
    const html = render(<ConcurrencyChart data={data} />);
    expect(html).toContain("<figcaption");
    expect(html).toContain(
      'aria-label="Line chart of running and queued jobs in 5-minute buckets over the last 24 hours; peak 2 running and 1 queued."',
    );
    expect(html).toContain('stroke-dasharray="6 4"');
    expect(html).toContain(">Show as table</button>");
    expect(html).not.toContain("NaN");
  });

  it("heatmap: weekday × hour grid with tooltips and a scale legend", () => {
    const html = render(<PoolHeatmap pool={pool} />);
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="Heatmap of the 95 % queue time of runner group linux,self-hosted by weekday and hour; the longest is 5m 00s."',
    );
    expect(html).toContain('title="Mon 09:00: 4 jobs, queue time 95 % 5m 00s"');
    expect(html).toContain("bg-seq-4");
    expect(html).toContain("no jobs");
  });

  it("daily utilisation leaves out days with insufficient samples", () => {
    const day = (d: string, u: number | null, insufficient: boolean) => ({
      day: d,
      jobs: 1,
      failures: 0,
      infraFailures: 0,
      busyS: 3600,
      onlineS: 7200,
      utilisation: u,
      insufficientSamples: insufficient,
      peakConcurrency: 1,
      p50: 60,
      p95: 90,
      speedIndex: null,
    });
    const html = render(
      <RunnerUtilisationChart
        days={[
          day("2026-11-09", 0.5, false),
          day("2026-11-10", 0.1, true),
          day("2026-11-11", 0.7, false),
        ]}
      />,
    );
    expect(html).toContain("<title>2026-11-09: Utilisation 50%</title>");
    expect(html).not.toContain("<title>2026-11-10:");
  });

  it("status timeline: patterned segments and an empty state", () => {
    const samples: RunnerDetail["statusTimeline"] = [
      {
        t: "2026-11-11T11:00:00.000Z",
        online: true,
        busy: true,
        intervalS: 1800,
      },
      {
        t: "2026-11-11T12:00:00.000Z",
        online: false,
        busy: false,
        intervalS: 1800,
      },
    ];
    const html = render(
      <RunnerStatusChart
        name="runner-1"
        samples={samples}
        from="2026-11-11T10:00:00.000Z"
        to="2026-11-11T12:00:00.000Z"
      />,
    );
    expect(html).toMatch(
      /aria-label="Status of runner runner-1 from [^"]+: busy 25%, idle 0%, offline 25% of the window\."/,
    );
    expect(html).toContain('title="busy"');
    expect(html).toContain('title="offline"');
    const empty = render(
      <RunnerStatusChart
        name="runner-1"
        samples={[]}
        from="2026-11-11T10:00:00.000Z"
        to="2026-11-11T12:00:00.000Z"
      />,
    );
    expect(empty).toContain("No samples in this range.");
  });

  it("duration vs pool: runner solid, pool dashed", () => {
    const runner = emptyHistogram();
    runner[bucketOf(30)] = 3;
    const poolHist = emptyHistogram();
    poolHist[bucketOf(30)] = 3;
    poolHist[bucketOf(600)] = 3;
    const html = render(
      <DurationVsPoolChart
        distribution={{
          runner: { n: 3, p50: 30, p95: 30, hist: runner },
          pool: { n: 6, p50: 300, p95: 600, hist: poolHist },
          labelKey: "linux,self-hosted",
        }}
      />,
    );
    expect(html).toContain("(3 jobs) compared with its runner group (6 jobs)");
    expect(html).toContain("<title>&lt; 1 min: This runner 100%</title>");
    expect(html).toContain("<title>5–15 min: Runner group 50%</title>");
  });
});
