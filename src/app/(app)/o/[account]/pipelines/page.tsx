import { CircleX } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DataTable } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  ParamSelect,
  SearchBox,
} from "@/components/data/filter-bar";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import type { AzureActionContext } from "@/components/azure/azure-actions";
import {
  AzureBlockedNote,
  azureHrefs,
  pipelineColumns,
} from "@/components/azure/azure-views";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { env } from "@/env";
import { loadAccount, orNotFound } from "@/lib/account-page";
import {
  approx,
  formatDuration,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { param, type SearchParams } from "@/lib/insights-view";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import { PIPELINE_FILTERS, PIPELINE_TABLE } from "@/lib/table-specs";
import { parseTableQuery } from "@/lib/url-state";
import {
  getAzureActionState,
  getAzureSummary,
  listPipelines,
} from "@/server/data/azure";

export const generateMetadata = accountMeta("pipelines");

/**
 * Azure Pipelines definitions of the account (design addendum M7 §6): KPIs
 * over the shared range (linked definitions, success rate with partial
 * apart, p50/p90 duration, hosted minutes, macOS share, failing default
 * branches), the definitions table with project, linked repository, YAML
 * path, last status, success, durations, minutes, macOS share and jobs near
 * the job time limit, and the facets project, linked/unlinked, failing and
 * macOS. Operators get "Queue run" while every gate is open. 404 without a
 * connection.
 */
export default async function PipelinesPage({
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
  const query = parseTableQuery(sp, PIPELINE_TABLE);
  const project = param(sp, "project");
  const now = new Date();
  const [t, locale, state, page] = await Promise.all([
    getTranslations(),
    getLocale(),
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
      listPipelines(
        scope,
        installation.id,
        {
          range,
          q: query.q,
          filters: query.filters,
          projectId:
            project && /^[0-9a-f-]{36}$/i.test(project)
              ? project.toLowerCase()
              : undefined,
        },
        now,
      ),
    ),
  ]);
  const login = installation.accountLogin;
  const h = azureHrefs(login);
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
  const columns = await pipelineColumns({ login, actions: ctx });
  const k = page.kpis;
  const rangeLabel = t(`filters.ranges.${range}`);
  const rows = [...page.rows].sort((a, b) =>
    query.dir === "desc"
      ? b.name.localeCompare(a.name)
      : a.name.localeCompare(b.name),
  );
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs
        items={[
          { kind: "accounts" },
          { kind: "account", login },
          { kind: "section", login, section: "pipelines" },
        ]}
        range={param(sp, "range")}
      />
      <PageHeader
        title={t("ci.azure.pipelines.title")}
        subtitle={t("ci.azure.pipelines.subtitle", {
          org: summary.orgName,
          range: rangeLabel,
        })}
        actions={
          <div className="flex flex-wrap gap-2 text-sm">
            <Link
              href={h.runs}
              className="inline-flex h-8 items-center rounded-md border px-3 hover:bg-accent"
            >
              {t("ci.azure.nav.runs")}
            </Link>
            <Link
              href={h.usage}
              className="inline-flex h-8 items-center rounded-md border px-3 hover:bg-accent"
            >
              {t("ci.azure.nav.usage")}
            </Link>
          </div>
        }
      />
      <KpiStrip label={t("ci.azure.pipelines.kpiLabel")}>
        <KpiTile
          label={t("ci.azure.pipelines.kpi.definitions")}
          value={formatNumber(k.linked, locale)}
          hint={t("ci.azure.pipelines.kpi.ofTotal", { total: k.definitions })}
        />
        <KpiTile
          label={t("ci.azure.pipelines.kpi.success")}
          info={t("ci.azure.pipelines.kpi.successInfo")}
          value={formatPercent(k.successRate, locale)}
          hint={t("ci.azure.pipelines.kpi.partial", { count: k.partial })}
        />
        <KpiTile
          label={t("ci.azure.pipelines.kpi.duration")}
          info={t("ci.azure.pipelines.kpi.durationInfo")}
          value={approx(formatDuration(k.p50), true)}
          hint={t("ci.azure.pipelines.kpi.p90", {
            p90: approx(formatDuration(k.p90), true),
          })}
        />
        <KpiTile
          label={t("ci.azure.pipelines.kpi.minutes")}
          info={t("ci.azure.pipelines.kpi.minutesInfo")}
          value={formatNumber(k.hostedMinutes, locale)}
          hint={rangeLabel}
          href={h.usage}
        />
        <KpiTile
          label={t("ci.azure.pipelines.kpi.macos")}
          value={formatPercent(k.macosShare, locale)}
          hint={t("ci.azure.pipelines.kpi.macosMinutes", { n: k.macosMinutes })}
        />
        {k.failing > 0 ? (
          <KpiTile
            variant="status"
            icon={CircleX}
            tone="critical"
            label={t("ci.azure.pipelines.kpi.failing")}
            value={formatNumber(k.failing, locale)}
            href={`${h.pipelines}?f=failing`}
          />
        ) : (
          <KpiTile
            label={t("ci.azure.pipelines.kpi.failing")}
            value={formatNumber(0, locale)}
          />
        )}
      </KpiStrip>
      <AzureBlockedNote blockedBy={state?.blockedBy ?? null} />
      <FilterBar>
        <SearchBox label={t("ci.azure.pipelines.search")} />
        <FilterChips
          label={t("ci.azure.pipelines.chips")}
          options={PIPELINE_FILTERS.map((f) => ({
            value: f,
            label: t(`ci.azure.pipelines.filter.${f}`),
          }))}
        />
        {page.projects.length > 1 ? (
          <ParamSelect
            label={t("ci.azure.pipelines.col.project")}
            param="project"
            allLabel={t("ci.azure.pipelines.allProjects")}
            options={page.projects.map((p) => ({ value: p.id, label: p.name }))}
          />
        ) : null}
        <ClearFilters keys={["q", "f", "project"]} />
      </FilterBar>
      <DataTable
        caption={t("ci.azure.pipelines.title")}
        columns={columns}
        rows={rows}
        rowKey={(p) => `${p.projectId}:${p.id}`}
        rowName={(p) => p.name}
        sort={{
          key: query.sort,
          dir: query.dir,
          base: h.pipelines,
          params: sp,
        }}
        empty={<EmptyState quiet message={t("ci.azure.pipelines.empty")} />}
      />
      <p className="text-xs text-muted-foreground">
        {t("ci.azure.pipelines.note")}
      </p>
    </div>
  );
}
