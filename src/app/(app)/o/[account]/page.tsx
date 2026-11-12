import {
  CircleX,
  Repeat,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/data/empty-state";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import {
  DurationChart,
  QueueChart,
  RunsPerDayChart,
} from "@/components/insights/day-charts";
import { repoHref, workflowHref } from "@/components/insights/workflow-link";
import { GettingStarted } from "@/components/shell/getting-started";
import { PageHeader } from "@/components/shell/page-header";
import { env } from "@/env";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
  formatPointsDelta,
} from "@/lib/format";
import { enoughData, type SearchParams } from "@/lib/insights-view";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import { hasRole } from "@/server/authz/roles";
import {
  getInstallationOverview,
  listFlakyJobs,
  listRepoStats,
  listWorkflowStats,
} from "@/server/data/insights";
import { getAccountSummaries } from "@/server/data/summaries";

export const generateMetadata = accountMeta("overview");

/** A compact list card with a "Show all" link (UI overhaul §2.2). */
function ListCard({
  title,
  showAll,
  showAllLabel,
  children,
}: {
  title: string;
  showAll?: string;
  showAllLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">{title}</h2>
        {showAll ? (
          <Link
            href={showAll}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {showAllLabel}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** Items per "needs attention" group; the count names the rest. */
const PER_GROUP = 3;

type Item = {
  key: string;
  icon: ReactNode;
  href: string;
  name: string;
  repo: string;
  detail: string;
};

/**
 * Account overview (UI overhaul §2.2): KPIs that link to their section,
 * the run, duration and queue charts in the range's buckets, and two
 * compact lists — what needs attention (failing, slower, success drops,
 * flaky jobs) and the most active repositories. A new account shows the
 * getting-started steps instead of empty charts.
 */
export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const range = await pageRange(sp);
  const now = new Date();
  const [t, locale, overview, week, flaky, active, summaries] =
    await Promise.all([
      getTranslations(),
      getLocale(),
      orNotFound(getInstallationOverview(scope, installation.id, range, now)),
      orNotFound(
        listWorkflowStats(scope, installation.id, { range: "7d" }, now),
      ),
      orNotFound(listFlakyJobs(scope, installation.id, range, now)),
      orNotFound(
        listRepoStats(
          scope,
          installation.id,
          { range, sort: "runs", dir: "desc", size: 5 },
          now,
        ),
      ),
      getAccountSummaries(scope, now, { backfillDays: env.BACKFILL_DAYS }),
    ]);
  const card = summaries.find(
    (c) => c.installationId === String(installation.id),
  );
  const s = overview.summary;
  const login = installation.accountLogin;
  const base = accountPath(login);
  const enough = enoughData(s.n);
  const rangeLabel = t(`filters.ranges.${range}`);
  const isAdmin = hasRole(scope.role, "ADMIN");

  const failing = week
    .filter((w) => w.summary.failure > 0)
    .sort(
      (a, b) =>
        b.summary.failure - a.summary.failure ||
        a.workflowName.localeCompare(b.workflowName),
    );
  const regressions = week
    .filter((w) => w.regression)
    .sort((a, b) => b.regression!.ratio - a.regression!.ratio);
  const drops = week
    .filter((w) => w.successDrop)
    .sort((a, b) => b.successDrop!.drop - a.successDrop!.drop);

  const groups: Array<{ label: string; count: number; items: Item[] }> = [
    {
      label: t("overview.failing"),
      count: failing.length,
      items: failing.slice(0, PER_GROUP).map((w) => ({
        key: `f:${w.workflowId}`,
        icon: (
          <CircleX aria-hidden="true" className="size-4 text-status-critical" />
        ),
        href: workflowHref(login, w.repoFullName, w.workflowId),
        name: w.workflowName,
        repo: w.repoFullName,
        detail: t("overview.failingItem", {
          count: w.summary.failure,
          rate: formatPercent(w.summary.successRate, locale),
        }),
      })),
    },
    {
      label: t("overview.regressions"),
      count: regressions.length,
      items: regressions.slice(0, PER_GROUP).map((w) => ({
        key: `r:${w.workflowId}`,
        icon: (
          <TrendingUp
            aria-hidden="true"
            className="size-4 text-status-warning"
          />
        ),
        href: workflowHref(login, w.repoFullName, w.workflowId),
        name: w.workflowName,
        repo: w.repoFullName,
        detail: t("overview.regression", {
          metric: w.regression!.metric,
          recent: formatDuration(w.regression!.recent),
          baseline: formatDuration(w.regression!.baseline),
          ratio: w.regression!.ratio.toFixed(2),
        }),
      })),
    },
    {
      label: t("overview.successDrops"),
      count: drops.length,
      items: drops.slice(0, PER_GROUP).map((w) => ({
        key: `d:${w.workflowId}`,
        icon: (
          <TrendingDown
            aria-hidden="true"
            className="size-4 text-status-warning"
          />
        ),
        href: workflowHref(login, w.repoFullName, w.workflowId),
        name: w.workflowName,
        repo: w.repoFullName,
        detail: t("overview.successDrop", {
          recent: formatPercent(w.successDrop!.recent, locale),
          baseline: formatPercent(w.successDrop!.baseline, locale),
        }),
      })),
    },
    {
      label: t("overview.flakyJobs"),
      count: flaky.length,
      items: flaky.slice(0, PER_GROUP).map((f) => ({
        key: `k:${f.workflowId}:${f.baseName}`,
        icon: <Repeat aria-hidden="true" className="size-4 text-series-4" />,
        href: workflowHref(login, f.repoFullName, f.workflowId),
        name: `${f.baseName} · ${f.workflowName}`,
        repo: f.repoFullName,
        detail: t("overview.flakyRuns", { count: f.runs }),
      })),
    },
  ].filter((g) => g.items.length > 0);

  const noRuns = s.runs === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("overview.title")}
        subtitle={t("overview.subtitle", { range: rangeLabel })}
      />

      {noRuns && card ? (
        <GettingStarted
          importProgress={card.importProgress}
          webhookReceived={!!card.lastWebhookAt}
          settingsHref={isAdmin ? `${base}/settings` : undefined}
        />
      ) : null}

      <KpiStrip label={t("overview.kpiLabel")}>
        <KpiTile
          label={t("overview.kpi.runs")}
          info={t("overview.kpi.runsInfo")}
          value={formatNumber(s.runs, locale)}
          hint={rangeLabel}
          href={`${base}/repos?sort=runs`}
        />
        <KpiTile
          variant="delta"
          label={t("overview.kpi.success")}
          info={t("overview.kpi.successInfo")}
          value={formatPercent(s.successRate, locale)}
          delta={overview.successRateDelta}
          deltaText={t("overview.kpi.delta7d", {
            delta: formatPointsDelta(overview.successRateDelta, locale),
          })}
          href={`${base}/workflows?sort=success&dir=asc`}
        />
        <KpiTile
          label={t("overview.kpi.p95")}
          info={t("overview.kpi.p95Info")}
          value={
            enough
              ? approx(formatDuration(s.p95), s.approx)
              : t("common.notEnoughData")
          }
          hint={
            enough
              ? t("overview.kpi.p50Hint", {
                  p50: approx(formatDuration(s.p50), s.approx),
                })
              : t("kpi.samples", { n: s.n })
          }
          href={`${base}/workflows?sort=p95`}
        />
        <KpiTile
          label={t("overview.kpi.minutes")}
          info={t("overview.kpi.minutesInfo")}
          value={formatMinutes(overview.billableMinEst, locale)}
          hint={t("overview.kpi.queueHint", {
            queue: approx(formatDuration(s.queueP95), s.approx),
          })}
          href={`${base}/costs`}
        />
        {card && card.queuedLong > 0 ? (
          <KpiTile
            variant="status"
            icon={TriangleAlert}
            tone="warning"
            label={t("overview.kpi.queued")}
            info={t("overview.kpi.queuedInfo")}
            value={formatNumber(card.queuedNow, locale)}
            hint={t("dashboard.kpi.stuck", { count: card.queuedLong })}
            href={`${base}/queue?f=stuck`}
          />
        ) : (
          <KpiTile
            label={t("overview.kpi.queued")}
            info={t("overview.kpi.queuedInfo")}
            value={formatNumber(card?.queuedNow ?? 0, locale)}
            hint={t("overview.kpi.live")}
            href={`${base}/queue`}
          />
        )}
        {card && card.runnersOffline > 0 ? (
          <KpiTile
            variant="status"
            icon={Unplug}
            tone="warning"
            label={t("overview.kpi.offline")}
            info={t("overview.kpi.offlineInfo")}
            value={formatNumber(card.runnersOffline, locale)}
            hint={t("overview.kpi.offlineHint")}
            href={`${base}/runners?f=offline`}
          />
        ) : (
          <KpiTile
            label={t("overview.kpi.offline")}
            info={t("overview.kpi.offlineInfo")}
            value={formatNumber(card?.runnersOffline ?? 0, locale)}
            href={`${base}/runners`}
          />
        )}
      </KpiStrip>

      {overview.bucket === "hour" ? (
        <EmptyState quiet message={t("charts.hourlyNone")} />
      ) : noRuns ? null : (
        <div className="grid gap-4 lg:grid-cols-2">
          <RunsPerDayChart
            id="overview-runs"
            days={overview.perDay}
            bucket={overview.bucket}
          />
          <DurationChart
            id="overview-duration"
            days={overview.perDay}
            approx={s.approx}
            bucket={overview.bucket}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ListCard
          title={t("overview.attention")}
          showAll={`${base}/workflows?sort=success&dir=asc`}
          showAllLabel={t("overview.showAllWorkflows")}
        >
          {groups.length === 0 ? (
            <EmptyState quiet message={t("overview.noAttention")} />
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((g) => (
                <div key={g.label} className="flex flex-col gap-1">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {g.label} <span className="tabular-nums">({g.count})</span>
                  </h3>
                  <ul className="flex flex-col">
                    {g.items.map((i) => (
                      <li
                        key={i.key}
                        className="flex items-start gap-2 border-t py-1.5 text-sm first:border-t-0"
                      >
                        <span className="mt-0.5 shrink-0">{i.icon}</span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex flex-wrap items-baseline gap-x-1.5">
                            <Link
                              href={i.href}
                              className="font-medium underline-offset-2 hover:underline"
                            >
                              {i.name}
                            </Link>
                            <span className="text-xs text-muted-foreground">
                              {i.repo.split("/").pop()}
                            </span>
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {i.detail}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </ListCard>

        <div className="flex flex-col gap-4">
          <ListCard
            title={t("overview.mostActive")}
            showAll={`${base}/repos?sort=runs`}
            showAllLabel={t("overview.showAllRepos", {
              count: active.counts.active,
            })}
          >
            {active.rows.length === 0 ? (
              <EmptyState quiet message={t("overview.noActive")} />
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">
                  {t("overview.mostActive")}
                </caption>
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1 text-left font-normal">
                      {t("repos.repo")}
                    </th>
                    <th scope="col" className="py-1 text-right font-normal">
                      {t("repos.colRuns")}
                    </th>
                    <th scope="col" className="py-1 text-right font-normal">
                      {t("repos.colSuccess")}
                    </th>
                    <th
                      scope="col"
                      className="hidden py-1 text-right font-normal sm:table-cell"
                    >
                      {t("repos.colMinutes")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {active.rows.map((r) => (
                    <tr key={r.repositoryId} className="border-t">
                      <td className="py-1.5 pr-2">
                        <Link
                          href={repoHref(login, r.fullName)}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {r.name}
                        </Link>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatNumber(r.runs, locale)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatPercent(r.successRate, locale)}
                      </td>
                      <td className="hidden py-1.5 text-right tabular-nums sm:table-cell">
                        {formatMinutes(r.billableMinEst, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ListCard>
          {overview.bucket !== "hour" && !noRuns ? (
            <QueueChart
              id="overview-queue"
              days={overview.perDay}
              approx={s.approx}
              bucket={overview.bucket}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
