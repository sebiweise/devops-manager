import { useFormatter, useLocale, useTranslations } from "next-intl";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DataTable } from "@/components/charts/data-table";
import { Heatmap } from "@/components/charts/heatmap";
import { Legend } from "@/components/charts/legend";
import { LineChart, type LineSeries } from "@/components/charts/line-chart";
import { StateStrip } from "@/components/charts/state-strip";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import {
  bandShares,
  DURATION_BANDS,
  heatmapGrid,
  statusSegments,
} from "@/lib/runners-view";
import type {
  ConcurrencyDto,
  PoolDto,
  RunnerDayPoint,
  RunnerDetail,
} from "@/server/data/runners";

/**
 * Charts of the runner pages (design §6.5, §7). Each one is a ChartFrame:
 * figure, caption, aria-label, a text legend and a table toggle.
 */

const lineLegend = (series: ReadonlyArray<LineSeries>) => (
  <Legend
    items={series.map((s) => ({
      label: s.label,
      tone: s.tone,
      kind: "line" as const,
      dash: s.dash,
    }))}
  />
);

/** Running and queued jobs in 5-minute buckets. */
export function ConcurrencyChart({ data }: { data: ConcurrencyDto }) {
  const t = useTranslations("runners.concurrency");
  const locale = useLocale();
  const format = useFormatter();
  const time = {
    format: (d: Date) =>
      format.dateTime(d, { hour: "2-digit", minute: "2-digit" }),
  };
  const full = {
    format: (d: Date) =>
      format.dateTime(d, { dateStyle: "short", timeStyle: "short" }),
  };
  const series: LineSeries[] = [
    { key: "running", label: t("running"), tone: "primary" },
    { key: "queued", label: t("queued"), tone: "tertiary", dash: "dashed" },
  ];
  return (
    <ChartFrame
      title={t("title")}
      description={t("description")}
      chart={
        <LineChart
          label={t("label", {
            running: data.peakRunning,
            queued: data.peakQueued,
          })}
          series={series}
          points={data.buckets.map((b) => ({
            x: time.format(new Date(b.t)),
            title: full.format(new Date(b.t)),
            values: { running: b.running, queued: b.queued },
          }))}
        />
      }
      legend={
        <>
          {lineLegend(series)}
          <p className="mt-1 text-xs text-muted-foreground">
            {t("summary", {
              running: data.peakRunning,
              queued: data.peakQueued,
              avg: data.avgRunning.toFixed(1),
            })}
          </p>
        </>
      }
      table={
        <DataTable
          caption={t("title")}
          columns={[t("time"), t("running"), t("queued")]}
          rows={data.buckets
            .filter((b) => b.running > 0 || b.queued > 0)
            .map((b) => [
              full.format(new Date(b.t)),
              formatNumber(b.running, locale),
              formatNumber(b.queued, locale),
            ])}
        />
      }
    />
  );
}

/** Weekday × hour heatmap of the queue p95 of one pool. */
export function PoolHeatmap({ pool }: { pool: PoolDto }) {
  const t = useTranslations("runners.heatmap");
  const tw = useTranslations("runners.weekdays");
  const locale = useLocale();
  const grid = heatmapGrid(pool.heatmap);
  const days = ["1", "2", "3", "4", "5", "6", "7"] as const;
  const hours = Array.from({ length: 24 }, (_, h) =>
    String(h).padStart(2, "0"),
  );
  const name = pool.labelKey || "—";
  return (
    <ChartFrame
      title={t("title", { pool: name })}
      description={t("description")}
      chart={
        <Heatmap
          label={t("label", {
            pool: name,
            max: formatDuration(grid.maxQueueP95),
          })}
          rows={days.map((d) => tw(d))}
          columns={hours}
          max={grid.maxQueueP95}
          scaleLabels={[t("noData"), t("low"), t("high")]}
          cells={grid.cells.map((row, d) =>
            row.map((c, h) => ({
              value: c.jobs > 0 ? c.queueP95 : null,
              title: t("cell", {
                day: tw(days[d]!),
                hour: hours[h]!,
                jobs: c.jobs,
                p95: formatDuration(c.queueP95),
              }),
            })),
          )}
        />
      }
      table={
        <DataTable
          caption={t("title", { pool: name })}
          columns={[t("weekday"), t("hour"), t("jobs"), t("queueP95")]}
          rows={pool.heatmap.map((h) => [
            tw(String(h.weekday) as (typeof days)[number]),
            `${String(h.hour).padStart(2, "0")}:00`,
            formatNumber(h.jobs, locale),
            formatDuration(h.queueP95),
          ])}
        />
      }
    />
  );
}

