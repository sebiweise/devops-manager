import { CircleX, Rocket } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import {
  buildTime,
  DeploymentsPerDayChart,
  DeployStateBadge,
  ExternalVercelLink,
  TargetBadge,
} from "@/components/hosting/hosting";
import { repoHref } from "@/components/insights/workflow-link";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { loadAccount, orNotFound } from "@/lib/account-page";
import { formatNumber, formatPercent } from "@/lib/format";
import { dailyAllotment, quotaRatio, shortSha } from "@/lib/hosting-view";
import { param, type SearchParams } from "@/lib/insights-view";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import { RANGE_BUCKET } from "@/lib/range";
import { DEPLOYMENT_FILTERS, DEPLOYMENT_TABLE } from "@/lib/table-specs";
import { parseTableQuery, withParams } from "@/lib/url-state";
import {
  getDeploymentInsights,
  getVercelSummary,
  listDeployments,
  type DeploymentRow,
} from "@/server/data/vercel";

export const generateMetadata = accountMeta("deployments");

/**
 * Vercel deployments of the account (design addendum §9): KPIs over the
 * shared range (deployments by target, production success rate, failures,
 * build time p50/p90, failing production projects, deploys in the last 24 h
 * against the plan's daily allotment), deployments per day by state, and
 * the paged table with filters (target and state chips, project, repo,
 * search over branch, SHA and message). 404 without a connection.
 */
