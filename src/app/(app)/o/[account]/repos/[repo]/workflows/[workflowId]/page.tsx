import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import { StatusBadge } from "@/components/data/status-badge";
import {
  DurationChart,
  MinutesChart,
  QueueChart,
  RunsPerDayChart,
  SuccessRateChart,
} from "@/components/insights/day-charts";
import { RunsSection } from "@/components/insights/runs-section";
import { repoHref, workflowHref } from "@/components/insights/workflow-link";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { loadAccount, orNotFound } from "@/lib/account-page";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import {
  enoughData,
  hostedVsSelfHosted,
  MIN_SAMPLES,
  param,
  type SearchParams,
} from "@/lib/insights-view";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import { pageRows } from "@/lib/paging";
import { RANGE_BUCKET } from "@/lib/range";
import { hrefWith } from "@/lib/url-state";
import {
  findRepositoryByName,
  getWorkflowDetail,
  type JobBreakdown,
} from "@/server/data/insights";
import { getManagementState } from "@/server/data/management";

export const generateMetadata = accountMeta("workflow");

const JOB_SORTS = [
  "name",
  "jobs",
  "p50",
  "p95",
  "queue",
  "failure",
  "minutes",
] as const;
type JobSort = (typeof JOB_SORTS)[number];
/** Jobs shown before "Show all". */
const TOP_JOBS = 10;

/**
 * A workflow (UI overhaul §2.6): breadcrumbs, KPIs (runs, success, first
 * try, typical and 95 % duration, minutes), runs and duration per bucket,
 * the success, queue and minutes charts behind a disclosure, the slowest
 * jobs (sortable, top 10 with "Show all"), hosted vs self-hosted, and the
 * run list with filters and cursor paging.
 */
