import { getLocale, getTranslations } from "next-intl/server";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DataTable } from "@/components/charts/data-table";
import { Legend } from "@/components/charts/legend";
import { LineChart, type LineSeries } from "@/components/charts/line-chart";
import {
  StackedBarChart,
  type BarSeries,
} from "@/components/charts/stacked-bar-chart";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { bucketOf, type RangeBucket } from "@/lib/range";
import type { DayPoint } from "@/server/data/insights";

/**
 * Charts shared by the overview and the workflow page. Each one is a
 * ChartFrame: figure, caption, aria-label, legend (none for one series)
 * and a table toggle. Points follow the range's bucket (UI overhaul §1.11):
 * days for 7 and 30 days, weeks for 90 days, months for 12 months; the
 * caption names the bucket and ticks are formatted per locale. Counts are
 * summed per bucket; durations of a week or month are the run-weighted
 * mean of the daily values and therefore marked approximate.
 */

type ChartBucket = Exclude<RangeBucket, "hour">;

type Props = {
  id: string;
  days: ReadonlyArray<DayPoint>;
  approx?: boolean;
  bucket?: RangeBucket;
};

const asChartBucket = (b: RangeBucket | undefined): ChartBucket =>
  !b || b === "hour" ? "day" : b;

/** Daily points summed (counts) or run-weighted (durations) per bucket. */
export function toChartPoints(
  days: ReadonlyArray<DayPoint>,
  bucket: ChartBucket,
): DayPoint[] {
  if (bucket === "day") return [...days];
  const out = new Map<string, DayPoint & { _w: Record<string, number> }>();
  for (const d of days) {
    const key = bucketOf(d.day, bucket);
    const acc = out.get(key) ?? {
      day: key,
      runs: 0,
      success: 0,
      failure: 0,
      cancelled: 0,
      other: 0,
      successRate: null,
      p50: null,
      p95: null,
      queueP95: null,
      billableMinEst: 0,
      _w: { p50: 0, p95: 0, queueP95: 0 },
    };
    acc.runs += d.runs;
    acc.success += d.success;
    acc.failure += d.failure;
    acc.cancelled += d.cancelled;
    acc.other += d.other;
    acc.billableMinEst += d.billableMinEst;
    for (const k of ["p50", "p95", "queueP95"] as const) {
      const v = d[k];
      if (v == null || d.runs === 0) continue;
      acc[k] = (acc[k] ?? 0) + v * d.runs;
      acc._w[k] = (acc._w[k] ?? 0) + d.runs;
    }
    out.set(key, acc);
  }
  return [...out.values()].map(({ _w, ...p }) => ({
    ...p,
    successRate:
      p.success + p.failure > 0 ? p.success / (p.success + p.failure) : null,
    p50: p.p50 != null && _w.p50 ? p.p50 / _w.p50 : null,
    p95: p.p95 != null && _w.p95 ? p.p95 / _w.p95 : null,
    queueP95:
      p.queueP95 != null && _w.queueP95 ? p.queueP95 / _w.queueP95 : null,
  }));
}

/** Tick and table labels: "12 Nov" / "12. Nov.", months as "Nov 2026". */
function labeller(locale: string, bucket: ChartBucket) {
  const fmt = new Intl.DateTimeFormat(
    locale,
    bucket === "month"
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { day: "numeric", month: "short", timeZone: "UTC" },
  );
  return (day: string) => fmt.format(new Date(`${day}T00:00:00.000Z`));
}

async function setup(props: Props) {
  const [t, locale] = await Promise.all([
    getTranslations("charts"),
    getLocale(),
  ]);
  const bucket = asChartBucket(props.bucket);
  const points = toChartPoints(props.days, bucket);
  const label = labeller(locale, bucket);
  const coarse = bucket !== "day";
  return { t, locale, bucket, points, label, coarse };
}

export async function RunsPerDayChart(props: Props) {
  const { t, locale, bucket, points, label } = await setup(props);
  const series: BarSeries[] = [
    { key: "success", label: t("success"), tone: "success" },
    { key: "failure", label: t("failure"), tone: "failure", pattern: "hatch" },
    {
      key: "cancelled",
      label: t("cancelled"),
      tone: "cancelled",
      pattern: "dots",
    },
    { key: "other", label: t("other"), tone: "other", pattern: "cross" },
  ];
  const total = points.reduce((s, d) => s + d.runs, 0);
  const title = t("runsPer.title", { bucket });
  return (
    <ChartFrame
      title={title}
      description={t("runsPerDay.description")}
      chart={
        <StackedBarChart
          id={props.id}
          label={t("runsPer.label", { bucket, n: points.length, runs: total })}
          series={series}
          points={points.map((d) => ({
            x: label(d.day),
            title: label(d.day),
            values: {
              success: d.success,
              failure: d.failure,
              cancelled: d.cancelled,
              other: d.other,
            },
          }))}
        />
      }
      legend={
        <Legend
          items={series.map((s) => ({
            label: s.label,
            tone: s.tone,
            kind: "bar" as const,
            pattern: s.pattern,
          }))}
        />
      }
      table={
        <DataTable
          caption={title}
          columns={[
            t(`bucketName.${bucket}`),
            t("runs"),
            ...series.map((s) => s.label),
            t("successRate"),
          ]}
          rows={points.map((d) => [
            label(d.day),
            formatNumber(d.runs, locale),
            formatNumber(d.success, locale),
            formatNumber(d.failure, locale),
            formatNumber(d.cancelled, locale),
            formatNumber(d.other, locale),
            formatPercent(d.successRate, locale),
          ])}
        />
      }
    />
  );
}