export default async function DeploymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const summary = await orNotFound(getVercelSummary(scope, installation.id));
  if (!summary) notFound();
  const range = await pageRange(sp);
  const query = parseTableQuery(sp, DEPLOYMENT_TABLE);
  const projectId = param(sp, "project");
  const repo = param(sp, "repo");
  const now = new Date();
  const [t, locale, format, insights, page] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(getDeploymentInsights(scope, installation.id, range, now)),
    orNotFound(
      listDeployments(
        scope,
        installation.id,
        {
          ...query,
          range,
          projectId:
            projectId && /^[A-Za-z0-9_-]{1,64}$/.test(projectId)
              ? projectId
              : undefined,
          repositoryId:
            repo && /^\d{1,20}$/.test(repo) ? BigInt(repo) : undefined,
        },
        now,
      ),
    ),
  ]);
  const login = installation.accountLogin;
  const base = `/o/${encodeURIComponent(login)}/deployments`;
  const rangeLabel = t(`filters.ranges.${range}`);
  const cap = dailyAllotment(summary.plan);
  const ratio = insights ? quotaRatio(insights.last24h, summary.plan) : null;

  const columns: Column<DeploymentRow>[] = [
    {
      id: "state",
      label: t("hosting.col.state"),
      header: t("hosting.col.state"),
      cell: (d) => <DeployStateBadge state={d.state} />,
    },
    {
      id: "project",
      label: t("hosting.col.project"),
      header: t("hosting.col.project"),
      sortKey: "project",
      cell: (d) => (
        <span className="flex flex-col">
          <span className="font-medium">{d.projectName}</span>
          {d.repoFullName ? (
            <Link
              href={repoHref(login, d.repoFullName)}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {d.repoFullName.split("/").pop()}
            </Link>
          ) : null}
        </span>
      ),
    },
    {
      id: "target",
      label: t("hosting.col.target"),
      header: t("hosting.col.target"),
      hideBelow: "sm",
      cell: (d) => (
        <span className="flex flex-wrap items-center gap-1">
          <TargetBadge target={d.target} />
          {d.live ? (
            <span className="text-xs text-muted-foreground">
              {t("hosting.live")}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "commit",
      label: t("hosting.col.commit"),
      header: t("hosting.col.commit"),
      hideBelow: "md",
      className: "max-w-80",
      cell: (d) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="font-mono text-xs">
              {shortSha(d.commitSha) ?? "—"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {d.branch ?? "—"}
            </span>
          </span>
          {d.commitMessage ? (
            <span
              className="truncate text-xs text-muted-foreground"
              title={d.commitMessage}
            >
              {d.commitMessage}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "build",
      label: t("hosting.col.build"),
      header: t("hosting.col.build"),
      sortKey: "build",
      align: "right",
      hideBelow: "lg",
      cell: (d) => buildTime(d.buildMs),
    },
    {
      id: "created",
      label: t("hosting.col.created"),
      header: t("hosting.col.created"),
      sortKey: "created",
      align: "right",
      cell: (d) => (
        <time
          dateTime={d.createdAt}
          title={format.dateTime(new Date(d.createdAt), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          className="text-xs whitespace-nowrap"
        >
          {format.relativeTime(new Date(d.createdAt), now)}
        </time>
      ),
    },
    {
      id: "source",
      label: t("hosting.col.source"),
      header: t("hosting.col.source"),
      expanderOnly: true,
      cell: (d) =>
        d.creatorKind ? t(`hosting.creator.${d.creatorKind}`) : "—",
    },
    {
      id: "error",
      label: t("hosting.col.error"),
      header: t("hosting.col.error"),
      expanderOnly: true,
      cell: (d) =>
        d.errorCode ? (
          <span className="font-mono text-xs">{d.errorCode}</span>
        ) : (
          "—"
        ),
    },
    {
      id: "links",
      label: t("hosting.col.links"),
      header: t("hosting.col.links"),
      expanderOnly: true,
      cell: (d) => (
        <span className="flex flex-wrap gap-3">
          <ExternalVercelLink
            href={d.vercelUrl}
            label={t("hosting.openInVercel")}
          />
          {d.url && d.state === "READY" ? (
            <ExternalVercelLink href={`https://${d.url}`} label={d.url} />
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs
        items={[
          { kind: "accounts" },
          { kind: "account", login },
          { kind: "section", login, section: "deployments" },
        ]}
        range={param(sp, "range")}
      />
      <PageHeader
        title={t("hosting.deployments.title")}
        subtitle={t("hosting.deployments.subtitle", {
          team: summary.teamSlug,
          range: rangeLabel,
        })}
      />
      {insights ? (
        <KpiStrip label={t("hosting.kpi.label")}>
          <KpiTile
            label={t("hosting.kpi.deployments")}
            info={t("hosting.kpi.deploymentsInfo")}
            value={formatNumber(insights.production + insights.preview, locale)}
            hint={t("hosting.kpi.byTarget", {
              production: insights.production,
              preview: insights.preview,
            })}
          />
          <KpiTile
            label={t("hosting.kpi.prodSuccess")}
            info={t("hosting.kpi.prodSuccessInfo")}
            value={formatPercent(insights.prodSuccessRate, locale)}
            hint={rangeLabel}
            href={withParams(base, { f: "production" })}
          />
          {insights.failures > 0 ? (
            <KpiTile
              variant="status"
              icon={CircleX}
              tone="critical"
              label={t("hosting.kpi.failures")}
              value={formatNumber(insights.failures, locale)}
              href={withParams(base, { f: "error" })}
            />
          ) : (
            <KpiTile
              label={t("hosting.kpi.failures")}
              value={formatNumber(0, locale)}
            />
          )}
          <KpiTile
            label={t("hosting.kpi.build")}
            info={t("hosting.kpi.buildInfo")}
            value={buildTime(insights.buildP50Ms)}
            hint={t("hosting.kpi.buildP90", {
              p90: buildTime(insights.buildP90Ms),
            })}
          />
          {insights.failingProjects > 0 ? (
            <KpiTile
              variant="status"
              icon={Rocket}
              tone="critical"
              label={t("hosting.kpi.failingProd")}
              info={t("hosting.kpi.failingProdInfo")}
              value={formatNumber(insights.failingProjects, locale)}
              href={`/o/${encodeURIComponent(login)}/projects?f=failing`}
            />
          ) : (
            <KpiTile
              label={t("hosting.kpi.failingProd")}
              info={t("hosting.kpi.failingProdInfo")}
              value={formatNumber(0, locale)}
            />
          )}
          {cap ? (
            <KpiTile
              variant="meter"
              label={t("hosting.kpi.quota")}
              info={t("hosting.kpi.quotaInfo", { cap })}
              value={`${formatNumber(insights.last24h, locale)} / ${formatNumber(cap, locale)}`}
              ratio={ratio}
              overLabel={t("hosting.kpi.quotaOver")}
              hint={t(
                `hosting.plan.${summary.plan === "pro" ? "pro" : "hobby"}`,
              )}
            />
          ) : (
            <KpiTile
              label={t("hosting.kpi.last24h")}
              value={formatNumber(insights.last24h, locale)}
            />
          )}
        </KpiStrip>
      ) : null}

      {insights && RANGE_BUCKET[range] !== "hour" ? (
        <DeploymentsPerDayChart
          id="deployments-per-day"
          days={insights.perDay}
          bucket={RANGE_BUCKET[range]}
        />
      ) : null}

      <FilterBar>
        <SearchBox label={t("hosting.deployments.search")} />
        <FilterChips
          label={t("hosting.deployments.chips")}
          options={DEPLOYMENT_FILTERS.map((f) => ({
            value: f,
            label: t(`hosting.filter.${f}`),
          }))}
        />
        <ParamSelect
          label={t("hosting.col.project")}
          param="project"
          allLabel={t("hosting.allProjects")}
          options={page.projects.map((p) => ({ value: p.id, label: p.name }))}
        />
        {page.repos.length > 0 ? (
          <ParamSelect
            label={t("hosting.col.repo")}
            param="repo"
            allLabel={t("hosting.allRepos")}
            options={page.repos.map((r) => ({
              value: r.id,
              label: r.fullName.split("/").pop() ?? r.fullName,
            }))}
          />
        ) : null}
        <ClearFilters keys={["q", "f", "project", "repo"]} />
      </FilterBar>
      <DataTable
        caption={t("hosting.deployments.title")}
        columns={columns}
        rows={page.rows}
        rowKey={(d) => d.id}
        rowName={(d) => `${d.projectName} ${shortSha(d.commitSha) ?? d.id}`}
        sort={{ key: query.sort, dir: query.dir, base, params: sp }}
        empty={
          <EmptyState
            quiet
            message={t("hosting.deployments.empty", { range: rangeLabel })}
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
      <p className="text-xs text-muted-foreground">{t("hosting.freshness")}</p>
    </div>
  );
}
