import { Ban, TriangleAlert, UserRoundCheck } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  ParamSelect,
  SearchBox,
} from "@/components/data/filter-bar";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import { Pagination } from "@/components/data/pagination";
import { StatusBadge } from "@/components/data/status-badge";
import { AutoRefresh } from "@/components/insights/auto-refresh";
import { repoHref, runHref } from "@/components/insights/workflow-link";
import { LabelList } from "@/components/runners/runner-badges";
import { PageHeader } from "@/components/shell/page-header";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { formatDuration, formatNumber } from "@/lib/format";
import { accountMeta } from "@/lib/page-meta";
import { lazyRunnerSample } from "@/lib/runner-sample";
import { pageQueueGroups, pageQueueJobs } from "@/lib/table-pages";
import { QUEUE_FILTERS, QUEUE_TABLE } from "@/lib/table-specs";
import {
  first,
  hrefWith,
  parseTableQuery,
  withParams,
  type SearchParamsLike,
} from "@/lib/url-state";
import { cn } from "@/lib/utils";
import {
  getLiveQueue,
  type QueueGroupDto,
  type QueueJobDto,
} from "@/server/data/runners";

export const generateMetadata = accountMeta("queue");

const VIEWS = ["groups", "jobs"] as const;
type View = (typeof VIEWS)[number];

/**
 * Live queue (UI overhaul §2.11): KPIs (queued, oldest and 95 % wait,
 * stuck, no matching runner, waiting for approval; the flag tiles apply
 * their filter), search, a repository filter, the Stuck / No matching
 * runner chips and two views — grouped by runner labels and repository,
 * each group expanding to its jobs, or all jobs as one paged list, oldest
 * first. Approvals are a collapsed section. Opening the page schedules a
 * lazy runner sample, so STUCK reflects fresh runner state; the page
 * refreshes every 30 s.
 */
