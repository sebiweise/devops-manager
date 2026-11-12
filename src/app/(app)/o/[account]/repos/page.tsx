import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { Sparkline } from "@/components/charts/sparkline";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  SearchBox,
} from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import {
  SelectionBar,
  SelectionProvider,
  SelectPageCheckbox,
  SelectRowCheckbox,
} from "@/components/data/selection";
import { RunStatusBadge, StatusBadge } from "@/components/data/status-badge";
import { repoHref, runHref } from "@/components/insights/workflow-link";
import { IgnoreSelectedButton } from "@/components/management/repo-ignore";
import { PageHeader } from "@/components/shell/page-header";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { RANGE_COOKIE, resolveRange } from "@/lib/range";
import { REPO_FILTERS, REPO_TABLE } from "@/lib/table-specs";
import { first, parseTableQuery, type SearchParamsLike } from "@/lib/url-state";
import { hasRole } from "@/server/authz/roles";
import { listRepoStats, type RepoStat } from "@/server/data/insights";
import { liveRepositories } from "@/server/data/live-repositories";
import { getManagementState } from "@/server/data/management";
import { accountMeta } from "@/lib/page-meta";

export const generateMetadata = accountMeta("repos");

/** Where the installation's repository selection is changed on GitHub. */
function selectionUrl(login: string, type: "USER" | "ORGANIZATION") {
  return type === "ORGANIZATION"
    ? `https://github.com/organizations/${encodeURIComponent(login)}/settings/installations`
    : "https://github.com/settings/installations";
}

