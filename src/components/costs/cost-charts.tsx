import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DataTable } from "@/components/charts/data-table";
import { Gauge } from "@/components/charts/gauge";
import {
  StackedBarChart,
  type BarSeries,
} from "@/components/charts/stacked-bar-chart";
import { credentialFixable, gaugeGeometry } from "@/lib/costs-view";
import { formatMinutes, formatNumber, formatUsd } from "@/lib/format";
import type { Costs } from "@/server/data/costs";

/**
 * Costs page building blocks (design §6.6, §7 /costs): the used vs included
 * gauge with the month-end projection, the per-day chart and the
 * estimate-only notice.
 */

export function IncludedGauge({ costs }: { costs: Costs }) {
  const t = useTranslations("costs.gauge");
  const locale = useLocale();
  const inc = costs.included;
  const g = gaugeGeometry(inc);
  const min = (v: number) => formatMinutes(v, locale);
  const source = t(`sources.${inc.usedSource}`);
  return (
    <ChartFrame
      title={t("title")}
      description={t("description", {
        source,
        elapsed: inc.elapsedDays,
        days: inc.daysInMonth,
      })}
      chart={
        <div className="flex flex-col gap-2">
          <Gauge
            label={t("label", {
              used: formatNumber(inc.used, locale),
              included: formatNumber(inc.included, locale),
              projected: formatNumber(inc.projectedUsed, locale),
            })}
            usedPct={g.usedPct}
            projectedPct={g.projectedPct}
            markerPct={inc.included > 0 ? g.includedPct : null}
            over={g.overIncluded}
            legend={{
              used: t("used", { used: min(inc.used) }),
              projected: t("projected", { projected: min(inc.projectedUsed) }),
              marker:
                inc.included > 0
                  ? t("included", { included: min(inc.included) })
                  : null,
            }}
          />
          {g.overIncluded ? (
            <p className="text-sm font-medium text-destructive">{t("over")}</p>
          ) : g.projectedOverIncluded ? (
            <p className="text-sm">{t("projectedOver")}</p>
          ) : null}
        </div>
      }
      table={
        <DataTable
          caption={t("title")}
          columns={[t("measure"), t("minutes")]}
          rows={[
            [t("rowUsed", { source }), min(inc.used)],
            [t("rowProjected"), min(inc.projectedUsed)],
            [t("rowIncluded"), min(inc.included)],
          ]}
        />
      }
    />
  );
}

/** Minutes per day: billed quantity when billed, else the estimate. */
export function CostsPerDayChart({ costs }: { costs: Costs }) {
  const t = useTranslations("costs.byDay");
  const tc = useTranslations("charts");
  const tk = useTranslations("costs.bySku");
  const locale = useLocale();
  const billed = costs.source === "billed";
  const kind = t(`kinds.${costs.source}`);
  const series: BarSeries[] = [
    {
      key: "minutes",
      label: kind,
      tone: billed ? "secondary" : "tertiary",
      pattern: billed ? undefined : "hatch",
    },
  ];
  const value = (d: Costs["byDay"][number]) =>
    billed ? d.billedQuantity : d.estMin;
  const total = costs.byDay.reduce((s, d) => s + value(d), 0);
  return (
    <ChartFrame
      title={t("title")}
      description={t("description", { kind })}
      chart={
        <StackedBarChart
          id="costs-by-day"
          label={t("label", {
            kind,
            month: costs.month,
            minutes: formatMinutes(total, locale),
          })}
          series={series}
          formatY={(v) => formatNumber(v, locale)}
          points={costs.byDay.map((d) => ({
            x: d.day.slice(8),
            title: d.day,
            values: { minutes: Math.round(value(d)) },
          }))}
        />
      }
      table={
        <DataTable
          caption={t("title")}
          columns={[
            tc("day"),
            tk("quantity"),
            tk("net"),
            tk("estMin"),
            tk("estUsd"),
          ]}
          rows={costs.byDay.map((d) => [
            d.day,
            billed ? formatNumber(d.billedQuantity, locale) : "—",
            billed ? formatUsd(d.netUsd, locale) : "—",
            formatMinutes(d.estMin, locale),
            formatUsd(d.estUsd, locale),
          ])}
        />
      }
    />
  );
}

/**
 * Estimate-only notice with its reason. Admins also see the stored billing
 * error, a reconnect hint and, where a credential helps, a link to
 * /admin/github.
 */
export function EstimateNotice({
  costs,
  accountType,
}: {
  costs: Costs;
  accountType: "USER" | "ORGANIZATION";
}) {
  const t = useTranslations("billingStatus");
  const tc = useTranslations("costs");
  const notice = costs.adminNotice;
  const showLink =
    notice != null &&
    (credentialFixable(costs.reason, accountType) ||
      (accountType === "USER" && notice.reconnect));
  if (costs.source === "billed" && !notice?.reconnect) return null;
  return (
    <section
      aria-label={t("estimated")}
      className="flex flex-col gap-1 rounded-xl border border-dashed p-3 text-sm"
    >
      {costs.reason ? <p className="font-medium">{t(costs.reason)}</p> : null}
      <p className="text-muted-foreground">{t("estimated")}</p>
      {notice?.reconnect ? <p>{t("reconnect")}</p> : null}
      {notice?.error ? (
        <p className="text-xs text-muted-foreground">
          {tc("adminError", { error: notice.error })}
        </p>
      ) : null}
      {showLink ? (
        <p>
          <Link href="/admin/github" className="underline">
            {tc("adminLink")}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
