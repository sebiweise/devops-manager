import {
  CircleAlert,
  ExternalLink,
  Hourglass,
  Info,
  Server,
} from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DataTable as ChartTable } from "@/components/charts/data-table";
import { Gauge } from "@/components/charts/gauge";
import { Legend } from "@/components/charts/legend";
import { LineChart } from "@/components/charts/line-chart";
import {
  StackedBarChart,
  type BarSeries,
} from "@/components/charts/stacked-bar-chart";
import type { Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import { KpiTile } from "@/components/data/kpi-strip";
import { repoHref } from "@/components/insights/workflow-link";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import type {
  AzureCard,
  AzureCosts,
  AzureQueue,
  AzureUsage,
  PipelineRow,
} from "@/server/data/azure";
import { githubEquivalent } from "@/lib/azure-usage";
import { AzureBuildBadge } from "./azure-badges";
import { QueueRunButton, type AzureActionContext } from "./azure-actions";

/**
 * Server building blocks of the Azure Pipelines views (design addendum M7
 * §5.2, §6): the minutes gauge, minutes per day by OS (stacked bars with
 * patterns, legend and table view), the parallel job occupancy (lines,
 * table view), the overview card, the pools and agents, the queue block
 * and the pipeline table columns. Status colours always come with an icon
 * and text; series use the series slots, never a status colour.
 */

export function azureHrefs(login: string) {
  const base = `/o/${encodeURIComponent(login)}/pipelines`;
  return {
    pipelines: base,
    runs: `${base}/runs`,
    run: (id: number | string) => `${base}/runs/${id}`,
    usage: `${base}/usage`,
  };
}

export function ExternalAzureLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      <ExternalLink aria-hidden="true" className="size-3" />
      {label}
    </a>
  );
}

/** "742 / 1,800 min" with the projection and the included-minutes marker. */
export async function MinutesGauge({
  usage,
}: {
  usage: Pick<
    AzureUsage,
    "included" | "used" | "projected" | "paid" | "source" | "level"
  >;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("ci.azure.usage"),
    getLocale(),
  ]);
  if (usage.paid || usage.included == null)
    return <p className="text-sm">{t("paidNoLimit")}</p>;
  const scale = Math.max(usage.included, usage.projected, usage.used, 1) * 1.05;
  const pct = (v: number) => (v / scale) * 100;
  return (
    <Gauge
      label={t("gaugeLabel", {
        used: formatNumber(usage.used, locale),
        included: formatNumber(usage.included, locale),
        projected: formatNumber(usage.projected, locale),
      })}
      usedPct={pct(usage.used)}
      projectedPct={pct(usage.projected)}
      markerPct={pct(usage.included)}
      over={usage.used > usage.included}
      legend={{
        used: t("legendUsed", {
          source: t(`source.${usage.source ?? "estimate"}`),
        }),
        projected: t("legendProjected"),
        marker: t("legendIncluded"),
      }}
    />
  );
}

const OS_SERIES = (t: (k: string) => string): BarSeries[] => [
  { key: "linux", label: t("os.LINUX"), tone: "primary" },
  {
    key: "windows",
    label: t("os.WINDOWS"),
    tone: "secondary",
    pattern: "dots",
  },
  { key: "macos", label: t("os.MACOS"), tone: "tertiary", pattern: "hatch" },
];

