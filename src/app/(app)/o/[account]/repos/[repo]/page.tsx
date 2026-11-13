import { EyeOff, ExternalLink, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { TrendTable } from "@/components/charts/sparkline";
import { DataTable } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import { StatusBadge } from "@/components/data/status-badge";
import { RunsSection } from "@/components/insights/runs-section";
import { workflowColumns } from "@/components/insights/workflow-columns";
import { repoHref } from "@/components/insights/workflow-link";
import { ManagementBanner } from "@/components/management/management-banner";
import { RepoIgnoreButton } from "@/components/management/repo-ignore";
import {
  DependabotSection,
  PullsSection,
  VariablesSection,
} from "@/components/management/sections";
import { Breadcrumbs, type Crumb } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { enoughData, param, type SearchParams } from "@/lib/insights-view";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import { pageWorkflows } from "@/lib/table-pages";
import { WORKFLOW_TABLE } from "@/lib/table-specs";
import { parseTableQuery, withParams } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { hasRole } from "@/server/authz/roles";
import {
  findRepositoryByName,
  getRepositorySummary,
  listWorkflowStats,
} from "@/server/data/insights";
import { getManagementState } from "@/server/data/management";
import { listIgnoredRepositories } from "@/server/data/repos";
import { getRepoDeployments } from "@/server/data/vercel";
import { RepoDeployments } from "@/components/hosting/hosting";

export const generateMetadata = accountMeta("repo");

const TABS = ["workflows", "runs", "pulls", "dependabot", "variables"] as const;
type Tab = (typeof TABS)[number];

/**
 * One repository (UI overhaul §2.4): breadcrumbs, the name with its badges
 * and Open on GitHub, KPIs over the shared range (runs, success, 95 %
 * duration, minutes, open PRs, open alerts) and tabs with counts:
 * Workflows · Runs · Pull requests · Dependabot · Variables. An ignored
 * repository shows only what it is and its state, with Un-ignore (admin).
 */
export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; repo: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account, repo: repoParam } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const repo = await findRepositoryByName(
    scope,
    installation.id,
    decodeURIComponent(repoParam),
  );
  if (!repo) notFound();

  const [t, locale, format, state] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(getManagementState(scope, installation.id)),
  ]);
  const login = installation.accountLogin;
  const name = repo.fullName.split("/").pop() ?? repo.fullName;
  const crumbs: Crumb[] = [
    { kind: "accounts" },
    { kind: "account", login },
    { kind: "section", login, section: "repos" },
    { kind: "repo", login, name, fullName: repo.fullName },
  ];
  const badges = (
    <span className="flex flex-wrap items-center gap-1.5">
      {repo.ignored ? <StatusBadge kind="ignored" /> : null}
      {repo.fork ? <StatusBadge kind="fork" /> : null}
      {repo.private ? <StatusBadge kind="private" /> : null}
      {repo.archived ? <StatusBadge kind="archived" /> : null}
    </span>
  );
  const github = (
    <a
      href={`https://github.com/${repo.fullName}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"
    >
      <ExternalLink aria-hidden="true" className="size-3.5" />
      {t("repo.openOnGithub")}
    </a>
  );
  const range = param(sp, "range");

  if (repo.ignored) {
    // No data tabs for an ignored repository: only what it is and its state.
    const ignored = (
      await orNotFound(listIgnoredRepositories(scope, installation.id))
    ).find((r) => r.repositoryId === repo.id);
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={crumbs} range={range} />
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {name}
              {badges}
            </span>
          }
          subtitle={repo.fullName}
          actions={github}
        />
        <section
          role="status"
          className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-muted/40 p-4"
        >
          <div className="flex items-start gap-3">
            <EyeOff
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            />
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-medium">{t("ignore.banner.title")}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
                {repo.ignoredAt ? (
                  <>
                    <dt>{t("ignore.banner.at")}</dt>
                    <dd>
                      {format.dateTime(new Date(repo.ignoredAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}{" "}
                      ({format.relativeTime(new Date(repo.ignoredAt))})
                    </dd>
                  </>
                ) : null}
                {ignored?.ignoredBy ? (
                  <>
                    <dt>{t("ignore.settings.ignoredBy")}</dt>
                    <dd>{ignored.ignoredBy}</dd>
                  </>
                ) : null}
                <dt>{t("ignore.settings.state")}</dt>
                <dd className="flex items-center gap-1.5">
                  {repo.purged ? (
                    t("ignore.settings.purged")
                  ) : (
                    <>
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-3.5 animate-spin"
                      />
                      {t("ignore.banner.purging")}
                    </>
                  )}
                </dd>
              </dl>
            </div>
          </div>
          {hasRole(scope.role, "ADMIN") && state.globalEnabled ? (
            <RepoIgnoreButton
              installationId={String(installation.id)}
              mode="unignore"
              repos={[
                { id: repo.id, fullName: repo.fullName, fork: repo.fork },
              ]}
            />
          ) : null}
        </section>
      </div>
    );
  }

  const base = repoHref(login, repo.fullName);
  const requested = param(sp, "tab");
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as Tab)
    : "workflows";
  const insightRange = await pageRange(sp);
  const repositoryId = BigInt(repo.id);
  const [summary, workflows, deployments] = await Promise.all([
    orNotFound(
      getRepositorySummary(scope, installation.id, repositoryId, insightRange),
    ),
    orNotFound(
      listWorkflowStats(scope, installation.id, {
        repositoryId,
        range: insightRange,
      }),
    ),
    orNotFound(getRepoDeployments(scope, installation.id, repositoryId)),
  ]);
  const s = summary.summary;
  const rangeLabel = t(`filters.ranges.${insightRange}`);
  const section = {
    scope,
    installationId: installation.id,
    accountLogin: login,
    state,
    repositoryId: repo.id,
  };
  // Run actions need operator, merges and variable edits admin.
  const bannerRole =
    tab === "runs"
      ? "OPERATOR"
      : tab === "pulls" || tab === "variables"
        ? "ADMIN"
        : null;
  const tabCount: Partial<Record<Tab, string>> = {
    workflows: formatNumber(workflows.length, locale),
    ...(summary.openPrCount != null
      ? { pulls: formatNumber(summary.openPrCount, locale) }
      : {}),
    ...(summary.openAlertCount != null
      ? {
          dependabot: summary.openAlertHighCount
            ? t("repo.alertsTab", {
                count: summary.openAlertCount,
                high: summary.openAlertHighCount,
              })
            : formatNumber(summary.openAlertCount, locale),
        }
      : {}),
  };

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs items={crumbs} range={range} />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {name}
            {badges}
          </span>
        }
        subtitle={`${repo.fullName} · ${t("repo.defaultBranch", { branch: repo.defaultBranch })}`}
        actions={github}
      />

      <KpiStrip label={t("overview.kpiLabel")}>
        <KpiTile
          label={t("overview.kpi.runs")}
          info={t("overview.kpi.runsInfo")}
          value={formatNumber(s.runs, locale)}
          hint={rangeLabel}
          href={withParams(base, { tab: "runs", range })}
        />
        <KpiTile
          label={t("overview.kpi.success")}
          info={t("overview.kpi.successInfo")}
          value={formatPercent(s.successRate, locale)}
          hint={t("workflow.firstTry", {
            rate: formatPercent(s.firstTrySuccessRate, locale),
          })}
        />
        <KpiTile
          label={t("overview.kpi.p95")}
          info={t("overview.kpi.p95Info")}
          value={
            enoughData(s.n)
              ? approx(formatDuration(s.p95), s.approx)
              : t("common.notEnoughData")
          }
          hint={
            enoughData(s.n)
              ? t("overview.kpi.p50Hint", {
                  p50: approx(formatDuration(s.p50), s.approx),
                })
              : t("kpi.samples", { n: s.n })
          }
        />
        <KpiTile
          label={t("overview.kpi.minutes")}
          info={t("overview.kpi.minutesInfo")}
          value={formatMinutes(summary.billableMinEst, locale)}
        />
        <KpiTile
          label={t("repos.openPrs")}
          value={
            summary.openPrCount == null
              ? "—"
              : formatNumber(summary.openPrCount, locale)
          }
          href={withParams(base, { tab: "pulls", range })}
        />
        <KpiTile
          label={t("repo.openAlerts")}
          value={
            summary.openAlertCount == null
              ? "—"
              : formatNumber(summary.openAlertCount, locale)
          }
          hint={
            summary.openAlertHighCount
              ? t("repos.alertsHigh", { count: summary.openAlertHighCount })
              : undefined
          }
          href={withParams(base, { tab: "dependabot", range })}
        />
      </KpiStrip>

      <RepoDeployments cards={deployments} />

      <nav aria-label={t("repo.tabs")} className="overflow-x-auto border-b">
        <ul className="flex w-max gap-1">
          {TABS.map((key) => (
            <li key={key}>
              <Link
                href={withParams(base, {
                  tab: key === "workflows" ? undefined : key,
                  range,
                })}
                aria-current={tab === key ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap",
                  tab === key
                    ? "border-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`repo.tab.${key}`)}
                {tabCount[key] ? (
                  <span className="rounded-full bg-secondary px-1.5 text-xs font-normal text-secondary-foreground tabular-nums">
                    {tabCount[key]}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {bannerRole && hasRole(scope.role, bannerRole) ? (
        <ManagementBanner
          state={state}
          settingsHref={
            hasRole(scope.role, "ADMIN")
              ? accountPath(login, "/settings")
              : undefined
          }
        />
      ) : null}

      {tab === "pulls" ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">{t("repo.tab.pulls")}</h2>
          <PullsSection {...section} />
        </section>
      ) : tab === "variables" ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">{t("repo.tab.variables")}</h2>
          <VariablesSection {...section} />
        </section>
      ) : tab === "dependabot" ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">{t("repo.tab.dependabot")}</h2>
          <DependabotSection {...section} />
        </section>
      ) : tab === "workflows" ? (
        <WorkflowsTab
          rows={workflows}
          login={login}
          base={base}
          sp={sp}
          rangeLabel={t(`filters.short.${insightRange}`)}
        />
      ) : (
        <RunsSection
          scope={scope}
          installationId={installation.id}
          repositoryId={repositoryId}
          login={login}
          base={base}
          sp={sp}
          hidden={{ tab: "runs" }}
          canOperate={state.canOperate}
          title={t("repo.tab.runs")}
        />
      )}
    </div>
  );
}

async function WorkflowsTab({
  rows,
  login,
  base,
  sp,
  rangeLabel,
}: {
  rows: Awaited<ReturnType<typeof listWorkflowStats>>;
  login: string;
  base: string;
  sp: SearchParams;
  rangeLabel: string;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const query = parseTableQuery(sp, WORKFLOW_TABLE);
  // Same sort keys as the account-wide table; one page holds them all.
  const sorted = pageWorkflows(rows, {
    ...query,
    page: 1,
    size: Math.max(1, rows.length),
  }).rows;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">{t("repo.tab.workflows")}</h2>
      <DataTable
        caption={t("repo.tab.workflows")}
        columns={workflowColumns({
          t,
          locale,
          login,
          rows,
          showRepo: false,
          rangeLabel,
        })}
        rows={sorted}
        rowKey={(w) => w.workflowId}
        sort={{ key: query.sort, dir: query.dir, base, params: sp }}
        empty={<EmptyState quiet message={t("workflows.empty")} />}
      />
      <TrendTable
        caption={t("repos.trend")}
        rows={sorted.map((w) => ({
          key: w.workflowId,
          label: w.workflowName,
          points: w.sparkline,
        }))}
      />
    </section>
  );
}
