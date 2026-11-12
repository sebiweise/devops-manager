import { RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Sparkline, TrendTable } from "@/components/charts/sparkline";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  SearchBox,
  SortSelect,
} from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import {
  SelectionBar,
  SelectionProvider,
  SelectPageCheckbox,
  SelectRowCheckbox,
} from "@/components/data/selection";
import {
  runBadgeKind,
  StatusBadge,
  StatusIcon,
} from "@/components/data/status-badge";
import { repoHref, runHref } from "@/components/insights/workflow-link";
import {
  IgnoreSelectedButton,
  RepoRowMenu,
} from "@/components/management/repo-ignore";
import { PageHeader } from "@/components/shell/page-header";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import { REPO_FILTERS, REPO_SORTS, REPO_TABLE } from "@/lib/table-specs";
import {
  first,
  hrefWith,
  parseTableQuery,
  withParams,
  type SearchParamsLike,
} from "@/lib/url-state";
import { hasRole } from "@/server/authz/roles";
import { listRepoStats, type RepoStat } from "@/server/data/insights";
import { liveRepositories } from "@/server/data/live-repositories";
import { getManagementState } from "@/server/data/management";

export const generateMetadata = accountMeta("repos");

/** Below this success rate the cell gets a warning icon (with enough runs). */
const LOW_SUCCESS = 0.8;

/** Where the installation's repository selection is changed on GitHub. */
function selectionUrl(login: string, type: "USER" | "ORGANIZATION") {
  return type === "ORGANIZATION"
    ? `https://github.com/organizations/${encodeURIComponent(login)}/settings/installations`
    : "https://github.com/settings/installations";
}

/**
 * Repositories (UI overhaul §2.3): search, filter chips (failing, forks,
 * private, archived, show ignored), sortable server-paged table whose
 * metrics follow the shared range, and for admins explicit selection with
 * "Ignore selected" plus a row menu. The inventory is kept by reconcile and
 * webhooks; operators can refresh it from GitHub on demand.
 */