/** Hosted minutes per day of the billing month, stacked by OS. */
export async function MinutesPerDayChart({
  id,
  days,
}: {
  id: string;
  days: AzureUsage["perDay"];
}) {
  const [t, locale] = await Promise.all([
    getTranslations("ci.azure.usage"),
    getLocale(),
  ]);
  const fmt = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const label = (d: string) => fmt.format(new Date(`${d}T00:00:00Z`));
  const series = OS_SERIES((k) => t(k));
  const total = days.reduce((s, d) => s + d.linux + d.windows + d.macos, 0);
  const title = t("perDayTitle");
  return (
    <ChartFrame
      title={title}
      description={t("perDayDescription")}
      chart={
        days.length === 0 ? (
          <EmptyState quiet message={t("noUsage")} />
        ) : (
          <StackedBarChart
            id={id}
            label={t("perDayLabel", { n: days.length, total })}
            series={series}
            points={days.map((d) => ({
              x: label(d.day),
              title: label(d.day),
              values: { linux: d.linux, windows: d.windows, macos: d.macos },
            }))}
          />
        )
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
        <ChartTable
          caption={title}
          columns={[
            t("day"),
            ...series.map((s) => s.label),
            t("total"),
            t("publicMinutes"),
          ]}
          rows={days.map((d) => [
            label(d.day),
            formatNumber(d.linux, locale),
            formatNumber(d.windows, locale),
            formatNumber(d.macos, locale),
            formatNumber(d.linux + d.windows + d.macos, locale),
            formatNumber(d.public, locale),
          ])}
        />
      }
    />
  );
}

/** Running and queued hosted jobs over the last 24 hours against the parallel limit. */
export async function ParallelChart({
  samples,
  limit,
}: {
  samples: AzureUsage["parallel"]["samples"];
  limit: number;
}) {
  const [t, format] = await Promise.all([
    getTranslations("ci.azure.usage"),
    getFormatter(),
  ]);
  const time = (iso: string) =>
    format.dateTime(new Date(iso), { hour: "2-digit", minute: "2-digit" });
  const title = t("parallelTitle");
  const max = Math.max(
    limit,
    ...samples.map((s) => Math.max(s.running, s.queued)),
    1,
  );
  return (
    <ChartFrame
      title={title}
      description={t("parallelDescription", { limit })}
      chart={
        samples.length < 2 ? (
          <EmptyState quiet message={t("noSamples")} />
        ) : (
          <LineChart
            label={t("parallelLabel", { n: samples.length, limit })}
            maxY={max}
            formatY={(v) => (Number.isInteger(v) ? String(v) : "")}
            series={[
              { key: "running", label: t("running"), tone: "primary" },
              {
                key: "queued",
                label: t("queued"),
                tone: "secondary",
                dash: "dashed",
              },
              {
                key: "limit",
                label: t("limit"),
                tone: "quaternary",
                dash: "dotted",
              },
            ]}
            points={samples.map((s) => ({
              x: time(s.at),
              title: format.dateTime(new Date(s.at), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
              values: { running: s.running, queued: s.queued, limit },
            }))}
          />
        )
      }
      legend={
        <Legend
          items={[
            { label: t("running"), tone: "primary", kind: "line" },
            {
              label: t("queued"),
              tone: "secondary",
              kind: "line",
              dash: "dashed",
            },
            {
              label: t("limit"),
              tone: "quaternary",
              kind: "line",
              dash: "dotted",
            },
          ]}
        />
      }
      table={
        <ChartTable
          caption={title}
          columns={[t("time"), t("running"), t("queued"), t("limit")]}
          rows={samples.map((s) => [
            time(s.at),
            String(s.running),
            String(s.queued),
            String(limit),
          ])}
        />
      }
    />
  );
}

/** The overview's Azure Pipelines card: minutes against the free tier, projection, parallel. */
export async function AzureOverviewCard({
  card,
  login,
}: {
  card: AzureCard;
  login: string;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("ci.azure.card"),
    getLocale(),
  ]);
  const h = azureHrefs(login);
  const u = card.usage;
  return (
    <section
      aria-labelledby="azure-card"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="azure-card" className="font-medium">
          {t("title", { org: card.orgName })}
        </h2>
        <div className="flex gap-3 text-xs">
          <Link
            href={h.pipelines}
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("pipelines")}
          </Link>
          <Link
            href={h.usage}
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("usage")}
          </Link>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {u.paid || u.included == null ? (
          <KpiTile
            label={t("minutes")}
            info={t("minutesInfo")}
            value={formatNumber(u.used, locale)}
            hint={t("unlimited")}
            href={h.usage}
          />
        ) : (
          <KpiTile
            variant="meter"
            label={t("minutes")}
            info={t("minutesInfo")}
            value={`${formatNumber(u.used, locale)} / ${formatNumber(u.included, locale)}`}
            ratio={u.used / Math.max(1, u.included)}
            overLabel={t("over")}
            hint={t(`source.${u.source ?? "estimate"}`)}
            href={h.usage}
          />
        )}
        <KpiTile
          label={t("projection")}
          value={formatNumber(u.projected, locale)}
          hint={
            u.limitDay
              ? t("limitAround", { day: u.limitDay.slice(8, 10) })
              : t("withinLimit")
          }
        />
        <KpiTile
          label={t("parallel")}
          value={`${u.parallel.running}/${u.parallel.limit}`}
          hint={
            u.parallel.queued > 0
              ? t("queued", { count: u.parallel.queued })
              : t("noneQueued")
          }
        />
        {card.failing > 0 ? (
          <KpiTile
            variant="status"
            icon={CircleAlert}
            tone="critical"
            label={t("failing")}
            value={formatNumber(card.failing, locale)}
            href={`${h.pipelines}?f=failing`}
          />
        ) : (
          <KpiTile
            label={t("failing")}
            value={formatNumber(0, locale)}
            href={h.pipelines}
          />
        )}
      </dl>
    </section>
  );
}