export default async function ReposPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account } = await params;
  const sp = (await searchParams) as SearchParamsLike;
  const { scope, installation } = await loadAccount(account);
  // Refreshes the stored inventory from GitHub (falls back to stored rows).
  await orNotFound(liveRepositories(scope, installation));
  const query = parseTableQuery(sp, REPO_TABLE);
  const range = resolveRange(
    first(sp, "range"),
    (await cookies()).get(RANGE_COOKIE)?.value,
  );
  const [t, locale, page, state] = await Promise.all([
    getTranslations(),
    getLocale(),
    orNotFound(
      listRepoStats(scope, installation.id, {
        ...query,
        range,
        withMatching: hasRole(scope.role, "ADMIN"),
      }),
    ),
    orNotFound(getManagementState(scope, installation.id)),
  ]);
  const login = installation.accountLogin;
  const installationId = String(installation.id);
  const base = accountPath(login, "/repos");
  const rangeLabel = t(`filters.ranges.${range}`);
  const canIgnore = hasRole(scope.role, "ADMIN") && state.globalEnabled;
  const dash = <span aria-hidden="true">—</span>;
  // Column name with its window below, so headers stay narrow (also in German).
  const twoLine = (name: string, window: string) => (
    <span className="inline-flex flex-col leading-tight">
      <span>{name}</span>
      <span className="text-xs font-normal text-muted-foreground">
        {window}
      </span>
    </span>
  );
  const metric = (r: RepoStat, v: React.ReactNode) => (r.ignored ? dash : v);

  const columns: Column<RepoStat>[] = [
    {
      id: "repo",
      label: t("repos.repo"),
      header: t("repos.repo"),
      sortKey: "name",
      cell: (r) => (
        <div className="flex flex-col gap-1">
          <Link
            href={repoHref(login, r.fullName)}
            className="font-medium underline-offset-2 hover:underline"
          >
            {r.fullName}
          </Link>
          {r.private || r.archived || r.fork || r.ignored ? (
            <span className="flex flex-wrap gap-1">
              {r.ignored ? <StatusBadge kind="ignored" /> : null}
              {r.fork ? <StatusBadge kind="fork" /> : null}
              {r.private ? <StatusBadge kind="private" /> : null}
              {r.archived ? <StatusBadge kind="archived" /> : null}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "lastRun",
      label: t("repos.lastRun"),
      header: t("repos.lastRun"),
      sortKey: "lastRun",
      cell: (r) =>
        r.ignored ? (
          dash
        ) : r.lastRun ? (
          <Link
            href={runHref(login, r.lastRun.id)}
            title={r.lastRun.workflowName}
            className="flex items-center gap-2"
          >
            <RunStatusBadge
              status={r.lastRun.status}
              conclusion={r.lastRun.conclusion}
            />
            <span className="hidden max-w-40 truncate text-xs text-muted-foreground sm:inline">
              {r.lastRun.workflowName}
            </span>
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("repos.noRuns")}</span>
        ),
    },
    {
      id: "runs",
      label: t("repos.runs", { range: rangeLabel }),
      header: twoLine(t("repos.colRuns"), rangeLabel),
      sortKey: "runs",
      align: "right",
      hideBelow: "md",
      cell: (r) => metric(r, formatNumber(r.runs, locale)),
    },
    {
      id: "success",
      label: t("repos.success", { range: rangeLabel }),
      header: twoLine(t("repos.colSuccess"), rangeLabel),
      sortKey: "success",
      align: "right",
      hideBelow: "md",
      cell: (r) => metric(r, formatPercent(r.successRate, locale)),
    },
    {
      id: "p50",
      label: t("repos.p50Range", { range: rangeLabel }),
      header: twoLine(t("repos.colP50"), rangeLabel),
      sortKey: "p50",
      align: "right",
      hideBelow: "lg",
      cell: (r) =>
        metric(
          r,
          `${page.approx && r.p50Duration != null ? "~" : ""}${formatDuration(r.p50Duration)}`,
        ),
    },
    {
      id: "minutes",
      label: t("repos.minutes", { range: rangeLabel }),
      header: twoLine(t("repos.colMinutes"), rangeLabel),
      sortKey: "minutes",
      align: "right",
      hideBelow: "lg",
      cell: (r) => metric(r, formatMinutes(r.billableMinEst, locale)),
    },
    {
      id: "prs",
      label: t("repos.openPrs"),
      header: t("repos.openPrs"),
      sortKey: "prs",
      align: "right",
      hideBelow: "lg",
      cell: (r) =>
        r.openPrCount == null ? (
          dash
        ) : (
          <Link
            href={`${repoHref(login, r.fullName)}?tab=pulls`}
            className="underline-offset-2 hover:underline"
          >
            {formatNumber(r.openPrCount, locale)}
          </Link>
        ),
    },
    {
      id: "alerts",
      label: t("repos.alerts"),
      header: t("repos.alerts"),
      sortKey: "alerts",
      align: "right",
      hideBelow: "lg",
      cell: (r) =>
        r.openAlertCount == null ? (
          dash
        ) : (
          <Link
            href={`${repoHref(login, r.fullName)}?tab=dependabot`}
            title={
              r.openAlertHighCount
                ? t("repos.alertsHigh", { count: r.openAlertHighCount })
                : undefined
            }
            className="underline-offset-2 hover:underline"
          >
            {formatNumber(r.openAlertCount, locale)}
            {r.openAlertHighCount ? (
              <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                <TriangleAlert
                  aria-hidden="true"
                  className="size-3 text-status-warning"
                />
                {formatNumber(r.openAlertHighCount, locale)}
                <span className="sr-only">
                  {t("repos.alertsHigh", { count: r.openAlertHighCount })}
                </span>
              </span>
            ) : null}
          </Link>
        ),
    },
    {
      id: "trend",
      label: t("repos.trend"),
      header: twoLine(t("repos.colTrend"), t("repos.colTrendWindow")),
      hideBelow: "lg",
      cell: (r) => {
        if (r.ignored) return dash;
        const runs = r.sparkline.reduce((s, p) => s + p.runs, 0);
        const failures = r.sparkline.reduce((s, p) => s + p.failures, 0);
        return (
          <Sparkline
            id={`spark-${r.repositoryId}`}
            label={t("repos.sparkline", { runs, failures })}
            points={r.sparkline}
          />
        );
      },
    },
  ];

  const filtersActive = !!query.q || query.filters.length > 0;
  const table = (
    <DataTable
      caption={t("repos.title")}
      columns={columns}
      rows={page.rows}
      rowKey={(r) => r.repositoryId}
      muted={(r) => r.ignored}
      sort={{ key: query.sort, dir: query.dir, base, params: sp }}
      selectHeader={canIgnore ? <SelectPageCheckbox /> : undefined}
      selectCell={
        canIgnore
          ? (r) =>
              r.ignored ? null : (
                <SelectRowCheckbox
                  item={{ id: r.repositoryId, label: r.fullName, fork: r.fork }}
                />
              )
          : undefined
      }
      empty={
        <EmptyState
          message={
            filtersActive ? (
              t("repos.noMatch")
            ) : (
              <>
                {t("account.noRepos")}{" "}
                <a
                  className="underline"
                  href={selectionUrl(login, installation.accountType)}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t("repos.changeSelection")}
                </a>
              </>
            )
          }
        />
      }
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("repos.title")}
        subtitle={t("repos.subtitle", {
          count: page.counts.active,
          ignored: page.counts.ignored,
        })}
      />
      <FilterBar>
        <SearchBox label={t("repos.filter")} />
        <FilterChips
          label={t("repos.chips.label")}
          options={REPO_FILTERS.map((f) => ({
            value: f,
            label: t(`repos.chips.${f}`),
            ...(f === "forks"
              ? { count: page.counts.forks }
              : f === "ignored"
                ? { count: page.counts.ignored }
                : {}),
          }))}
        />
        <ClearFilters />
      </FilterBar>
      {page.approx ? (
        <p className="text-xs text-muted-foreground">{t("repos.approx")}</p>
      ) : null}
      {canIgnore ? (
        <SelectionProvider
          total={page.total}
          page={page.rows
            .filter((r) => !r.ignored)
            .map((r) => ({
              id: r.repositoryId,
              label: r.fullName,
              fork: r.fork,
            }))}
          matching={(page.matching ?? []).map((r) => ({
            id: r.id,
            label: r.fullName,
            fork: r.fork,
          }))}
        >
          {table}
          <SelectionBar>
            <IgnoreSelectedButton installationId={installationId} />
          </SelectionBar>
        </SelectionProvider>
      ) : (
        table
      )}
      {page.total > 0 ? (
        <Pagination
          base={base}
          params={sp}
          page={page.page}
          size={page.size}
          total={page.total}
        />
      ) : null}
    </div>
  );
}