/** Daily utilisation of one runner (null on days with insufficient samples). */
export function RunnerUtilisationChart({
  days,
}: {
  days: ReadonlyArray<RunnerDayPoint>;
}) {
  const t = useTranslations("runner.utilChart");
  const td = useTranslations("runnerData");
  const tc = useTranslations("charts");
  const locale = useLocale();
  const series: LineSeries[] = [
    { key: "u", label: t("utilisation"), tone: "primary" },
  ];
  return (
    <ChartFrame
      title={t("title")}
      description={t("description")}
      chart={
        <LineChart
          label={t("label", { days: days.length })}
          series={series}
          maxY={1}
          formatY={(v) => formatPercent(v, locale, 0)}
          points={days.map((d) => ({
            x: d.day.slice(5),
            title: d.day,
            values: { u: d.insufficientSamples ? null : d.utilisation },
          }))}
        />
      }
      legend={lineLegend(series)}
      table={
        <DataTable
          caption={t("title")}
          columns={[tc("day"), t("utilisation"), t("busy"), t("online")]}
          rows={days.map((d) => [
            d.day,
            d.insufficientSamples
              ? td("insufficientSamples")
              : formatPercent(d.utilisation, locale),
            formatDuration(d.busyS),
            formatDuration(d.onlineS),
          ])}
        />
      }
    />
  );
}

/** Busy / idle / offline over the sampled window. */
export function RunnerStatusChart({
  name,
  samples,
  from,
  to,
}: {
  name: string;
  samples: RunnerDetail["statusTimeline"];
  from: string;
  to: string;
}) {
  const t = useTranslations("runner.status");
  const ts = useTranslations("runners.states");
  const locale = useLocale();
  const format = useFormatter();
  const a = Date.parse(from);
  const b = Date.parse(to);
  const segments = statusSegments(samples, a, b);
  const share = (k: "busy" | "idle" | "offline") =>
    formatPercent(
      segments
        .filter((s) => s.kind === k)
        .reduce((sum, s) => sum + (s.to - s.from), 0),
      locale,
      0,
    );
  const when = (ms: number) =>
    format.dateTime(new Date(ms), { dateStyle: "short", timeStyle: "short" });
  const labels = {
    busy: ts("busy"),
    idle: ts("idle"),
    offline: ts("offline"),
  };
  return (
    <ChartFrame
      title={t("title")}
      description={t("description")}
      chart={
        segments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <StateStrip
            label={t("label", {
              name,
              from: when(a),
              to: when(b),
              busy: share("busy"),
              idle: share("idle"),
              offline: share("offline"),
            })}
            segments={segments}
            stateLabels={labels}
            startLabel={when(a)}
            endLabel={when(b)}
          />
        )
      }
      table={
        <DataTable
          caption={t("title")}
          columns={[t("state"), t("from"), t("to")]}
          rows={segments.map((s) => [
            labels[s.kind],
            when(a + s.from * (b - a)),
            when(a + s.to * (b - a)),
          ])}
        />
      }
    />
  );
}

/** Share of jobs per duration band: this runner vs its pool. */
export function DurationVsPoolChart({
  distribution,
}: {
  distribution: RunnerDetail["distribution"];
}) {
  const t = useTranslations("runner.distribution");
  const locale = useLocale();
  const runner = bandShares(distribution.runner.hist);
  const pool = bandShares(distribution.pool.hist);
  const bands = DURATION_BANDS.map((_, i) => t(`bands.b${i}` as "bands.b0"));
  const series: LineSeries[] = [
    { key: "runner", label: t("runner"), tone: "primary" },
    { key: "pool", label: t("pool"), tone: "secondary", dash: "dashed" },
  ];
  return (
    <ChartFrame
      title={t("title")}
      description={t("description", {
        labels: distribution.labelKey || "—",
      })}
      chart={
        <LineChart
          label={t("label", {
            runner: distribution.runner.n,
            pool: distribution.pool.n,
          })}
          series={series}
          maxY={1}
          formatY={(v) => formatPercent(v, locale, 0)}
          points={bands.map((band, i) => ({
            x: band,
            title: band,
            values: {
              runner: distribution.runner.n > 0 ? runner[i]! : null,
              pool: distribution.pool.n > 0 ? pool[i]! : null,
            },
          }))}
        />
      }
      legend={lineLegend(series)}
      table={
        <DataTable
          caption={t("title")}
          columns={[t("band"), t("runner"), t("pool")]}
          rows={bands.map((band, i) => [
            band,
            formatPercent(runner[i], locale),
            formatPercent(pool[i], locale),
          ])}
        />
      }
    />
  );
}