export async function PoolsSection({
  pools,
  usageHref,
}: {
  pools: AzureUsage["pools"];
  usageHref?: string;
}) {
  const t = await getTranslations("ci.azure.pools");
  return (
    <section aria-labelledby="azure-pools" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="azure-pools" className="flex items-center gap-2 font-medium">
          <Server aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("title")}
        </h2>
        {usageHref ? (
          <Link
            href={usageHref}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("toUsage")}
          </Link>
        ) : null}
      </div>
      {pools.length === 0 ? (
        <EmptyState quiet message={t("empty")} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {pools.map((p) => (
            <li
              key={p.id}
              className="flex flex-col gap-1 rounded-lg border p-3 text-sm"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {p.isHosted ? t("hosted") : t("selfHosted")}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {t("state", { running: p.running, queued: p.queued })}
                {!p.isHosted
                  ? ` · ${t("online", { online: p.online ?? 0, total: p.agents.length })}`
                  : ""}
              </span>
              {!p.isHosted && p.online === 0 && p.queued > 0 ? (
                <span className="flex items-center gap-1 text-xs">
                  <CircleAlert
                    aria-hidden="true"
                    className="size-3 text-status-critical"
                  />
                  {t("offlineWaiting")}
                </span>
              ) : null}
              {p.agents.length > 0 ? (
                <ul className="mt-1 flex flex-col text-xs">
                  {p.agents.map((a) => (
                    <li key={a.id} className="flex flex-wrap gap-2">
                      <span className="font-mono">{a.name}</span>
                      <span
                        className={
                          a.status === "online"
                            ? "text-muted-foreground"
                            : "text-status-warning"
                        }
                      >
                        {t(
                          `agent.${a.status === "online" ? (a.busy ? "busy" : "idle") : "offline"}`,
                        )}
                      </span>
                      {!a.enabled ? (
                        <span className="text-muted-foreground">
                          {t("agent.disabled")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Queued Azure jobs: "waiting for a parallel job, 1/1 busy". */
export async function AzureQueueBlock({
  queue,
  login,
}: {
  queue: AzureQueue;
  login: string;
}) {
  const [t, format] = await Promise.all([
    getTranslations("ci.azure.queue"),
    getFormatter(),
  ]);
  const h = azureHrefs(login);
  return (
    <section
      aria-labelledby="azure-queue"
      className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <h2 id="azure-queue" className="flex items-center gap-2 font-medium">
        <Hourglass
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("slots", { running: queue.running, limit: queue.limit })}
      </p>
      {queue.queued.length === 0 ? (
        <EmptyState quiet message={t("empty")} />
      ) : (
        <ul className="flex flex-col">
          {queue.queued.map((q) => (
            <li
              key={q.id}
              className="flex flex-wrap items-center gap-2 border-t py-1.5 text-sm first:border-t-0"
            >
              <Link
                href={h.run(q.id)}
                className="font-medium underline-offset-2 hover:underline"
              >
                {q.definitionName}
              </Link>
              {q.repoFullName ? (
                <span className="text-xs text-muted-foreground">
                  {q.repoFullName.split("/").pop()}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {q.headBranch ?? "—"}
              </span>
              <span className="text-xs">
                {queue.running >= queue.limit
                  ? t("waitingParallel", {
                      running: queue.running,
                      limit: queue.limit,
                    })
                  : t("waiting")}
              </span>
              <time
                dateTime={q.queuedAt}
                className="ml-auto text-xs text-muted-foreground"
              >
                {format.relativeTime(new Date(q.queuedAt))}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Columns of the pipelines (definitions) table, shared by /pipelines and the repo's Pipelines tab. */
export async function pipelineColumns({
  login,
  showRepo = true,
  actions,
}: {
  login: string;
  showRepo?: boolean;
  actions?: AzureActionContext | null;
}): Promise<Column<PipelineRow>[]> {
  const [t, locale, format] = await Promise.all([
    getTranslations("ci.azure.pipelines"),
    getLocale(),
    getFormatter(),
  ]);
  const h = azureHrefs(login);
  return [
    {
      id: "name",
      label: t("col.name"),
      header: t("col.name"),
      sortKey: "name",
      className: "whitespace-normal",
      cell: (p) => (
        <span className="flex flex-col">
          <Link
            href={`${h.runs}?definition=${p.projectId}:${p.id}`}
            className="font-medium underline-offset-2 hover:underline"
          >
            {p.name}
          </Link>
          <span className="text-xs text-muted-foreground">
            {p.projectName}
            {p.yamlPath ? ` · ${p.yamlPath}` : ""}
          </span>
        </span>
      ),
    },
    ...(showRepo
      ? [
          {
            id: "repo",
            label: t("col.repo"),
            header: t("col.repo"),
            hideBelow: "sm" as const,
            cell: (p: PipelineRow) =>
              p.repoFullName ? (
                <span className="flex flex-col">
                  <Link
                    href={repoHref(login, p.repoFullName)}
                    className="underline-offset-2 hover:underline"
                  >
                    {p.repoFullName.split("/").pop()}
                  </Link>
                  {p.link === "manual" ? (
                    <span className="text-xs text-muted-foreground">
                      {t("manual")}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {p.linkRepo
                    ? t("outside", { repo: p.linkRepo })
                    : t("unlinked")}
                </span>
              ),
          } satisfies Column<PipelineRow>,
        ]
      : []),
    {
      id: "last",
      label: t("col.last"),
      header: t("col.last"),
      cell: (p) =>
        p.lastStatus ? (
          <span className="flex flex-col gap-0.5">
            <Link
              href={h.run(p.lastBuildId!)}
              aria-label={t("lastBuild", { pipeline: p.name })}
            >
              <AzureBuildBadge
                status={p.lastStatus}
                result={p.lastResult}
                timedOut={p.lastTimedOut}
              />
            </Link>
            {p.lastAt ? (
              <time
                dateTime={p.lastAt}
                className="text-xs text-muted-foreground"
              >
                {format.relativeTime(new Date(p.lastAt))}
              </time>
            ) : null}
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "success",
      label: t("col.success"),
      header: t("col.success"),
      align: "right",
      cell: (p) => (
        <span className="flex flex-col items-end">
          <span>{formatPercent(p.summary.successRate, locale)}</span>
          {p.summary.partial > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("partialCount", { count: p.summary.partial })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "duration",
      label: t("col.duration"),
      header: t("col.duration"),
      align: "right",
      hideBelow: "md",
      cell: (p) => (
        <span className="text-xs whitespace-nowrap">
          {formatDuration(p.summary.p50)} / {formatDuration(p.summary.p90)}
        </span>
      ),
    },
    {
      id: "minutes",
      label: t("col.minutes"),
      header: t("col.minutes"),
      align: "right",
      hideBelow: "md",
      cell: (p) => formatNumber(p.summary.hostedMinutes, locale),
    },
    {
      id: "macos",
      label: t("col.macos"),
      header: t("col.macos"),
      align: "right",
      hideBelow: "lg",
      cell: (p) => formatPercent(p.summary.macosShare, locale),
    },
    {
      id: "cap",
      label: t("col.cap"),
      header: t("col.cap"),
      align: "right",
      hideBelow: "lg",
      cell: (p) =>
        p.summary.jobsNearCap > 0 ? (
          <span className="inline-flex items-center gap-1">
            <CircleAlert
              aria-hidden="true"
              className="size-3 text-status-warning"
            />
            {formatNumber(p.summary.jobsNearCap, locale)}
          </span>
        ) : (
          "0"
        ),
    },
    {
      id: "links",
      label: t("col.links"),
      header: t("col.links"),
      expanderOnly: true,
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-3">
          <ExternalAzureLink href={p.azureUrl} label={t("openInAzure")} />
          {actions && p.link !== "unlinked" ? (
            <QueueRunButton
              compact
              ctx={actions}
              definition={{
                projectId: p.projectId,
                id: p.id,
                name: p.name,
                defaultBranch: p.defaultBranch,
                p90Minutes:
                  p.summary.p90 == null ? null : Math.round(p.summary.p90 / 60),
              }}
            />
          ) : null}
        </span>
      ),
    },
  ];
}

/** Why an operator sees no Azure action buttons (a switch is off, or the credential was rejected). */
export async function AzureBlockedNote({
  blockedBy,
}: {
  blockedBy: string | null;
}) {
  if (!blockedBy || blockedBy === "role") return null;
  const t = await getTranslations("ci.azure.actions.blocked");
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {t(blockedBy)}
    </p>
  );
}

/**
 * The Costs page's "Azure Pipelines" section (design addendum M7 §5.3),
 * below the unchanged GitHub cards: macOS minutes of the month on both
 * providers. GitHub counts raw macOS minutes × the SkuRate multiplier
 * against its included minutes; Azure counts them × 1 against the shared
 * free tier. The GitHub-equivalent of the Azure macOS minutes and its
 * estimated amount at the GitHub macOS rate are labelled as estimates. No
 * Azure DevOps currency figure exists (no billing API); nothing here feeds
 * the GitHub estimates.
 */
export async function AzureCostsSection({
  costs,
  githubIncluded,
  login,
}: {
  costs: AzureCosts;
  githubIncluded: number;
  login: string;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("ci.azure.costs"),
    getLocale(),
  ]);
  const eq = githubEquivalent(
    costs.azureMacosMinutes,
    costs.macosMultiplier,
    costs.macosPricePerMinuteUsd,
  );
  const ghBillable = Math.round(
    costs.githubMacosMinutes * costs.macosMultiplier,
  );
  const usd = (v: number | null) =>
    v == null
      ? "—"
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
        }).format(v);
  return (
    <section aria-labelledby="azure-costs" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="azure-costs" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <Link
          href={azureHrefs(login).usage}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("toUsage")}
        </Link>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground">
        <h3 className="font-medium">{t("macosTitle")}</h3>
        <dl className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <KpiTile
            label={t("github")}
            info={t("githubInfo", { multiplier: costs.macosMultiplier })}
            value={formatNumber(ghBillable, locale)}
            hint={t("githubHint", {
              raw: formatNumber(costs.githubMacosMinutes, locale),
              included: formatNumber(githubIncluded, locale),
            })}
          />
          <KpiTile
            label={t("azure")}
            info={t("azureInfo")}
            value={formatNumber(costs.azureMacosMinutes, locale)}
            hint={
              costs.azureIncluded == null
                ? t("azureUnlimited")
                : t("azureHint", {
                    used: formatNumber(costs.azureUsed, locale),
                    included: formatNumber(costs.azureIncluded, locale),
                  })
            }
          />
          <KpiTile
            label={t("equivalent")}
            info={t("equivalentInfo", { multiplier: costs.macosMultiplier })}
            value={formatNumber(eq.minutes, locale)}
            hint={t("savings", { amount: usd(eq.usd) })}
          />
        </dl>
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </div>
    </section>
  );
}
