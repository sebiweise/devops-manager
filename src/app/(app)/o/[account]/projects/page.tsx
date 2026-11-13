import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  SearchBox,
} from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import { StatusBadge } from "@/components/data/status-badge";
import {
  DeployStateBadge,
  ExternalVercelLink,
  TargetBadge,
} from "@/components/hosting/hosting";
import { repoHref } from "@/components/insights/workflow-link";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { loadAccount, orNotFound } from "@/lib/account-page";
import { shortSha } from "@/lib/hosting-view";
import { param, type SearchParams } from "@/lib/insights-view";
import { accountMeta } from "@/lib/page-meta";
import { PROJECT_FILTERS, PROJECT_TABLE } from "@/lib/table-specs";
import { parseTableQuery } from "@/lib/url-state";
import {
  getVercelSummary,
  listVercelProjects,
  type ProjectRow,
} from "@/server/data/vercel";

export const generateMetadata = accountMeta("projects");

/**
 * Vercel projects of the account (design addendum §9): name, framework,
 * linked repository (or the "manual" badge), production branch, the latest
 * production state and age, and "auto-assign paused". The row expander
 * shows the last 10 deployments. 404 without a connection.
 */
export default async function ProjectsPage({
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
  const query = parseTableQuery(sp, PROJECT_TABLE);
  const [t, format, page] = await Promise.all([
    getTranslations(),
    getFormatter(),
    orNotFound(listVercelProjects(scope, installation.id, query)),
  ]);
  const now = new Date();
  const login = installation.accountLogin;
  const base = `/o/${encodeURIComponent(login)}/projects`;
  const ago = (iso: string | null) =>
    iso ? (
      <time
        dateTime={iso}
        title={format.dateTime(new Date(iso), {
          dateStyle: "medium",
          timeStyle: "short",
        })}
        className="text-xs whitespace-nowrap text-muted-foreground"
      >
        {format.relativeTime(new Date(iso), now)}
      </time>
    ) : (
      "—"
    );

  const columns: Column<ProjectRow>[] = [
    {
      id: "name",
      label: t("hosting.col.project"),
      header: t("hosting.col.project"),
      sortKey: "name",
      cell: (p) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{p.name}</span>
            {p.autoAssignPausedAt ? (
              <StatusBadge kind="autoAssignPaused" />
            ) : null}
          </span>
          {p.framework ? (
            <span className="text-xs text-muted-foreground">{p.framework}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "repo",
      label: t("hosting.col.repo"),
      header: t("hosting.col.repo"),
      hideBelow: "sm",
      cell: (p) =>
        p.repoFullName ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Link
              href={repoHref(login, p.repoFullName)}
              className="underline-offset-2 hover:underline"
            >
              {p.repoFullName.split("/").pop()}
            </Link>
            {p.manualLink ? <StatusBadge kind="manualLink" /> : null}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {p.linkRepo
              ? t("hosting.projects.notInInstallation")
              : t("hosting.projects.notLinked")}
          </span>
        ),
    },
    {
      id: "branch",
      label: t("hosting.col.productionBranch"),
      header: t("hosting.col.productionBranch"),
      hideBelow: "lg",
      cell: (p) => <span className="text-xs">{p.productionBranch ?? "—"}</span>,
    },
    {
      id: "latest",
      label: t("hosting.col.production"),
      header: t("hosting.col.production"),
      sortKey: "latest",
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-2">
          {p.latestProdState ? (
            <DeployStateBadge state={p.latestProdState} />
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("hosting.repoCard.none")}
            </span>
          )}
          {p.latestProdSha ? (
            <span className="font-mono text-xs">
              {shortSha(p.latestProdSha)}
            </span>
          ) : null}
          {ago(p.latestProdAt)}
        </span>
      ),
    },
    {
      id: "links",
      label: t("hosting.col.links"),
      header: t("hosting.col.links"),
      expanderOnly: true,
      cell: (p) => (
        <ExternalVercelLink
          href={p.vercelUrl}
          label={t("hosting.openInVercel")}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs
        items={[
          { kind: "accounts" },
          { kind: "account", login },
          { kind: "section", login, section: "projects" },
        ]}
        range={param(sp, "range")}
      />
      <PageHeader
        title={t("hosting.projects.title")}
        subtitle={t("hosting.projects.subtitle", {
          team: summary.teamSlug,
          count: page.total,
        })}
      />
      <FilterBar>
        <SearchBox label={t("hosting.projects.search")} />
        <FilterChips
          label={t("hosting.projects.chips")}
          options={PROJECT_FILTERS.map((f) => ({
            value: f,
            label: t(`hosting.projects.filter.${f}`),
          }))}
        />
        <ClearFilters />
      </FilterBar>
      <DataTable
        caption={t("hosting.projects.title")}
        columns={columns}
        rows={page.rows}
        rowKey={(p) => p.id}
        rowName={(p) => p.name}
        sort={{ key: query.sort, dir: query.dir, base, params: sp }}
        extra={(p) =>
          p.recent.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("hosting.projects.noDeployments")}
            </span>
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("hosting.projects.recent", { count: p.recent.length })}
              </span>
              <ul className="flex flex-col">
                {p.recent.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center gap-2 border-t py-1 text-xs first:border-t-0"
                  >
                    <DeployStateBadge state={d.state} />
                    <TargetBadge target={d.target} />
                    <span className="font-mono">
                      {shortSha(d.commitSha) ?? "—"}
                    </span>
                    <span className="max-w-40 truncate text-muted-foreground">
                      {d.branch ?? "—"}
                    </span>
                    {ago(d.createdAt)}
                    <ExternalVercelLink
                      href={d.vercelUrl}
                      label={t("hosting.openInVercel")}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )
        }
        empty={<EmptyState quiet message={t("hosting.projects.empty")} />}
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
    </div>
  );
}
