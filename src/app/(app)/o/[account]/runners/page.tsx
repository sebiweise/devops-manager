import { Unplug } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  ParamSelect,
  SearchBox,
  SortSelect,
} from "@/components/data/filter-bar";
import { InfoTip } from "@/components/data/info-tip";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import { Pagination } from "@/components/data/pagination";
import { StatusBadge } from "@/components/data/status-badge";
import { AutoRefresh } from "@/components/insights/auto-refresh";
import { repoHref } from "@/components/insights/workflow-link";
import {
  LabelList,
  UtilisationMeter,
} from "@/components/runners/runner-badges";
import {
  ConcurrencyChart,
  PoolHeatmap,
} from "@/components/runners/runner-charts";
import { PageHeader } from "@/components/shell/page-header";
import { PoolsSection } from "@/components/azure/azure-views";
import { getAzureUsage } from "@/server/data/azure";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
  formatRatio,
  formatSignedPercent,
} from "@/lib/format";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";
import { pageRows } from "@/lib/paging";
import { lazyRunnerSample } from "@/lib/runner-sample";
import { runnerHref } from "@/lib/runners-view";
import { runnerState } from "@/lib/table-pages";
import {
  RUNNER_FILTERS,
  RUNNER_SORTS,
  RUNNER_TABLE,
  type RunnerFilter,
  type RunnerSortKey,
} from "@/lib/table-specs";
import {
  first,
  hrefWith,
  parseTableQuery,
  withParams,
  type SearchParamsLike,
  type TableQuery,
} from "@/lib/url-state";
import { cn } from "@/lib/utils";
import {
  getConcurrencyTimeline,
  getHostedVsSelfHosted,
  listRunnerPools,
  listRunnersPage,
  type HostedComparisonDto,
  type PoolDto,
  type RunnerDto,
} from "@/server/data/runners";

export const generateMetadata = accountMeta("runners");

const VIEWS = ["runners", "pools", "compare"] as const;
type View = (typeof VIEWS)[number];

const poolKey = (p: Pick<PoolDto, "runnerKind" | "labelKey">) =>
  `${p.runnerKind}:${p.labelKey}`;

/** One 100 % bar of hosted vs self-hosted minutes, both segments labelled. */
function SplitBar({
  hosted,
  selfHosted,
  hostedLabel,
  selfLabel,
}: {
  hosted: number;
  selfHosted: number;
  hostedLabel: string;
  selfLabel: string;
}) {
  const total = hosted + selfHosted;
  const h = total > 0 ? hosted / total : 0;
  return (
    <span className="flex flex-col gap-1">
      <span
        aria-hidden="true"
        className="flex h-2 gap-0.5 overflow-hidden rounded-full"
      >
        {total > 0 ? (
          <>
            <span className="bg-series-1" style={{ width: `${h * 100}%` }} />
            <span
              className="bg-series-2"
              style={{ width: `${(1 - h) * 100}%` }}
            />
          </>
        ) : (
          <span className="w-full bg-muted" />
        )}
      </span>
      <span className="flex flex-col text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-series-1"
          />
          {hostedLabel}
        </span>
        <span className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-series-2"
          />
          {selfLabel}
        </span>
      </span>
    </span>
  );
}

/**
 * Runners (UI overhaul §2.9): KPIs, then three views — every runner in one
 * table (state chips, search by name or label, repository filter, sortable
 * and paged), the runner groups with concurrency and a weekday × hour
 * heatmap for the selected group, and hosted vs self-hosted for the same
 * jobs (sorted by the size of the difference, paged). Opening the page
 * schedules a lazy runner sample; it refreshes every 30 s.
 */
