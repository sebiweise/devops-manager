import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { AzureBuildBadge } from "@/components/azure/azure-badges";
import {
  BuildActions,
  type AzureActionContext,
} from "@/components/azure/azure-actions";
import {
  AzureBlockedNote,
  ExternalAzureLink,
  azureHrefs,
} from "@/components/azure/azure-views";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  ParamSelect,
  SearchBox,
} from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import { AutoRefresh } from "@/components/insights/auto-refresh";
import { repoHref } from "@/components/insights/workflow-link";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { env } from "@/env";
import { loadAccount, orNotFound } from "@/lib/account-page";
import { formatDuration, formatNumber } from "@/lib/format";
import { param, type SearchParams } from "@/lib/insights-view";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import { AZURE_RUN_FILTERS, AZURE_RUN_TABLE } from "@/lib/table-specs";
import { parseTableQuery } from "@/lib/url-state";
import {
  getAzureActionState,
  getAzureSummary,
  listAzureRuns,
  type AzureRunRow,
} from "@/server/data/azure";
import { scheduleOpenAzureRefresh } from "@/server/ingest/triggers";

export const generateMetadata = accountMeta("pipelineRuns");

/**
 * Azure Pipelines runs (design addendum M7 §6 "Runs"): build number,
 * definition, repository, branch, short SHA, reason, status, queued, queue
 * wait, duration and minutes, with server-side paging and filters. While a
 * build on the page is open the page polls every 15 s (and refreshes up to
 * 3 open builds from Azure DevOps). Operators get cancel and retry while
 * every gate is open.
 */
