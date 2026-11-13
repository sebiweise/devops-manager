import { getLocale, getTranslations } from "next-intl/server";
import { TrendTable } from "@/components/charts/sparkline";
import { DataTable } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  ParamSelect,
  QuickViews,
  SearchBox,
  SortSelect,
} from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import { workflowColumns } from "@/components/insights/workflow-columns";
import { PageHeader } from "@/components/shell/page-header";
import Link from "next/link";
import { hasAzurePipelines } from "@/server/data/ci-runs";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import {
  WORKFLOW_FILTERS,
  WORKFLOW_QUICK_VIEWS,
  WORKFLOW_SORTS,
  WORKFLOW_TABLE,
} from "@/lib/table-specs";
import { first, parseTableQuery, type SearchParamsLike } from "@/lib/url-state";
import { listWorkflowStatsPage } from "@/server/data/insights";

export const generateMetadata = accountMeta("workflows");

/**
 * Workflows (UI overhaul §2.5): one paged table of every workflow with
 * search, a repository filter, the Regressed / Flaky / Low success chips
 * and quick views (slowest, flakiest, most minutes, lowest success,
 * regressions) that only set sort and filter. The former leaderboard cards
 * are these quick views; the sorted column keeps a magnitude bar.
 */
export default async function WorkflowsPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account } = await params;
  const sp = (await searchParams) as SearchParamsLike;
  const { scope, installation } = await loadAccount(account);
  const azure = await orNotFound(hasAzurePipelines(scope, installation.id));
  const range = await pageRange(sp);
  const query = parseTableQuery(sp, WORKFLOW_TABLE);
  const repo = first(sp, "repo");
  const [t, locale, page] = await Promise.all([
    getTranslations(),
    getLocale(),
    orNotFound(
      listWorkflowStatsPage(scope, installation.id, {
        ...query,
        range,
        ...(repo && /^\d{1,20}$/.test(repo) ? { repositoryId: repo } : {}),
      }),
    ),
  ]);
  const login = installation.accountLogin;
  const base = accountPath(login, "/workflows");
  const rangeLabel = t(`filters.short.${range}`);
  const filtersActive = !!query.q || query.filters.length > 0 || !!repo;

  const columns = workflowColumns({
    t,
    locale,
    login,
    rows: page.rows,
    showRepo: true,
    rangeLabel,
  });
  const sortOptions = WORKFLOW_SORTS.flatMap((s) =>
    (["desc", "asc"] as const).map((dir) => ({
      value: s,
      dir,
      label: t(`workflows.sortBy.${s}`, { dir }),
    })),
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("leaderboards.title")}
        subtitle={t("workflows.subtitle", {
          workflows: page.workflows,
          repos: page.repositories,
          range: t(`filters.ranges.${range}`),
        })}
        info={t("leaderboards.note")}
        infoLabel={t("workflows.aboutValues")}
      />
      <QuickViews
        label={t("table.quickViews")}
        views={Object.entries(WORKFLOW_QUICK_VIEWS).map(([id, v]) => ({
          id,
          label: t(`leaderboards.${id}`),
          sort: v.sort,
          dir: v.dir,
          filters: v.filters,
        }))}
      />
      <FilterBar>
        <SearchBox label={t("workflows.search")} />
        <ParamSelect
          label={t("workflows.repoFilter")}
          param="repo"
          allLabel={t("workflows.allRepos")}
          options={page.repositoryOptions.map((r) => ({
            value: r.id,
            label: r.fullName.split("/").pop() ?? r.fullName,
          }))}
        />
        <FilterChips
          label={t("workflows.chips.label")}
          options={WORKFLOW_FILTERS.map((f) => ({
            value: f,
            label: t(`workflows.chips.${f}`),
          }))}
        />
        <span className="md:hidden">
          <SortSelect
            label={t("table.sort")}
            options={sortOptions}
            value={`${query.sort}:${query.dir}`}
          />
        </span>
        <ClearFilters keys={["q", "f", "repo"]} />
      </FilterBar>
      <DataTable
        caption={t("leaderboards.title")}
        columns={columns}
        rows={page.rows}
        rowKey={(w) => w.workflowId}
        sort={{ key: query.sort, dir: query.dir, base, params: sp }}
        empty={
          <EmptyState
            message={
              filtersActive ? t("workflows.noMatch") : t("workflows.empty")
            }
          />
        }
      />
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
        rows={page.rows.map((w) => ({
          key: w.workflowId,
          label: `${w.workflowName} · ${w.repoFullName.split("/").pop()}`,
          points: w.sparkline,
        }))}
      />
      {azure ? (
        <p className="text-sm">
          <Link
            href={`/o/${encodeURIComponent(installation.accountLogin)}/pipelines`}
            className="underline-offset-2 hover:underline"
          >
            {t("ci.azure.githubOnly")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