export default async function RunnersPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account } = await params;
  const sp = (await searchParams) as SearchParamsLike;
  const { scope, installation } = await loadAccount(account);
  const azureUsage = await orNotFound(getAzureUsage(scope, installation.id));
  const range = await pageRange(sp);
  const rawView = first(sp, "view");
  const view: View = (VIEWS as readonly string[]).includes(rawView ?? "")
    ? (rawView as View)
    : "runners";
  const query = parseTableQuery(sp, RUNNER_TABLE);
  const repo = first(sp, "repo");
  const sampling = await lazyRunnerSample(installation.id);
  const [t, locale, format, list, pools] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(
      listRunnersPage(scope, installation.id, {
        ...query,
        ...(repo && /^\d{1,20}$/.test(repo) ? { repositoryId: repo } : {}),
      }),
    ),
    orNotFound(listRunnerPools(scope, installation.id, range)),
  ]);
  const login = installation.accountLogin;
  const acct = accountPath(login);
  const base = accountPath(login, "/runners");
  const ago = (iso: string | null) =>
    iso ? format.relativeTime(new Date(iso)) : t("freshness.never");

  // ---- KPIs ----
  const util = list.utilisation;
  const worstQueue = [...pools.pools]
    .filter((p) => p.queueP95 != null)
    .sort((a, b) => (b.queueP95 ?? 0) - (a.queueP95 ?? 0))[0];
  const hostedMin = pools.split
    .filter(
      (s) =>
        s.runnerKind === "GITHUB_HOSTED" || s.runnerKind === "LARGER_HOSTED",
    )
    .reduce((s, k) => s + k.minutes, 0);
  const selfMin = pools.split
    .filter((s) => s.runnerKind === "SELF_HOSTED")
    .reduce((s, k) => s + k.minutes, 0);

  const notes: ReactNode[] = [
    t("runners.sampled", {
      sampled: ago(list.sampledAt),
      discovered: ago(list.discoveredAt),
    }),
    ...(sampling ? [t("runners.sampling")] : []),
    ...(!list.repoRunnersGranted ? [t("runnerData.repoRunnersMissing")] : []),
    ...(list.isOrganization && !list.orgRunnersGranted
      ? [t("runnerData.orgRunnersMissing")]
      : []),
    t("runnerData.speedIndexHint"),
  ];

  const tabs = (
    <nav aria-label={t("runners.views")} className="overflow-x-auto border-b">
      <ul className="flex w-max gap-1">
        {VIEWS.map((v) => (
          <li key={v}>
            <Link
              href={withParams(base, {
                view: v === "runners" ? undefined : v,
                range: first(sp, "range"),
              })}
              aria-current={view === v ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex border-b-2 px-3 py-2 text-sm whitespace-nowrap",
                view === v
                  ? "border-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`runners.view.${v}`)}
              {v === "runners" ? (
                <span className="ml-1.5 rounded-full bg-secondary px-1.5 text-xs font-normal tabular-nums">
                  {formatNumber(list.counts.all, locale)}
                </span>
              ) : v === "pools" ? (
                <span className="ml-1.5 rounded-full bg-secondary px-1.5 text-xs font-normal tabular-nums">
                  {formatNumber(pools.pools.length, locale)}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );

  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh />
      <PageHeader
        title={t("runners.title")}
        subtitle={t("runners.subtitle", {
          total: list.counts.all,
          range: t(`filters.ranges.${range}`),
        })}
        info={
          <ul className="flex list-inside list-disc flex-col gap-0.5">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        }
        infoLabel={t("runners.aboutData")}
      />

      <KpiStrip label={t("overview.kpiLabel")}>
        <KpiTile
          label={t("runners.kpi.selfHosted")}
          info={t("runners.kpi.selfHostedInfo")}
          value={formatNumber(list.counts.all, locale)}
          hint={t("runners.kpi.idle", { count: list.counts.idle })}
          href={withParams(base, { range: first(sp, "range") })}
        />
        <KpiTile
          label={t("runners.kpi.busy")}
          info={t("runners.kpi.busyInfo")}
          value={formatNumber(list.counts.busy, locale)}
          href={withParams(base, { f: "busy" })}
        />
        {list.counts.offline > 0 ? (
          <KpiTile
            variant="status"
            icon={Unplug}
            tone="warning"
            label={t("runners.kpi.offline")}
            info={t("overview.kpi.offlineInfo")}
            value={formatNumber(list.counts.offline, locale)}
            href={withParams(base, { f: "offline" })}
          />
        ) : (
          <KpiTile
            label={t("runners.kpi.offline")}
            info={t("overview.kpi.offlineInfo")}
            value={formatNumber(0, locale)}
          />
        )}
        <KpiTile
          variant="meter"
          label={t("runners.kpi.utilisation")}
          info={t("runners.kpi.utilisationInfo")}
          value={util == null ? "—" : formatPercent(util, locale)}
          ratio={util}
          hint={t("runners.kpi.utilisationHint")}
        />
        <KpiTile
          label={t("runners.kpi.queueP95")}
          info={t("runners.kpi.queueP95Info")}
          value={formatDuration(worstQueue?.queueP95 ?? null)}
          hint={
            worstQueue
              ? t("runners.kpi.queueWorst", {
                  pool: worstQueue.labelKey || "—",
                })
              : undefined
          }
          href={withParams(base, { view: "pools" })}
        />
        <KpiTile
          label={t("runners.kpi.split")}
          info={t("runners.kpi.splitInfo")}
          value={
            hostedMin + selfMin > 0
              ? formatPercent(selfMin / (hostedMin + selfMin), locale, 0)
              : "—"
          }
          hint={
            <SplitBar
              hosted={hostedMin}
              selfHosted={selfMin}
              hostedLabel={`${t("runnerKind.GITHUB_HOSTED")} ${formatMinutes(hostedMin, locale)}`}
              selfLabel={`${t("runnerKind.SELF_HOSTED")} ${formatMinutes(selfMin, locale)}`}
            />
          }
        />
      </KpiStrip>

      {tabs}

      {view === "runners" ? (
        <RunnersView
          list={list}
          query={query}
          sp={sp}
          base={base}
          acct={acct}
          login={login}
          locale={locale}
          ago={ago}
        />
      ) : view === "pools" ? (
        <PoolsView
          scope={scope}
          installationId={installation.id}
          pools={pools.pools}
          split={pools.split}
          sp={sp}
          base={base}
          locale={locale}
        />
      ) : (
        <CompareView
          scope={scope}
          installationId={installation.id}
          range={range}
          sp={sp}
          base={base}
          locale={locale}
        />
      )}
      {azureUsage ? (
        <PoolsSection
          pools={azureUsage.pools}
          usageHref={`/o/${encodeURIComponent(installation.accountLogin)}/pipelines/usage`}
        />
      ) : null}
    </div>
  );
}

async function RunnersView({
  list,
  query,
  sp,
  base,
  acct,
  login,
  locale,
  ago,
}: {
  list: Awaited<ReturnType<typeof listRunnersPage>>;
  query: TableQuery<RunnerSortKey, RunnerFilter>;
  sp: SearchParamsLike;
  base: string;
  acct: string;
  login: string;
  locale: string;
  ago: (iso: string | null) => string;
}) {
  const t = await getTranslations();
  const columns: Column<RunnerDto>[] = [
    {
      id: "name",
      label: t("runners.name"),
      header: t("runners.name"),
      sortKey: "name",
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Link
            href={runnerHref(acct, r.key)}
            className="font-medium underline-offset-2 hover:underline"
          >
            {r.name}
          </Link>
          {r.ephemeral ? (
            <span className="text-xs text-muted-foreground">
              {t("runnerData.ephemeral")}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "scope",
      label: t("runners.scope"),
      header: t("runners.scope"),
      hideBelow: "md",
      cell: (r) =>
        r.repository ? (
          <Link
            href={repoHref(login, r.repository.fullName)}
            className="text-sm underline-offset-2 hover:underline"
          >
            {r.repository.fullName.split("/").pop()}
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("runners.orgScope")}
          </span>
        ),
    },
    {
      id: "state",
      label: t("runners.status"),
      header: t("runners.status"),
      sortKey: "state",
      cell: (r) => <StatusBadge kind={runnerState(r)} />,
    },
    {
      id: "labels",
      label: t("runners.labels"),
      header: t("runners.labels"),
      hideBelow: "lg",
      cell: (r) => <LabelList labels={r.labels} max={2} />,
    },
    {
      id: "jobs",
      label: t("runners.jobs"),
      header: t("runners.jobs"),
      sortKey: "jobs",
      align: "right",
      hideBelow: "md",
      cell: (r) => formatNumber(r.jobs7d, locale),
    },
    {
      id: "utilisation",
      label: t("runners.utilisation"),
      header: t("runners.utilisation"),
      sortKey: "utilisation",
      hideBelow: "md",
      cell: (r) => <UtilisationMeter u={r.utilisation7d} />,
    },
    {
      id: "lastSeen",
      label: t("runners.lastSeen"),
      header: t("runners.lastSeen"),
      sortKey: "lastSeen",
      align: "right",
      hideBelow: "lg",
      cell: (r) => (
        <time dateTime={r.lastSeenAt} className="text-xs text-muted-foreground">
          {ago(r.lastSeenAt)}
        </time>
      ),
    },
    {
      id: "os",
      label: t("runners.os"),
      header: t("runners.os"),
      expanderOnly: true,
      cell: (r) => r.os,
    },
    {
      id: "group",
      label: t("runners.group"),
      header: t("runners.group"),
      expanderOnly: true,
      cell: (r) => r.groupName ?? "—",
    },
    {
      id: "allLabels",
      label: t("runners.allLabels"),
      header: t("runners.allLabels"),
      expanderOnly: true,
      cell: (r) => <LabelList labels={r.labels} />,
    },
    {
      id: "speed",
      label: t("runnerData.speedIndex"),
      header: t("runnerData.speedIndex"),
      expanderOnly: true,
      cell: (r) => formatRatio(r.speedIndex7d, locale),
    },
    {
      id: "infra",
      label: t("runnerData.infraFailures"),
      header: t("runnerData.infraFailures"),
      expanderOnly: true,
      cell: (r) => formatNumber(r.infraFailures7d, locale),
    },
  ];
  const repoOptions = list.repositoryOptions.map(
    (r) => [r.id, r.fullName] as const,
  );
  const sortOptions = RUNNER_SORTS.flatMap((s) =>
    (["asc", "desc"] as const).map((dir) => ({
      value: s,
      dir,
      label: t(`runners.sortBy.${s}`, { dir }),
    })),
  );
  const active = !!query.q || query.filters.length > 0 || !!first(sp, "repo");
  return (
    <section className="flex flex-col gap-3">
      <FilterBar>
        <SearchBox label={t("runners.search")} />
        <FilterChips
          label={t("runners.chips")}
          options={RUNNER_FILTERS.map((f) => ({
            value: f,
            label: t(`badge.${f}.label`),
            count: list.counts[f],
          }))}
        />
        {repoOptions.length > 0 ? (
          <ParamSelect
            label={t("workflows.repoFilter")}
            param="repo"
            allLabel={t("runners.allScopes")}
            options={repoOptions.map(([id, name]) => ({
              value: id,
              label: name.split("/").pop() ?? name,
            }))}
          />
        ) : null}
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
        caption={t("runners.caption")}
        columns={columns}
        rows={list.rows}
        rowKey={(r) => r.key}
        sort={{ key: query.sort, dir: query.dir, base, params: sp }}
        empty={
          <EmptyState
            message={active ? t("runners.noMatch") : t("runners.noSelfHosted")}
          />
        }
      />
      {list.total > 0 ? (
        <Pagination
          base={base}
          params={sp}
          page={list.page}
          size={list.size}
          total={list.total}
        />
      ) : null}
    </section>
  );
}

async function PoolsView({
  scope,
  installationId,
  pools,
  split,
  sp,
  base,
  locale,
}: {
  scope: Awaited<ReturnType<typeof loadAccount>>["scope"];
  installationId: bigint;
  pools: PoolDto[];
  split: Awaited<ReturnType<typeof listRunnerPools>>["split"];
  sp: SearchParamsLike;
  base: string;
  locale: string;
}) {
  const t = await getTranslations();
  const selectedKey = first(sp, "pool");
  const selected =
    pools.find((p) => poolKey(p) === selectedKey) ??
    pools.find((p) => p.heatmap.length > 0) ??
    null;
  const concurrency = await orNotFound(
    getConcurrencyTimeline(
      scope,
      installationId,
      selected && selectedKey ? { labelKey: selected.labelKey } : {},
    ),
  );
  const hostedPools = pools.some((p) => p.runnerKind !== "SELF_HOSTED");
  const columns: Column<PoolDto>[] = [
    {
      id: "pool",
      className: "whitespace-normal",
      label: t("runners.pools.pool"),
      header: t("runners.pools.pool"),
      cell: (p) => (
        <Link
          href={hrefWith(base, sp, { pool: poolKey(p) })}
          aria-current={
            selected && poolKey(selected) === poolKey(p) ? "true" : undefined
          }
          scroll={false}
          className="group inline-flex flex-col gap-1 rounded-sm"
          title={t("runners.pools.showHeatmap")}
        >
          <LabelList labels={p.labels} max={3} />
          <span className="text-xs text-muted-foreground group-hover:underline">
            {t(`runnerKind.${p.runnerKind}`)}
            {p.runnerKind === "SELF_HOSTED"
              ? ` · ${t("runners.pools.runnerCount", { count: p.runners })}`
              : ""}
          </span>
        </Link>
      ),
    },
    {
      id: "jobs",
      label: t("runners.split.jobs"),
      header: t("runners.split.jobs"),
      align: "right",
      cell: (p) => formatNumber(p.jobs, locale),
    },
    {
      id: "minutes",
      label: t("runners.pools.minutes"),
      header: t("runners.pools.minutes"),
      align: "right",
      hideBelow: "md",
      cell: (p) => formatMinutes(p.minutes, locale),
    },
    {
      id: "avg",
      label: t("runners.pools.avgConcurrency"),
      header: t("runners.pools.avgConcurrency"),
      align: "right",
      hideBelow: "lg",
      cell: (p) =>
        new Intl.NumberFormat(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(p.avgConcurrency),
    },
    {
      id: "peak",
      label: t("runners.pools.peakConcurrency"),
      header: t("runners.pools.peakConcurrency"),
      align: "right",
      hideBelow: "lg",
      cell: (p) => formatNumber(p.peakConcurrency, locale),
    },
    {
      id: "q50",
      label: t("runners.pools.queueP50"),
      header: t("runners.pools.queueP50"),
      align: "right",
      hideBelow: "lg",
      cell: (p) => formatDuration(p.queueP50),
    },
    {
      id: "q95",
      label: t("runners.pools.queueP95"),
      header: t("runners.pools.queueP95"),
      align: "right",
      cell: (p) => formatDuration(p.queueP95),
    },
    {
      id: "util",
      label: t("runners.utilisation"),
      header: t("runners.utilisation"),
      hideBelow: "md",
      cell: (p) =>
        p.utilisation ? <UtilisationMeter u={p.utilisation} /> : "—",
    },
  ];
  return (
    <section className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t("runners.pools.description")}
        {hostedPools ? ` ${t("runners.pools.highQueue")}` : ""}
      </p>
      <DataTable
        caption={t("runners.pools.title")}
        columns={columns}
        rows={pools}
        rowKey={poolKey}
        muted={(p) =>
          !!selected && poolKey(selected) !== poolKey(p) && !!selectedKey
        }
        empty={<EmptyState message={t("runners.pools.empty")} />}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {selected ? (
          <PoolHeatmap pool={selected} />
        ) : (
          <EmptyState quiet message={t("runners.pools.noHeatmap")} />
        )}
        <ConcurrencyChart data={concurrency} />
      </div>
      <h2 className="font-medium">{t("runners.split.title")}</h2>
      <DataTable
        caption={t("runners.split.title")}
        columns={[
          {
            id: "kind",
            label: t("runners.split.kind"),
            header: t("runners.split.kind"),
            cell: (k) => t(`runnerKind.${k.runnerKind}`),
          },
          {
            id: "jobs",
            label: t("runners.split.jobs"),
            header: t("runners.split.jobs"),
            align: "right",
            cell: (k) => formatNumber(k.jobs, locale),
          },
          {
            id: "minutes",
            label: t("runners.split.minutes"),
            header: t("runners.split.minutes"),
            align: "right",
            hideBelow: "sm",
            cell: (k) => formatMinutes(k.minutes, locale),
          },
          {
            id: "billable",
            label: t("runners.split.billable"),
            header: t("runners.split.billable"),
            align: "right",
            cell: (k) => formatMinutes(k.billableMinEst, locale),
          },
        ]}
        rows={split}
        rowKey={(k) => k.runnerKind}
      />
    </section>
  );
}

async function CompareView({
  scope,
  installationId,
  range,
  sp,
  base,
  locale,
}: {
  scope: Awaited<ReturnType<typeof loadAccount>>["scope"];
  installationId: bigint;
  range: Awaited<ReturnType<typeof pageRange>>;
  sp: SearchParamsLike;
  base: string;
  locale: string;
}) {
  const t = await getTranslations();
  const compare = await orNotFound(
    getHostedVsSelfHosted(scope, installationId, { range }),
  );
  type Row = HostedComparisonDto["rows"][number];
  const query = parseTableQuery(sp, {
    sorts: ["delta"] as const,
    defaultSort: "delta",
  });
  const page = pageRows(compare.rows, query, {
    text: (r) => `${r.workflowName} ${r.baseName}`,
    keys: { delta: (r) => (r.deltaP50 == null ? null : Math.abs(r.deltaP50)) },
  });
  const maxDelta = Math.max(
    0.01,
    ...compare.rows.map((r) => Math.abs(r.deltaP50 ?? 0)),
  );
  const columns: Column<Row>[] = [
    {
      id: "job",
      label: t("workflow.job"),
      header: t("workflow.job"),
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-medium">{r.baseName}</span>
          <span className="text-xs text-muted-foreground">
            {r.workflowName || r.workflowId || "—"}
          </span>
        </span>
      ),
    },
    {
      id: "hp50",
      label: t("workflow.hostedP50"),
      header: t("workflow.hostedP50"),
      align: "right",
      hideBelow: "md",
      cell: (r) => formatDuration(r.hosted.p50),
    },
    {
      id: "sp50",
      label: t("workflow.selfHostedP50"),
      header: t("workflow.selfHostedP50"),
      align: "right",
      hideBelow: "md",
      cell: (r) => formatDuration(r.selfHosted.p50),
    },
    {
      id: "delta",
      label: t("workflow.delta"),
      header: (
        <span className="inline-flex items-center gap-1">
          {t("workflow.delta")}
          <InfoTip label={t("workflow.delta")}>
            {t("runners.compare.deltaInfo")}
          </InfoTip>
        </span>
      ),
      cell: (r) => {
        const d = r.deltaP50;
        if (d == null) return "—";
        const w = Math.min(1, Math.abs(d) / maxDelta) * 50;
        return (
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="relative block h-2 w-24 shrink-0 rounded-full bg-muted"
            >
              <span className="absolute inset-y-0 left-1/2 w-px bg-status-neutral" />
              <span
                className={cn(
                  "absolute inset-y-0 rounded-full",
                  d < 0 ? "right-1/2 bg-series-1" : "left-1/2 bg-series-2",
                )}
                style={{ width: `${w}%` }}
              />
            </span>
            <span className="text-sm tabular-nums">
              {formatSignedPercent(d, locale)}
            </span>
            <span className="sr-only">
              {d < 0
                ? t("runners.compare.faster")
                : t("runners.compare.slower")}
            </span>
          </span>
        );
      },
    },
    {
      id: "hp95",
      label: t("workflow.hostedP95"),
      header: t("workflow.hostedP95"),
      align: "right",
      expanderOnly: true,
      cell: (r) => formatDuration(r.hosted.p95),
    },
    {
      id: "sp95",
      label: t("workflow.selfHostedP95"),
      header: t("workflow.selfHostedP95"),
      align: "right",
      expanderOnly: true,
      cell: (r) => formatDuration(r.selfHosted.p95),
    },
    {
      id: "queue",
      label: t("workflow.queueCompare"),
      header: t("workflow.queueCompare"),
      expanderOnly: true,
      cell: (r) =>
        `${formatDuration(r.hosted.queueP95)} / ${formatDuration(r.selfHosted.queueP95)}`,
    },
  ];
  return (
    <section className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {t("runners.compare.description")}
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-series-1"
          />
          {t("runners.compare.legendFaster")}
        </span>
        <span className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-series-2"
          />
          {t("runners.compare.legendSlower")}
        </span>
      </p>
      <DataTable
        caption={t("runners.compare.title")}
        columns={columns}
        rows={page.rows}
        rowKey={(r) => `${r.workflowId}|${r.baseName}`}
        empty={<EmptyState message={t("runners.compare.empty")} />}
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
    </section>
  );
}