export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; repo: string; workflowId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account, repo: repoParam, workflowId } = await params;
  const sp = await searchParams;
  if (!/^\d{1,20}$/.test(workflowId)) notFound();
  const { scope, installation } = await loadAccount(account);
  const repo = await findRepositoryByName(
    scope,
    installation.id,
    decodeURIComponent(repoParam),
  );
  if (!repo || repo.ignored) notFound();
  const range = await pageRange(sp);
  const id = BigInt(workflowId);
  const detail = await orNotFound(
    getWorkflowDetail(scope, installation.id, id, range),
  );
  // The workflow must belong to the repository of the URL.
  if (detail.repositoryId !== repo.id) notFound();

  const [t, locale, state] = await Promise.all([
    getTranslations(),
    getLocale(),
    orNotFound(getManagementState(scope, installation.id)),
  ]);
  const login = installation.accountLogin;
  const base = workflowHref(login, repo.fullName, detail.workflowId);
  const s = detail.summary;
  const enough = enoughData(s.n);
  const percentile = (v: number | null, n = s.n) =>
    enoughData(n) ? (
      approx(formatDuration(v), detail.approx)
    ) : (
      <span className="text-xs text-muted-foreground">
        {t("workflows.fewRuns")}
      </span>
    );
  const compare = hostedVsSelfHosted(detail.jobs);
  const rangeLabel = t(`filters.ranges.${range}`);
  const name = detail.workflowName || detail.workflowId;

  // Slowest jobs: sorted in memory (one row per job and runner group).
  const rawSort = param(sp, "sort");
  const sort: JobSort = (JOB_SORTS as readonly string[]).includes(rawSort ?? "")
    ? (rawSort as JobSort)
    : "p95";
  const dir =
    param(sp, "dir") === "asc" || param(sp, "dir") === "desc"
      ? (param(sp, "dir") as "asc" | "desc")
      : sort === "name"
        ? "asc"
        : "desc";
  const allJobs = param(sp, "jobs") === "all";
  const enoughJob = (j: JobBreakdown) => enoughData(j.jobs);
  const sorted = pageRows(
    detail.jobs,
    { sort, dir, page: 1, size: Math.max(1, detail.jobs.length) },
    {
      text: (j) => `${j.baseName} ${j.labelKey}`,
      keys: {
        name: (j) => j.baseName.toLowerCase(),
        jobs: (j) => j.jobs,
        p50: (j) => (enoughJob(j) ? j.p50 : null),
        p95: (j) => (enoughJob(j) ? j.p95 : null),
        queue: (j) => (enoughJob(j) ? j.queueP95 : null),
        failure: (j) => j.failureRate,
        minutes: (j) => j.billableMinEst,
      },
    },
  ).rows;
  const shownJobs = allJobs ? sorted : sorted.slice(0, TOP_JOBS);
  const maxOf = (f: (j: JobBreakdown) => number | null) =>
    Math.max(1e-9, ...detail.jobs.map((j) => (enoughJob(j) ? (f(j) ?? 0) : 0)));
  const p95Max = maxOf((j) => j.p95);
  const p50Max = maxOf((j) => j.p50);
  const jobColumns: Column<JobBreakdown>[] = [
    {
      id: "name",
      label: t("workflow.job"),
      header: t("workflow.job"),
      sortKey: "name",
      cell: (j) => (
        <div className="flex flex-col">
          <span className="font-medium">{j.baseName}</span>
          <span className="text-xs text-muted-foreground">
            {j.labelKey || "—"} · {t(`runnerKind.${j.runnerKind}`)}
          </span>
        </div>
      ),
    },
    {
      id: "jobs",
      label: t("workflow.count"),
      header: t("workflow.count"),
      sortKey: "jobs",
      align: "right",
      cell: (j) => formatNumber(j.jobs, locale),
    },
    {
      id: "p50",
      label: t("charts.p50"),
      header: t("charts.p50"),
      sortKey: "p50",
      align: "right",
      hideBelow: "md",
      magnitude: (j) => (enoughJob(j) ? (j.p50 ?? 0) / p50Max : null),
      cell: (j) => percentile(j.p50, j.jobs),
    },
    {
      id: "p95",
      label: t("charts.p95"),
      header: t("charts.p95"),
      sortKey: "p95",
      align: "right",
      magnitude: (j) => (enoughJob(j) ? (j.p95 ?? 0) / p95Max : null),
      cell: (j) => percentile(j.p95, j.jobs),
    },
    {
      id: "queue",
      label: t("charts.queueP95"),
      header: t("charts.queueP95"),
      sortKey: "queue",
      align: "right",
      hideBelow: "lg",
      cell: (j) => percentile(j.queueP95, j.jobs),
    },
    {
      id: "failure",
      label: t("workflow.failureRate"),
      header: t("workflow.failureRate"),
      sortKey: "failure",
      align: "right",
      hideBelow: "lg",
      cell: (j) => formatPercent(j.failureRate, locale),
    },
    {
      id: "flaky",
      label: t("workflow.flaky"),
      header: t("workflow.flaky"),
      align: "right",
      hideBelow: "lg",
      cell: (j) => formatNumber(j.flakyRuns, locale),
    },
    {
      id: "minutes",
      label: t("charts.minutes"),
      header: t("charts.minutes"),
      sortKey: "minutes",
      align: "right",
      hideBelow: "lg",
      cell: (j) => formatMinutes(j.billableMinEst, locale),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          range={param(sp, "range")}
          items={[
            { kind: "accounts" },
            { kind: "account", login },
            { kind: "section", login, section: "repos" },
            {
              kind: "repo",
              login,
              name: repo.fullName.split("/").pop() ?? repo.fullName,
              fullName: repo.fullName,
            },
            {
              kind: "workflow",
              login,
              repoFullName: repo.fullName,
              name,
              id: detail.workflowId,
            },
          ]}
        />
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {name}
              {detail.regression ? (
                <StatusBadge
                  kind="regression"
                  label={t("workflows.regressionBadge", {
                    metric: detail.regression.metric,
                  })}
                />
              ) : null}
              {detail.successDrop ? <StatusBadge kind="successDrop" /> : null}
            </span>
          }
          subtitle={
            <>
              <Link
                href={repoHref(login, repo.fullName)}
                className="underline-offset-2 hover:underline"
              >
                {repo.fullName}
              </Link>
              {" · "}
              {t("workflow.subtitle", { range: rangeLabel })}
            </>
          }
          actions={
            <a
              href={`https://github.com/${repo.fullName}/actions`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              {t("repo.openOnGithub")}
            </a>
          }
        />
      </div>

      {!enough ? (
        <EmptyState
          quiet
          message={t("workflow.notEnough", { n: s.n, min: MIN_SAMPLES })}
        />
      ) : null}

      <KpiStrip label={t("overview.kpiLabel")}>
        <KpiTile
          label={t("workflows.runs")}
          value={formatNumber(s.runs, locale)}
          hint={rangeLabel}
        />
        <KpiTile
          label={t("overview.kpi.success")}
          info={t("overview.kpi.successInfo")}
          value={formatPercent(s.successRate, locale)}
          hint={
            detail.successDrop
              ? t("overview.successDrop", {
                  recent: formatPercent(detail.successDrop.recent, locale),
                  baseline: formatPercent(detail.successDrop.baseline, locale),
                })
              : t("workflow.flakyHint", {
                  rate: formatPercent(s.flakyRate, locale),
                  count: s.flakyRecovered,
                })
          }
        />
        <KpiTile
          label={t("workflow.firstTryLabel")}
          info={t("workflow.firstTryInfo")}
          value={formatPercent(s.firstTrySuccessRate, locale)}
        />
        <KpiTile
          label={t("charts.p50")}
          info={t("workflow.p50Info")}
          value={
            enough
              ? approx(formatDuration(s.p50), detail.approx)
              : t("common.notEnoughData")
          }
          hint={t("kpi.samples", { n: s.n })}
        />
        <KpiTile
          label={t("charts.p95")}
          info={t("overview.kpi.p95Info")}
          value={
            enough
              ? approx(formatDuration(s.p95), detail.approx)
              : t("common.notEnoughData")
          }
          hint={
            detail.regression
              ? t("overview.regression", {
                  metric: detail.regression.metric,
                  recent: formatDuration(detail.regression.recent),
                  baseline: formatDuration(detail.regression.baseline),
                  ratio: detail.regression.ratio.toFixed(2),
                })
              : undefined
          }
        />
        <KpiTile
          label={t("overview.kpi.minutes")}
          info={t("overview.kpi.minutesInfo")}
          value={formatMinutes(
            detail.perDay.reduce((sum, d) => sum + d.billableMinEst, 0),
            locale,
          )}
        />
      </KpiStrip>

      {range === "24h" ? (
        <EmptyState quiet message={t("charts.hourlyNone")} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <RunsPerDayChart
              id="wf-runs"
              days={detail.perDay}
              bucket={RANGE_BUCKET[range]}
            />
            <DurationChart
              id="wf-duration"
              days={detail.perDay}
              approx={detail.approx}
              bucket={RANGE_BUCKET[range]}
            />
          </div>
          <details className="group">
            <summary className="w-fit cursor-pointer text-sm text-muted-foreground select-none hover:text-foreground">
              {t("workflow.moreCharts")}
            </summary>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <SuccessRateChart
                id="wf-success"
                days={detail.perDay}
                bucket={RANGE_BUCKET[range]}
              />
              <QueueChart
                id="wf-queue"
                days={detail.perDay}
                approx={detail.approx}
                bucket={RANGE_BUCKET[range]}
              />
              <MinutesChart
                id="wf-minutes"
                days={detail.perDay}
                bucket={RANGE_BUCKET[range]}
              />
            </div>
          </details>
        </>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">{t("workflow.slowestJobs")}</h2>
          <span className="text-xs text-muted-foreground">
            {t("workflow.jobsHint")}
          </span>
        </div>
        <DataTable
          caption={t("workflow.slowestJobs")}
          columns={jobColumns}
          rows={shownJobs}
          rowKey={(j) => `${j.baseName}|${j.labelKey}|${j.runnerKind}`}
          sort={{ key: sort, dir, base, params: sp }}
          empty={<EmptyState quiet message={t("workflow.noJobs")} />}
        />
        {detail.jobs.length > TOP_JOBS ? (
          <Link
            href={hrefWith(base, sp, { jobs: allJobs ? undefined : "all" })}
            scroll={false}
            className="w-fit text-sm underline-offset-2 hover:underline"
          >
            {allJobs
              ? t("workflow.showTop", { n: TOP_JOBS })
              : t("workflow.showAll", { n: detail.jobs.length })}
          </Link>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">{t("workflow.compare")}</h2>
          <span className="text-xs text-muted-foreground">
            {t("workflow.compareHint")}
          </span>
        </div>
        {compare.length === 0 ? (
          <EmptyState quiet message={t("workflow.compareEmpty")} />
        ) : (
          <DataTable
            caption={t("workflow.compare")}
            columns={[
              {
                id: "job",
                label: t("workflow.job"),
                header: t("workflow.job"),
                cell: (c) => <span className="font-medium">{c.baseName}</span>,
              },
              {
                id: "hp50",
                label: t("workflow.hostedP50"),
                header: t("workflow.hostedP50"),
                align: "right",
                cell: (c) => formatDuration(c.hosted.p50),
              },
              {
                id: "sp50",
                label: t("workflow.selfHostedP50"),
                header: t("workflow.selfHostedP50"),
                align: "right",
                cell: (c) => formatDuration(c.selfHosted.p50),
              },
              {
                id: "hp95",
                label: t("workflow.hostedP95"),
                header: t("workflow.hostedP95"),
                align: "right",
                hideBelow: "lg",
                cell: (c) => formatDuration(c.hosted.p95),
              },
              {
                id: "sp95",
                label: t("workflow.selfHostedP95"),
                header: t("workflow.selfHostedP95"),
                align: "right",
                hideBelow: "lg",
                cell: (c) => formatDuration(c.selfHosted.p95),
              },
              {
                id: "queue",
                label: t("workflow.queueCompare"),
                header: t("workflow.queueCompare"),
                align: "right",
                hideBelow: "lg",
                cell: (c) =>
                  `${formatDuration(c.hosted.queueP95)} / ${formatDuration(c.selfHosted.queueP95)}`,
              },
              {
                id: "delta",
                label: t("workflow.delta"),
                header: t("workflow.delta"),
                align: "right",
                cell: (c) =>
                  c.deltaP50 == null
                    ? "—"
                    : formatPercent(c.deltaP50, locale, 0),
              },
            ]}
            rows={compare}
            rowKey={(c) => c.baseName}
          />
        )}
      </section>

      <RunsSection
        scope={scope}
        installationId={installation.id}
        repositoryId={BigInt(repo.id)}
        workflowId={id}
        login={login}
        base={base}
        sp={sp}
        hidden={{}}
        canOperate={state.canOperate}
        title={t("workflow.recentRuns")}
        showWorkflow={false}
      />
    </div>
  );
}