export default async function ReposPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account } = await params;
  const raw = (await searchParams) as Record<string, string | undefined>;
  const { scope, installation } = await loadAccount(account);
  const canRefresh = hasRole(scope.role, "OPERATOR");
  const login = installation.accountLogin;
  const base = accountPath(login, "/repos");
  // Explicit "Refresh list from GitHub" (operator+): reads the list live,
  // updates the stored inventory (stored rows when GitHub is unreachable),
  // then drops the trigger from the URL so links do not repeat it.
  if (first(raw, "refresh") === "1") {
    const result = canRefresh
      ? await orNotFound(liveRepositories(scope, installation))
      : null;
    redirect(
      hrefWith(base, raw, {
        refresh: undefined,
        refreshed: result ? result.source : undefined,
      }),
    );
  }
  const refreshed = canRefresh ? first(raw, "refreshed") : undefined;
  // Links (sort, pages) do not carry the one-off refresh note.
  const sp: SearchParamsLike = { ...raw, refreshed: undefined };
  const query = parseTableQuery(sp, REPO_TABLE);
  const range = await pageRange(sp);
  const now = new Date();
  const [t, locale, format, page, state] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(
      listRepoStats(
        scope,
        installation.id,
        { ...query, range, withMatching: hasRole(scope.role, "ADMIN") },
        now,
      ),
    ),
    orNotFound(getManagementState(scope, installation.id)),
  ]);
  const installationId = String(installation.id);
  const rangeLabel = t(`filters.short.${range}`);
  const isAdmin = hasRole(scope.role, "ADMIN");
  const canIgnore = isAdmin && state.globalEnabled;
  const dash = (
    <span aria-label={t("repos.noValue")} className="text-muted-foreground">
      —
    </span>
  );
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
  const runsMax = Math.max(1, ...page.rows.map((r) => r.runs));
  const minutesMax = Math.max(1, ...page.rows.map((r) => r.billableMinEst));

  const columns: Column<RepoStat>[] = [
    {
      id: "repo",
      label: t("repos.repo"),
      header: t("repos.repo"),
      sortKey: "name",
      cell: (r) => (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={repoHref(login, r.fullName)}
            title={r.fullName}
            className="font-medium underline-offset-2 hover:underline"
          >
            {r.name}
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
      hideBelow: "sm",
      cell: (r) => {
        if (r.ignored) return dash;
        if (!r.lastRun)
          return (
            <span className="text-xs text-muted-foreground">
              {t("repos.noRuns")}
            </span>
          );
        const kind = runBadgeKind(r.lastRun.status, r.lastRun.conclusion);
        const status = kind ? t(`badge.${kind}.label`) : r.lastRun.status;
        return (
          <Link
            href={runHref(login, r.lastRun.id)}
            title={`${status} · ${r.lastRun.workflowName}`}
            className="inline-flex items-center gap-1.5 whitespace-nowrap underline-offset-2 hover:underline"
          >
            <StatusIcon
              kind={kind}
              label={`${status} · ${r.lastRun.workflowName}`}
            />
            <span className="text-sm">
              {format.relativeTime(new Date(r.lastRun.createdAt), now)}
            </span>
          </Link>
        );
      },
    },
    {
      id: "runs",
      label: t("repos.runs", { range: rangeLabel }),
      header: twoLine(t("repos.colRuns"), rangeLabel),
      sortKey: "runs",
      align: "right",
      magnitude: (r) => (r.ignored ? null : r.runs / runsMax),
      cell: (r) => metric(r, formatNumber(r.runs, locale)),
    },
    {
      id: "success",
      label: t("repos.success", { range: rangeLabel }),
      header: twoLine(t("repos.colSuccess"), rangeLabel),
      sortKey: "success",
      align: "right",
      hideBelow: "md",
      cell: (r) =>
        metric(
          r,
          r.successRate != null && r.successRate < LOW_SUCCESS ? (
            <span className="inline-flex items-center gap-1 font-medium">
              <TriangleAlert
                aria-hidden="true"
                className="size-3.5 text-status-warning"
              />
              {formatPercent(r.successRate, locale)}
              <span className="sr-only">{t("repos.lowSuccess")}</span>
            </span>
          ) : (
            formatPercent(r.successRate, locale)
          ),
        ),
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
      magnitude: (r) => (r.ignored ? null : r.billableMinEst / minutesMax),
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
        r.openPrCount == null || r.ignored ? (
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
        r.openAlertCount == null || r.ignored ? (
          dash
        ) : (
          <Link
            href={`${repoHref(login, r.fullName)}?tab=dependabot`}
            title={
              r.openAlertHighCount
                ? t("repos.alertsHigh", { count: r.openAlertHighCount })
                : undefined
            }
            className="inline-flex items-center justify-end gap-1 underline-offset-2 hover:underline"
          >
            {r.openAlertHighCount ? (
              <TriangleAlert
                aria-hidden="true"
                className="size-3.5 text-status-warning"
              />
            ) : null}
            {formatNumber(r.openAlertCount, locale)}
            {r.openAlertHighCount ? (
              <span className="sr-only">
                {t("repos.alertsHigh", { count: r.openAlertHighCount })}
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
            label={t("charts.sparkTitle", { runs, failures })}
            points={r.sparkline}
          />
        );
      },
    },
    ...(isAdmin
      ? [
          {
            id: "actions",
            label: t("repos.actions"),
            header: <span className="sr-only">{t("repos.actions")}</span>,
            cell: (r: RepoStat) => (
              <RepoRowMenu
                installationId={installationId}
                repo={{
                  id: r.repositoryId,
                  fullName: r.fullName,
                  fork: r.fork,
                }}
                ignored={r.ignored}
                canIgnore={canIgnore}
              />
            ),
            hideBelow: "sm",
            className: "w-px",
          } satisfies Column<RepoStat>,
        ]
      : []),
  ];

  const filtersActive = !!query.q || query.filters.length > 0;
  const table = (
    <DataTable
      caption={t("repos.title")}
      columns={columns}
      rows={page.rows}
      rowKey={(r) => r.repositoryId}
      rowName={(r) => r.name}
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

  const sortOptions = REPO_SORTS.flatMap((s) =>
    (["desc", "asc"] as const).map((dir) => ({
      value: s,
      dir,
      label: t(`repos.sortBy.${s}`, { dir }),
    })),
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("repos.title")}
        subtitle={t("repos.subtitle", {
          count: page.counts.active,
          ignored: page.counts.ignored,
        })}
        actions={
          canRefresh ? (
            <Link
              href={withParams(base, { refresh: 1 })}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
              {t("repos.refresh")}
            </Link>
          ) : null
        }
      />
      {refreshed === "live" || refreshed === "stored" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {refreshed === "live"
            ? t("repos.refreshedLive")
            : t("repos.refreshedStored")}
        </p>
      ) : null}
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
        <span className="lg:hidden">
          <SortSelect
            label={t("table.sort")}
            options={sortOptions}
            value={`${query.sort}:${query.dir}`}
          />
        </span>
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
      <TrendTable
        caption={t("repos.trend")}
        rows={page.rows
          .filter((r) => !r.ignored)
          .map((r) => ({
            key: r.repositoryId,
            label: r.name,
            points: r.sparkline,
          }))}
      />
    </div>
  );
}