export default async function AzureRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const summary = await orNotFound(getAzureSummary(scope, installation.id));
  if (!summary) notFound();
  const range = await pageRange(sp);
  const query = parseTableQuery(sp, AZURE_RUN_TABLE);
  const def = /^([0-9a-f-]{36}):(\d{1,9})$/i.exec(
    param(sp, "definition") ?? "",
  );
  const now = new Date();
  const [t, locale, format, state, page] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(
      getAzureActionState(
        scope,
        installation.id,
        env.MANAGEMENT_ENABLED,
        env.AZURE_MANAGEMENT_ENABLED,
        now,
      ),
    ),
    orNotFound(
      listAzureRuns(
        scope,
        installation.id,
        {
          page: query.page,
          size: query.size,
          range,
          q: query.q,
          filters: query.filters,
          ...(def
            ? { projectId: def[1]!.toLowerCase(), definitionId: Number(def[2]) }
            : {}),
        },
        now,
      ),
    ),
  ]);
  const login = installation.accountLogin;
  const h = azureHrefs(login);
  const open = page.rows.filter((r) => r.status !== "COMPLETED");
  if (open.length > 0)
    scheduleOpenAzureRefresh(
      installation.id,
      open.map((r) => ({ projectId: r.projectId, buildId: r.id })),
      (task) => after(task),
    );
  const ctx: AzureActionContext | null = state?.canAct
    ? {
        installationId: String(installation.id),
        minutesLeft: state.minutesLeft,
        maxJobMinutes: state.maxJobMinutes,
        running: state.running,
        limit: state.hostedParallelJobs,
        blockWhenQuotaExhausted: state.blockWhenQuotaExhausted,
      }
    : null;
  const tr = (k: string, v?: Record<string, string | number>) =>
    t(`ci.azure.runs.${k}`, v);
  const columns: Column<AzureRunRow>[] = [
    {
      id: "run",
      label: tr("col.run"),
      header: tr("col.run"),
      className: "whitespace-normal",
      cell: (r) => (
        <span className="flex flex-col">
          <Link
            href={h.run(r.id)}
            className="font-medium underline-offset-2 hover:underline"
          >
            #{r.buildNumber}
          </Link>
          <span className="text-xs text-muted-foreground">
            {r.definitionName}
          </span>
        </span>
      ),
    },
    {
      id: "status",
      label: tr("col.status"),
      header: tr("col.status"),
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          <AzureBuildBadge
            status={r.status}
            result={r.result}
            timedOut={r.timedOut}
          />
          {r.maxAttempt > 1 ? (
            <span className="text-xs text-muted-foreground">
              {t("runs.attempt", { n: r.maxAttempt })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "repo",
      label: tr("col.repo"),
      header: tr("col.repo"),
      hideBelow: "sm",
      cell: (r) =>
        r.repoFullName ? (
          <Link
            href={repoHref(login, r.repoFullName)}
            className="underline-offset-2 hover:underline"
          >
            {r.repoFullName.split("/").pop()}
          </Link>
        ) : (
          "—"
        ),
    },
    {
      id: "trigger",
      label: tr("col.trigger"),
      header: tr("col.trigger"),
      hideBelow: "md",
      className: "max-w-64",
      cell: (r) => (
        <span className="flex min-w-0 flex-wrap gap-x-1.5 text-sm">
          <span className="max-w-40 truncate font-medium">
            {r.headBranch ?? "—"}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {r.headSha?.slice(0, 7) ?? ""}
          </span>
          <span className="text-xs text-muted-foreground">
            {t(`ci.azure.reason.${r.reason}`)}
          </span>
        </span>
      ),
    },
    {
      id: "queue",
      label: tr("col.queue"),
      header: tr("col.queue"),
      align: "right",
      hideBelow: "lg",
      cell: (r) => formatDuration(r.queueS),
    },
    {
      id: "duration",
      label: tr("col.duration"),
      header: tr("col.duration"),
      align: "right",
      cell: (r) => formatDuration(r.durationS),
    },
    {
      id: "minutes",
      label: tr("col.minutes"),
      header: tr("col.minutes"),
      align: "right",
      hideBelow: "lg",
      cell: (r) =>
        r.minutes == null || r.status !== "COMPLETED"
          ? "—"
          : formatNumber(r.minutes, locale),
    },
    {
      id: "queued",
      label: tr("col.queued"),
      header: tr("col.queued"),
      align: "right",
      hideBelow: "md",
      cell: (r) => (
        <time
          dateTime={r.queuedAt}
          title={format.dateTime(new Date(r.queuedAt), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          className="text-xs whitespace-nowrap text-muted-foreground"
        >
          {format.relativeTime(new Date(r.queuedAt), now)}
        </time>
      ),
    },
    {
      id: "actions",
      label: tr("col.actions"),
      header: tr("col.actions"),
      expanderOnly: true,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-3">
          {ctx ? (
            <BuildActions
              compact
              ctx={ctx}
              build={{
                id: r.id,
                buildNumber: r.buildNumber,
                definitionName: r.definitionName,
                status: r.status,
                result: r.result,
              }}
            />
          ) : null}
          <ExternalAzureLink
            href={r.azureUrl}
            label={t("ci.azure.openInAzure")}
          />
          {r.auditEntryId ? (
            <Link
              href={`/o/${encodeURIComponent(login)}/audit?entry=${encodeURIComponent(r.auditEntryId)}`}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {r.auditLinkKind === "probable"
                ? t("ci.azure.auditLink.probable")
                : t("ci.azure.auditLink.exact")}
            </Link>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      {open.length > 0 ? <AutoRefresh intervalMs={15_000} /> : null}
      <Breadcrumbs
        items={[
          { kind: "accounts" },
          { kind: "account", login },
          { kind: "section", login, section: "pipelines" },
          { kind: "pipelineSection", login, section: "runs" },
        ]}
        range={param(sp, "range")}
      />
      <PageHeader
        title={tr("title")}
        subtitle={tr("subtitle", {
          org: summary.orgName,
          range: t(`filters.ranges.${range}`),
          open: page.open,
        })}
      />
      <AzureBlockedNote blockedBy={state?.blockedBy ?? null} />
      <FilterBar>
        <SearchBox label={tr("search")} />
        <FilterChips
          label={tr("chips")}
          options={AZURE_RUN_FILTERS.map((f) => ({
            value: f,
            label: tr(`filter.${f}`),
          }))}
        />
        {page.definitions.length > 0 ? (
          <ParamSelect
            label={tr("col.definition")}
            param="definition"
            allLabel={tr("allDefinitions")}
            options={page.definitions.map((d) => ({
              value: `${d.projectId}:${d.id}`,
              label: d.name,
            }))}
          />
        ) : null}
        <ClearFilters keys={["q", "f", "definition"]} />
      </FilterBar>
      <DataTable
        caption={tr("title")}
        columns={columns}
        rows={page.rows}
        rowKey={(r) => String(r.id)}
        rowName={(r) => `#${r.buildNumber} ${r.definitionName}`}
        empty={<EmptyState quiet message={tr("empty")} />}
      />
      {page.total > 0 ? (
        <Pagination
          base={h.runs}
          params={sp}
          page={page.page}
          size={page.size}
          total={page.total}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">{tr("note")}</p>
    </div>
  );
}