export async function DurationChart(props: Props) {
  const { t, bucket, points, label, coarse } = await setup(props);
  const isApprox = (props.approx ?? false) || coarse;
  const series: LineSeries[] = [
    { key: "p50", label: t("p50"), tone: "primary" },
    { key: "p95", label: t("p95"), tone: "secondary", dash: "dashed" },
  ];
  const title = t("duration.title");
  return (
    <ChartFrame
      title={title}
      description={t("durationPer.description", { bucket })}
      chart={
        <LineChart
          label={t("durationPer.label", { bucket, n: points.length })}
          series={series}
          formatY={formatDuration}
          points={points.map((d) => ({
            x: label(d.day),
            title: label(d.day),
            values: { p50: d.p50, p95: d.p95 },
          }))}
        />
      }
      legend={
        <Legend
          items={series.map((s) => ({
            label: s.label,
            tone: s.tone,
            kind: "line" as const,
            dash: s.dash,
          }))}
        />
      }
      table={
        <DataTable
          caption={title}
          columns={[t(`bucketName.${bucket}`), t("p50"), t("p95")]}
          rows={points.map((d) => [
            label(d.day),
            approx(formatDuration(d.p50), isApprox),
            approx(formatDuration(d.p95), isApprox),
          ])}
        />
      }
    />
  );
}

/** One series: the caption names it, so there is no legend. */
export async function QueueChart(props: Props) {
  const { t, bucket, points, label, coarse } = await setup(props);
  const isApprox = (props.approx ?? false) || coarse;
  const series: LineSeries[] = [
    { key: "queueP95", label: t("queueP95"), tone: "tertiary" },
  ];
  const title = t("queue.title");
  return (
    <ChartFrame
      title={title}
      description={t("queuePer.description", { bucket })}
      chart={
        <LineChart
          label={t("queuePer.label", { bucket, n: points.length })}
          series={series}
          formatY={formatDuration}
          points={points.map((d) => ({
            x: label(d.day),
            title: label(d.day),
            values: { queueP95: d.queueP95 },
          }))}
        />
      }
      table={
        <DataTable
          caption={title}
          columns={[t(`bucketName.${bucket}`), t("queueP95")]}
          rows={points.map((d) => [
            label(d.day),
            approx(formatDuration(d.queueP95), isApprox),
          ])}
        />
      }
    />
  );
}

/** One series: no legend. */
export async function SuccessRateChart(props: Props) {
  const { t, locale, bucket, points, label } = await setup(props);
  const series: LineSeries[] = [
    { key: "rate", label: t("successRate"), tone: "primary" },
  ];
  const title = t("successChart.title");
  return (
    <ChartFrame
      title={title}
      description={t("successPer.description", { bucket })}
      chart={
        <LineChart
          label={t("successPer.label", { bucket, n: points.length })}
          series={series}
          maxY={1}
          formatY={(v) => formatPercent(v, locale, 0)}
          points={points.map((d) => ({
            x: label(d.day),
            title: label(d.day),
            values: { rate: d.successRate },
          }))}
        />
      }
      table={
        <DataTable
          caption={title}
          columns={[t(`bucketName.${bucket}`), t("runs"), t("successRate")]}
          rows={points.map((d) => [
            label(d.day),
            formatNumber(d.runs, locale),
            formatPercent(d.successRate, locale),
          ])}
        />
      }
    />
  );
}

/** One series: no legend. */
export async function MinutesChart(props: Props) {
  const { t, locale, bucket, points, label } = await setup(props);
  const series: BarSeries[] = [
    { key: "minutes", label: t("minutes"), tone: "secondary" },
  ];
  const total = points.reduce((s, d) => s + d.billableMinEst, 0);
  const title = t("minutesChart.title");
  return (
    <ChartFrame
      title={title}
      description={t("minutesChart.description")}
      chart={
        <StackedBarChart
          id={props.id}
          label={t("minutesPer.label", {
            bucket,
            n: points.length,
            minutes: formatMinutes(total, locale),
          })}
          series={series}
          formatY={(v) => formatNumber(v, locale)}
          points={points.map((d) => ({
            x: label(d.day),
            title: label(d.day),
            values: { minutes: Math.round(d.billableMinEst) },
          }))}
        />
      }
      table={
        <DataTable
          caption={title}
          columns={[t(`bucketName.${bucket}`), t("minutes")]}
          rows={points.map((d) => [
            label(d.day),
            formatMinutes(d.billableMinEst, locale),
          ])}
        />
      }
    />
  );
}