export default async function QueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account } = await params;
  const sp = (await searchParams) as SearchParamsLike;
  const { scope, installation } = await loadAccount(account);
  const sampling = await lazyRunnerSample(installation.id);
  const [t, locale, format, queue] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(getLiveQueue(scope, installation.id)),
  ]);
  const login = installation.accountLogin;
  const base = accountPath(login, "/queue");
  const rawView = first(sp, "view");
  const view: View = (VIEWS as readonly string[]).includes(rawView ?? "")
    ? (rawView as View)
    : "groups";
  const query = parseTableQuery(sp, QUEUE_TABLE);
  const repo = first(sp, "repo");
  const repositoryId = repo && /^\d{1,20}$/.test(repo) ? repo : undefined;
  const listQuery = { ...query, ...(repositoryId ? { repositoryId } : {}) };
  const groups = pageQueueGroups(queue.groups, listQuery);
  const jobs = pageQueueJobs(queue.jobs, listQuery);
  const noRunner = queue.jobs.filter((j) => j.noMatchingRunner).length;
  // Nearest-rank 95th percentile of the current waits.
  const ages = queue.jobs.map((j) => j.ageS).sort((a, b) => a - b);
  const p95 =
    ages.length > 0
      ? ages[Math.min(ages.length - 1, Math.ceil(0.95 * ages.length) - 1)]!
      : null;
  const repos = [
    ...new Map(queue.jobs.map((j) => [j.repositoryId, j.repoFullName])),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const short = (name: string) => name.split("/").pop() ?? name;

  const flags = (stuck: number | boolean, none: boolean) => {
    const n = typeof stuck === "number" ? stuck : stuck ? 1 : 0;
    if (n === 0 && !none)
      return <span className="text-muted-foreground">—</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {n > 0 ? (
          <StatusBadge
            kind="stuck"
            label={
              typeof stuck === "number"
                ? t("queue.stuckCount", { count: n })
                : undefined
            }
          />
        ) : null}
        {none ? <StatusBadge kind="noRunner" /> : null}
      </span>
    );
  };
  const workflowsOf = (names: string[]) =>
    names.length <= 1 ? (
      (names[0] ?? "—")
    ) : (
      <span title={names.join(", ")}>
        {t("queue.workflowsMore", {
          first: names[0]!,
          count: names.length - 1,
        })}
      </span>
    );

  const jobColumns: Column<QueueJobDto>[] = [
    {
      id: "job",
      label: t("queue.job"),
      header: t("queue.job"),
      cell: (j) => (
        <div className="flex flex-col">
          <Link
            href={runHref(login, j.runId)}
            className="font-medium underline-offset-2 hover:underline"
          >
            {j.name}
          </Link>
          <span className="text-xs text-muted-foreground">
            {j.workflowName}
          </span>
        </div>
      ),
    },
    {
      id: "repo",
      label: t("queue.repo"),
      header: t("queue.repo"),
      hideBelow: "md",
      cell: (j) => (
        <Link
          href={repoHref(login, j.repoFullName)}
          className="underline-offset-2 hover:underline"
        >
          {short(j.repoFullName)}
        </Link>
      ),
    },
    {
      id: "labels",
      label: t("queue.labels"),
      header: t("queue.labels"),
      hideBelow: "lg",
      cell: (j) => <LabelList labels={j.labels} max={3} />,
    },
    {
      id: "age",
      label: t("queue.age"),
      header: t("queue.age"),
      align: "right",
      cell: (j) => formatDuration(j.ageS),
    },
    {
      id: "flags",
      label: t("queue.flags"),
      header: t("queue.flags"),
      cell: (j) => flags(j.stuck, j.noMatchingRunner),
    },
  ];
  const jobsOfGroup = (g: QueueGroupDto) =>
    queue.jobs
      .filter(
        (j) =>
          j.repositoryId === g.repositoryId &&
          j.labels.join(",") === g.labels.join(","),
      )
      .sort((a, b) => b.ageS - a.ageS);

  const groupColumns: Column<QueueGroupDto>[] = [
    {
      id: "pool",
      label: t("queue.group"),
      header: t("queue.group"),
      cell: (g) => (
        <div className="flex flex-col gap-1">
          <LabelList labels={g.labels} max={3} />
          <Link
            href={repoHref(login, g.repoFullName)}
            className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {short(g.repoFullName)}
          </Link>
        </div>
      ),
    },
    {
      id: "count",
      label: t("queue.count"),
      header: t("queue.count"),
      sortKey: "count",
      align: "right",
      cell: (g) => formatNumber(g.count, locale),
    },
    {
      id: "oldest",
      label: t("queue.oldest"),
      header: t("queue.oldest"),
      sortKey: "age",
      align: "right",
      cell: (g) => formatDuration(g.oldestAgeS),
    },
    {
      id: "p95",
      label: t("queue.p95"),
      header: t("queue.p95"),
      align: "right",
      hideBelow: "md",
      cell: (g) => formatDuration(g.p95AgeS),
    },
    {
      id: "workflows",
      label: t("queue.workflows"),
      header: t("queue.workflows"),
      hideBelow: "lg",
      cell: (g) => workflowsOf(g.workflows),
    },
    {
      id: "flags",
      label: t("queue.flags"),
      header: t("queue.flags"),
      hideBelow: "md",
      cell: (g) => flags(g.stuck, g.noMatchingRunner),
    },
  ];

  const page = view === "groups" ? groups : jobs;

  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh />
      <PageHeader
        title={t("queue.title")}
        subtitle={
          <time dateTime={queue.at}>
            {t("queue.live", {
              time: format.dateTime(new Date(queue.at), {
                timeStyle: "medium",
              }),
            })}
          </time>
        }
        info={sampling ? t("runners.sampling") : undefined}
        infoLabel={sampling ? t("queue.samplingLabel") : undefined}
      />

      <KpiStrip label={t("overview.kpiLabel")}>
        <KpiTile
          label={t("queue.kpi.queued")}
          info={t("queue.kpi.queuedInfo")}
          value={formatNumber(queue.jobs.length, locale)}
          hint={t("queue.kpi.groups", { count: queue.groups.length })}
        />
        <KpiTile
          label={t("queue.kpi.oldest")}
          value={formatDuration(queue.oldestAgeS)}
        />
        <KpiTile
          label={t("queue.kpi.p95")}
          info={t("queue.kpi.p95Info")}
          value={formatDuration(p95)}
        />
        {queue.stuck > 0 ? (
          <KpiTile
            variant="status"
            icon={TriangleAlert}
            tone="critical"
            label={t("queue.kpi.stuck")}
            info={t("badge.stuck.info")}
            value={formatNumber(queue.stuck, locale)}
            href={withParams(base, { f: "stuck" })}
          />
        ) : (
          <KpiTile
            label={t("queue.kpi.stuck")}
            info={t("badge.stuck.info")}
            value={formatNumber(queue.stuck, locale)}
          />
        )}
        {noRunner > 0 ? (
          <KpiTile
            variant="status"
            icon={Ban}
            tone="warning"
            label={t("queue.kpi.noRunner")}
            info={t("badge.noRunner.info")}
            value={formatNumber(noRunner, locale)}
            href={withParams(base, { f: "noRunner" })}
          />
        ) : (
          <KpiTile
            label={t("queue.kpi.noRunner")}
            info={t("badge.noRunner.info")}
            value={formatNumber(noRunner, locale)}
          />
        )}
        {queue.approvals.length > 0 ? (
          <KpiTile
            variant="status"
            icon={UserRoundCheck}
            tone="neutral"
            label={t("queue.kpi.approval")}
            info={t("badge.approval.info")}
            value={formatNumber(queue.approvals.length, locale)}
            href={withParams(base, { approvals: "1" }) + "#approvals"}
          />
        ) : (
          <KpiTile
            label={t("queue.kpi.approval")}
            info={t("badge.approval.info")}
            value={formatNumber(queue.approvals.length, locale)}
          />
        )}
      </KpiStrip>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar>
          <SearchBox label={t("queue.search")} />
          {repos.length > 1 ? (
            <ParamSelect
              label={t("queue.repo")}
              param="repo"
              allLabel={t("workflows.allRepos")}
              options={repos.map(([id, name]) => ({
                value: id,
                label: short(name),
              }))}
            />
          ) : null}
          <FilterChips
            label={t("queue.chips")}
            options={QUEUE_FILTERS.map((f) => ({
              value: f,
              label: t(`badge.${f}.label`),
              count: f === "stuck" ? queue.stuck : noRunner,
            }))}
          />
          <ClearFilters keys={["q", "f", "repo"]} />
        </FilterBar>
        <div
          role="group"
          aria-label={t("queue.viewLabel")}
          className="inline-flex rounded-md border p-0.5"
        >
          {VIEWS.map((v) => (
            <Link
              key={v}
              href={hrefWith(base, sp, {
                view: v === "groups" ? undefined : v,
                page: undefined,
              })}
              aria-current={view === v ? "true" : undefined}
              className={cn(
                "rounded px-2.5 py-1 text-xs",
                view === v
                  ? "bg-secondary font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`queue.view.${v}`)}
            </Link>
          ))}
        </div>
      </div>

      {queue.jobs.length === 0 ? (
        <EmptyState message={t("queue.empty")} />
      ) : view === "groups" ? (
        <DataTable
          caption={t("queue.groups")}
          columns={groupColumns}
          rows={groups.rows}
          rowKey={(g) => `${g.labelKey}|${g.repositoryId}`}
          sort={{ key: query.sort, dir: query.dir, base, params: sp }}
          expanderLabel={(g) => t("queue.showJobs", { count: g.count })}
          extra={(g) => (
            <ul className="flex flex-col gap-1">
              {jobsOfGroup(g).map((j) => (
                <li
                  key={j.jobId}
                  className="flex flex-wrap items-center justify-between gap-x-3"
                >
                  <Link
                    href={runHref(login, j.runId)}
                    className="underline-offset-2 hover:underline"
                  >
                    {j.name}
                    <span className="text-muted-foreground">
                      {" · "}
                      {j.workflowName}
                    </span>
                  </Link>
                  <span className="flex items-center gap-2 tabular-nums">
                    {formatDuration(j.ageS)}
                    {j.stuck ? <StatusBadge kind="stuck" /> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          empty={<EmptyState message={t("queue.noMatch")} />}
        />
      ) : (
        <DataTable
          caption={t("queue.jobs")}
          columns={jobColumns}
          rows={jobs.rows}
          rowKey={(j) => j.jobId}
          empty={<EmptyState message={t("queue.noMatch")} />}
        />
      )}
      {page.total > 0 && queue.jobs.length > 0 ? (
        <Pagination
          base={base}
          params={sp}
          page={page.page}
          size={page.size}
          total={page.total}
        />
      ) : null}

      <section id="approvals" className="flex scroll-mt-4 flex-col gap-2">
        {queue.approvals.length === 0 ? (
          <EmptyState quiet message={t("queue.approvals.empty")} />
        ) : (
          <details open={first(sp, "approvals") === "1" || undefined}>
            <summary className="w-fit cursor-pointer font-medium select-none">
              {t("queue.approvals.titleCount", {
                count: queue.approvals.length,
              })}
            </summary>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("queue.approvals.description")}
            </p>
            <DataTable
              caption={t("queue.approvals.title")}
              columns={jobColumns.filter((c) => c.id !== "flags")}
              rows={queue.approvals}
              rowKey={(j) => j.jobId}
            />
          </details>
        )}
      </section>
    </div>
  );
}
