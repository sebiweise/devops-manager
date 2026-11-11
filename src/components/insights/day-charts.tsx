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
import type { DayPoint } from "@/server/data/insights";

/**
 * Per-day charts shared by the overview and the workflow page. Each one is
 * a ChartFrame: figure, caption, aria-label, legend and a table toggle.
 */

const shortDay = (day: string) => day.slice(5);

type Props = { id: string; days: ReadonlyArray<DayPoint>; approx?: boolean };

export async function RunsPerDayChart({ id, days }: Props) {
  const t = await getTranslations("charts");
  const locale = await getLocale();
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
  const total = days.reduce((s, d) => s + d.runs, 0);
  const title = t("runsPerDay.title");
  return (
    <ChartFrame
      title={title}
      description={t("runsPerDay.description")}
      chart={
        <StackedBarChart
          id={id}
          label={t("runsPerDay.label", { days: days.length, runs: total })}
          series={series}
          points={days.map((d) => ({
            x: shortDay(d.day),
            title: d.day,
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
            t("day"),
            t("runs"),
            ...series.map((s) => s.label),
            t("successRate"),
          ]}
          rows={days.map((d) => [
            d.day,
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

export async function DurationChart({ days, approx: isApprox = false }: Props) {
  const t = await getTranslations("charts");
  const series: LineSeries[] = [
    { key: "p50", label: t("p50"), tone: "primary" },
    { key: "p95", label: t("p95"), tone: "secondary", dash: "dashed" },
  ];
  const title = t("duration.title");
  return (
    <ChartFrame
      title={title}
      description={t("duration.description")}
      chart={
        <LineChart
          label={t("duration.label", { days: days.length })}
          series={series}
          formatY={formatDuration}
          points={days.map((d) => ({
            x: shortDay(d.day),
            title: d.day,
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
          columns={[t("day"), t("p50"), t("p95")]}
          rows={days.map((d) => [
            d.day,
            approx(formatDuration(d.p50), isApprox),
            approx(formatDuration(d.p95), isApprox),
          ])}
        />
      }
    />
  );
}

export async function QueueChart({ days, approx: isApprox = false }: Props) {
  const t = await getTranslations("charts");
  const series: LineSeries[] = [
    { key: "queueP95", label: t("queueP95"), tone: "tertiary", dash: "dotted" },
  ];
  const title = t("queue.title");
  return (
    <ChartFrame
      title={title}
      description={t("queue.description")}
      chart={
        <LineChart
          label={t("queue.label", { days: days.length })}
          series={series}
          formatY={formatDuration}
          points={days.map((d) => ({
            x: shortDay(d.day),
            title: d.day,
            values: { queueP95: d.queueP95 },
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
          columns={[t("day"), t("queueP95")]}
          rows={days.map((d) => [
            d.day,
            approx(formatDuration(d.queueP95), isApprox),
          ])}
        />
      }
    />
  );
}

export async function SuccessRateChart({ days }: Props) {
  const t = await getTranslations("charts");
  const locale = await getLocale();
  const series: LineSeries[] = [
    { key: "rate", label: t("successRate"), tone: "success" },
  ];
  const title = t("successChart.title");
  return (
    <ChartFrame
      title={title}
      description={t("successChart.description")}
      chart={
        <LineChart
          label={t("successChart.label", { days: days.length })}
          series={series}
          maxY={1}
          formatY={(v) => formatPercent(v, locale, 0)}
          points={days.map((d) => ({
            x: shortDay(d.day),
            title: d.day,
            values: { rate: d.successRate },
          }))}
        />
      }
      legend={
        <Legend
          items={series.map((s) => ({
            label: s.label,
            tone: s.tone,
            kind: "line" as const,
          }))}
        />
      }
      table={
        <DataTable
          caption={title}
          columns={[t("day"), t("runs"), t("successRate")]}
          rows={days.map((d) => [
            d.day,
            formatNumber(d.runs, locale),
            formatPercent(d.successRate, locale),
          ])}
        />
      }
    />
  );
}

export async function MinutesChart({ id, days }: Props) {
  const t = await getTranslations("charts");
  const locale = await getLocale();
  const series: BarSeries[] = [
    { key: "minutes", label: t("minutes"), tone: "secondary" },
  ];
  const total = days.reduce((s, d) => s + d.billableMinEst, 0);
  const title = t("minutesChart.title");
  return (
    <ChartFrame
      title={title}
      description={t("minutesChart.description")}
      chart={
        <StackedBarChart
          id={id}
          label={t("minutesChart.label", {
            days: days.length,
            minutes: formatMinutes(total, locale),
          })}
          series={series}
          formatY={(v) => formatNumber(v, locale)}
          points={days.map((d) => ({
            x: shortDay(d.day),
            title: d.day,
            values: { minutes: Math.round(d.billableMinEst) },
          }))}
        />
      }
      legend={
        <Legend
          items={series.map((s) => ({
            label: s.label,
            tone: s.tone,
            kind: "bar" as const,
          }))}
        />
      }
      table={
        <DataTable
          caption={title}
          columns={[t("day"), t("minutes")]}
          rows={days.map((d) => [
            d.day,
            formatMinutes(d.billableMinEst, locale),
          ])}
        />
      }
    />
  );
}
