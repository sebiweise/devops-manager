import { CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import {
  CostsPerDayChart,
  EstimateNotice,
  IncludedGauge,
} from "@/components/costs/cost-charts";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import {
  ClearFilters,
  FilterBar,
  FilterChips,
  SearchBox,
} from "@/components/data/filter-bar";
import { InfoTip } from "@/components/data/info-tip";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import { Pagination } from "@/components/data/pagination";
import { StatusBadge } from "@/components/data/status-badge";
import { repoHref, workflowHref } from "@/components/insights/workflow-link";
import { PageHeader } from "@/components/shell/page-header";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { adjacentMonths, currentMonth } from "@/lib/costs-view";
import {
  formatMinutes,
  formatNumber,
  formatRatio,
  formatSignedPercent,
  formatUsd,
} from "@/lib/format";
import { accountMeta } from "@/lib/page-meta";
import type { CostRepoRow } from "@/lib/table-pages";
import {
  COST_REPO_FILTERS,
  COST_REPO_TABLE,
  COST_WORKFLOW_TABLE,
} from "@/lib/table-specs";
import {
  first,
  hrefWith,
  parseTableQuery,
  withParams,
  type SearchParamsLike,
} from "@/lib/url-state";
import { cn } from "@/lib/utils";
import {
  getCosts,
  listCostRepos,
  listCostWorkflows,
  parseMonth,
  type Costs,
} from "@/server/data/costs";

export const generateMetadata = accountMeta("costs");

const TABS = ["repos", "workflows", "runners"] as const;
type Tab = (typeof TABS)[number];
/** Repositories shown before "Show all". */
const TOP_REPOS = 10;
const IGNORED_KEY = "\u0000ignored";
const UNATTRIBUTED_KEY = "\u0000unattributed";

/**
 * Costs for all roles (UI overhaul §2.12): the month in the header, the
 * hero "Net this month" with projection, included minutes and the estimate,
 * the included-minutes gauge and the per-day chart, then one breakdown card
 * with tabs: by repository (estimate vs billed merged in, flagged rows, the
 * ignored repositories and unattributed usage as final rows so the column
 * sums equal the totals), by workflow (searched, sorted, paged) and by
 * runner type. Without billed data: estimates only, with the reason.
 */
export default async function CostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account } = await params;
  const sp = (await searchParams) as SearchParamsLike;
  const { scope, installation } = await loadAccount(account);
  const now = new Date();
  const month = parseMonth(first(sp, "month"), now);
  const [t, locale, format, costs] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(getCosts(scope, installation.id, month, now)),
  ]);
  const login = installation.accountLogin;
  const base = accountPath(login, "/costs");
  const { prev, next } = adjacentMonths(costs.month);
  const thisMonth = currentMonth(now);
  const billed = costs.source === "billed";
  const usd = (v: number) => formatUsd(v, locale);
  const min = (v: number) => formatMinutes(v, locale);
  const monthLabel = format.dateTime(
    new Date(`${costs.month}-01T00:00:00.000Z`),
    { year: "numeric", month: "long", timeZone: "UTC" },
  );
  const empty =
    costs.bySku.length === 0 && costs.totals.estMin === 0 && !billed;
  const rawTab = first(sp, "tab");
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as Tab)
    : "repos";
  const monthParam = first(sp, "month");
  const inc = costs.included;
  const ratio = inc.included > 0 ? inc.used / inc.included : null;
  const projectedOver = inc.included > 0 && inc.projectedUsed > inc.included;
  const repos = listCostRepos(costs, {
    sort: "net",
    dir: "desc",
    page: 1,
    size: 1,
  });

  const monthNav = (
    <nav aria-label={t("costs.monthNav")} className="flex gap-1 text-xs">
      <Link
        href={withParams(base, { month: prev })}
        className="rounded-md border px-2.5 py-1 hover:bg-accent"
      >
        {t("costs.prev")}
      </Link>
      <Link
        href={base}
        aria-current={costs.month === thisMonth ? "true" : undefined}
        className={
          costs.month === thisMonth
            ? "rounded-md border bg-secondary px-2.5 py-1 font-medium"
            : "rounded-md border px-2.5 py-1 hover:bg-accent"
        }
      >
        {t("costs.current")}
      </Link>
      {costs.month < thisMonth ? (
        <Link
          href={withParams(base, {
            month: next === thisMonth ? undefined : next,
          })}
          className="rounded-md border px-2.5 py-1 hover:bg-accent"
        >
          {t("costs.next")}
        </Link>
      ) : null}
    </nav>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("costs.title")}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">{monthLabel}</span>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                billed ? "bg-secondary" : "border-dashed",
              )}
            >
              {billed ? t("costs.kpi.billedFlag") : t("costs.kpi.estimateFlag")}
            </span>
            <span>
              {costs.syncedAt
                ? t("costs.synced", {
                    ago: format.relativeTime(new Date(costs.syncedAt), now),
                  })
                : t("costs.neverSynced")}
            </span>
          </span>
        }
        actions={monthNav}
      />

      <EstimateNotice costs={costs} accountType={installation.accountType} />

      {empty ? <EmptyState message={t("costs.noData")} /> : null}

      <KpiStrip label={t("overview.kpiLabel")} columns={5}>
        {billed ? (
          <KpiTile
            variant="hero"
            label={t("costs.kpi.netMonth")}
            info={t("costs.kpi.netInfo", {
              all: usd(costs.totals.netUsdAllProducts),
            })}
            value={usd(costs.totals.netUsd)}
            hint={t("costs.kpi.grossMinusDiscount", {
              gross: usd(costs.totals.grossUsd),
              discount: usd(costs.totals.discountUsd),
            })}
          />
        ) : (
          <KpiTile
            variant="hero"
            label={t("costs.kpi.estMonth")}
            info={t("costs.kpi.estInfo")}
            value={usd(costs.totals.estUsd)}
            hint={t("costs.kpi.estimateFlag")}
          />
        )}
        {projectedOver ? (
          <KpiTile
            variant="status"
            icon={TriangleAlert}
            tone="warning"
            label={
              billed ? t("costs.kpi.projectedNet") : t("costs.kpi.projectedEst")
            }
            info={t("costs.kpi.projectedInfo")}
            value={usd(inc.projectedNetUsd)}
            hint={t("costs.gauge.projectedOver")}
          />
        ) : (
          <KpiTile
            label={
              billed ? t("costs.kpi.projectedNet") : t("costs.kpi.projectedEst")
            }
            info={t("costs.kpi.projectedInfo")}
            value={usd(inc.projectedNetUsd)}
            hint={t("costs.kpi.projectedMinutes", {
              minutes: min(inc.projectedUsed),
            })}
          />
        )}
        <KpiTile
          variant="meter"
          label={t("costs.kpi.minutesIncluded")}
          info={t("costs.kpi.minutesIncludedInfo")}
          value={formatNumber(inc.used, locale)}
          ratio={ratio}
          overLabel={t("costs.gauge.over")}
          hint={
            inc.included > 0
              ? t("costs.kpi.ofIncluded", {
                  included: formatNumber(inc.included, locale),
                  source: t(`costs.gauge.sources.${inc.usedSource}`),
                })
              : t(`costs.gauge.sources.${inc.usedSource}`)
          }
        />
        <KpiTile
          label={t("costs.kpi.estUsd")}
          info={t("costs.kpi.estInfo")}
          value={usd(costs.totals.estUsd)}
          hint={t("costs.kpi.estMinutes", {
            minutes: min(costs.totals.estMin),
          })}
        />
      </KpiStrip>

      {costs.unmatchedJobs > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("costs.unmatched", { count: costs.unmatchedJobs })}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <IncludedGauge costs={costs} />
        <CostsPerDayChart costs={costs} />
      </div>

      <section
        aria-labelledby="breakdown"
        className="flex flex-col gap-4 rounded-xl border bg-card p-3 text-card-foreground sm:p-4"
      >
        <h2 id="breakdown" className="font-semibold">
          {t("costs.breakdown")}
        </h2>
        <nav
          aria-label={t("costs.breakdown")}
          className="overflow-x-auto border-b"
        >
          <ul className="flex w-max gap-1">
            {TABS.map((k) => (
              <li key={k}>
                <Link
                  href={withParams(base, {
                    tab: k === "repos" ? undefined : k,
                    month: monthParam,
                  })}
                  aria-current={tab === k ? "page" : undefined}
                  scroll={false}
                  className={cn(
                    "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap",
                    tab === k
                      ? "border-foreground font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`costs.tabs.${k}`)}
                  {k === "repos" && repos.flagged > 0 ? (
                    <span className="inline-flex items-center gap-0.5 text-xs">
                      <TriangleAlert
                        aria-hidden="true"
                        className="size-3 text-status-warning"
                      />
                      {repos.flagged}
                      <span className="sr-only">
                        {t("costs.flaggedCount", { count: repos.flagged })}
                      </span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {tab === "repos" ? (
          <ReposTab
            costs={costs}
            sp={sp}
            base={base}
            login={login}
            locale={locale}
          />
        ) : tab === "workflows" ? (
          <WorkflowsTab
            costs={costs}
            sp={sp}
            base={base}
            login={login}
            locale={locale}
          />
        ) : (
          <RunnerTypesTab costs={costs} locale={locale} />
        )}
      </section>
    </div>
  );
}

type TabProps = {
  costs: Costs;
  sp: SearchParamsLike;
  base: string;
  login: string;
  locale: string;
};

async function ReposTab({ costs, sp, base, login, locale }: TabProps) {
  const t = await getTranslations();
  const billed = costs.source === "billed";
  const usd = (v: number) => formatUsd(v, locale);
  const min = (v: number) => formatMinutes(v, locale);
  const query = parseTableQuery(sp, COST_REPO_TABLE);
  const showAll = first(sp, "all") === "1";
  const page = listCostRepos(costs, {
    ...query,
    page: showAll ? query.page : 1,
    size: showAll ? query.size : TOP_REPOS,
  });
  const netMax = Math.max(1e-9, ...page.rows.map((r) => r.netUsd));
  const estMax = Math.max(1e-9, ...page.rows.map((r) => r.estUsd));
  const special = (r: CostRepoRow) =>
    r.repositoryFullName === IGNORED_KEY ||
    r.repositoryFullName === UNATTRIBUTED_KEY;

  const tail: CostRepoRow[] = [
    ...(page.ignored
      ? [
          {
            repositoryFullName: IGNORED_KEY,
            billedQuantity: page.ignored.billedQuantity,
            grossUsd: page.ignored.grossUsd,
            netUsd: page.ignored.netUsd,
            estMin: 0,
            estUsd: 0,
            billedGrossUsd: null,
            deviation: null,
            flagged: false,
          } satisfies CostRepoRow,
        ]
      : []),
    ...(page.unattributed
      ? [{ ...page.unattributed, repositoryFullName: UNATTRIBUTED_KEY }]
      : []),
  ];

  const columns: Column<CostRepoRow>[] = [
    {
      id: "repo",
      label: t("costs.byRepo.repo"),
      header: t("costs.byRepo.repo"),
      sortKey: "name",
      cell: (r) =>
        r.repositoryFullName === IGNORED_KEY ? (
          <span className="inline-flex items-center gap-1">
            {t("costs.byRepo.ignored", {
              count: page.ignored?.repositories ?? 0,
            })}
            <InfoTip
              label={t("costs.byRepo.ignored", {
                count: page.ignored?.repositories ?? 0,
              })}
            >
              {t("costs.byRepo.ignoredInfo")}
            </InfoTip>
          </span>
        ) : r.repositoryFullName === UNATTRIBUTED_KEY ? (
          <span className="inline-flex items-center gap-1">
            {t("costs.byRepo.unattributed")}
            <InfoTip label={t("costs.byRepo.unattributed")}>
              {t("costs.byRepo.unattributedInfo")}
            </InfoTip>
          </span>
        ) : (
          <Link
            href={repoHref(login, r.repositoryFullName)}
            title={r.repositoryFullName}
            className="font-medium underline-offset-2 hover:underline"
          >
            {r.repositoryFullName.split("/").pop()}
          </Link>
        ),
    },
    ...(billed
      ? ([
          {
            id: "net",
            label: t("costs.bySku.net"),
            header: t("costs.bySku.net"),
            sortKey: "net",
            align: "right",
            magnitude: (r) => (special(r) ? null : r.netUsd / netMax),
            cell: (r) => usd(r.netUsd),
          },
          {
            id: "gross",
            label: t("costs.bySku.gross"),
            header: t("costs.bySku.gross"),
            sortKey: "gross",
            align: "right",
            hideBelow: "md",
            cell: (r) => usd(r.grossUsd),
          },
          {
            id: "minutes",
            label: t("costs.byRepo.minutes"),
            header: t("costs.byRepo.minutes"),
            sortKey: "minutes",
            align: "right",
            hideBelow: "md",
            cell: (r) => formatNumber(r.billedQuantity, locale),
          },
        ] satisfies Column<CostRepoRow>[])
      : []),
    {
      id: "estimate",
      label: t("costs.reconciliation.estimate"),
      header: t("costs.reconciliation.estimate"),
      sortKey: "estimate",
      align: "right",
      magnitude: billed
        ? undefined
        : (r) => (special(r) ? null : r.estUsd / estMax),
      cell: (r) =>
        special(r) ? (
          "—"
        ) : (
          <span className="flex flex-col items-end">
            <span>{usd(r.estUsd)}</span>
            <span className="text-xs text-muted-foreground">
              {min(r.estMin)}
            </span>
          </span>
        ),
    },
    ...(billed
      ? ([
          {
            id: "billed",
            label: t("costs.reconciliation.billed"),
            header: t("costs.reconciliation.billedGross"),
            align: "right",
            hideBelow: "lg",
            cell: (r) =>
              r.billedGrossUsd == null ? "—" : usd(r.billedGrossUsd),
          },
          {
            id: "deviation",
            label: t("costs.reconciliation.deviation"),
            header: t("costs.reconciliation.deviation"),
            sortKey: "deviation",
            align: "right",
            hideBelow: "lg",
            cell: (r) => (
              <span className="inline-flex items-center justify-end gap-1.5">
                {r.deviation == null
                  ? "—"
                  : formatSignedPercent(r.deviation, locale)}
                {r.flagged ? <StatusBadge kind="deviation" /> : null}
              </span>
            ),
          },
        ] satisfies Column<CostRepoRow>[])
      : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      {billed ? (
        page.flagged === 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CircleCheck
              aria-hidden="true"
              className="size-4 text-status-good"
            />
            {t("costs.reconciliation.allOk")}
          </p>
        ) : (
          <FilterBar>
            <SearchBox label={t("costs.searchRepo")} />
            <FilterChips
              label={t("costs.reconciliation.title")}
              options={COST_REPO_FILTERS.map((f) => ({
                value: f,
                label: t("costs.flaggedOnly"),
                count: page.flagged,
              }))}
            />
            <ClearFilters />
          </FilterBar>
        )
      ) : null}
      <DataTable
        caption={t("costs.byRepo.title")}
        columns={columns}
        rows={page.rows}
        rowKey={(r) => r.repositoryFullName}
        sort={{ key: query.sort, dir: query.dir, base, params: sp }}
        tail={query.q || query.filters.length > 0 ? [] : tail}
        empty={<EmptyState quiet message={t("costs.byRepo.empty")} />}
      />
      {showAll ? (
        <Pagination
          base={base}
          params={sp}
          page={page.page}
          size={page.size}
          total={page.total}
        />
      ) : page.total > TOP_REPOS ? (
        <Link
          href={hrefWith(base, sp, { all: 1, page: undefined })}
          scroll={false}
          className="w-fit text-sm underline-offset-2 hover:underline"
        >
          {t("costs.showAll", { count: page.total })}
        </Link>
      ) : null}
      {billed ? (
        <p className="text-xs text-muted-foreground">
          {t("costs.reconciliation.description")} {t("billingStatus.deviation")}
        </p>
      ) : null}
    </div>
  );
}

async function WorkflowsTab({ costs, sp, base, login, locale }: TabProps) {
  const t = await getTranslations();
  const billed = costs.source === "billed";
  const usd = (v: number) => formatUsd(v, locale);
  const min = (v: number) => formatMinutes(v, locale);
  const query = parseTableQuery(sp, COST_WORKFLOW_TABLE);
  const page = listCostWorkflows(costs, query);
  type Row = Costs["byWorkflow"][number];
  const minMax = Math.max(1e-9, ...page.rows.map((w) => w.estMin));
  const columns: Column<Row>[] = [
    {
      id: "name",
      label: t("costs.byWorkflow.workflow"),
      header: t("costs.byWorkflow.workflow"),
      sortKey: "name",
      cell: (w) => (
        <span className="flex flex-col">
          <Link
            href={workflowHref(login, w.repositoryFullName, w.workflowId)}
            className="font-medium underline-offset-2 hover:underline"
          >
            {w.workflowName}
          </Link>
          <span className="text-xs text-muted-foreground">
            {w.repositoryFullName.split("/").pop()} · {w.sku}
          </span>
        </span>
      ),
    },
    {
      id: "minutes",
      label: t("costs.bySku.estMin"),
      header: t("costs.bySku.estMin"),
      sortKey: "minutes",
      align: "right",
      magnitude: (w) => w.estMin / minMax,
      cell: (w) => min(w.estMin),
    },
    {
      id: "estimate",
      label: t("costs.bySku.estUsd"),
      header: t("costs.bySku.estUsd"),
      sortKey: "estimate",
      align: "right",
      cell: (w) => usd(w.estUsd),
    },
    ...(billed
      ? ([
          {
            id: "scale",
            label: t("costs.byWorkflow.scale"),
            header: t("costs.byWorkflow.scale"),
            align: "right",
            hideBelow: "lg",
            cell: (w) =>
              w.scale == null
                ? t("costs.notBilled")
                : `×${formatRatio(w.scale, locale)}`,
          },
          {
            id: "scaledMin",
            label: t("costs.byWorkflow.scaledMin"),
            header: t("costs.byWorkflow.scaledMin"),
            align: "right",
            hideBelow: "lg",
            cell: (w) => (w.scaledMin == null ? "—" : min(w.scaledMin)),
          },
          {
            id: "net",
            label: t("costs.byWorkflow.scaledNet"),
            header: t("costs.byWorkflow.scaledNet"),
            sortKey: "net",
            align: "right",
            hideBelow: "md",
            cell: (w) => (w.scaledNetUsd == null ? "—" : usd(w.scaledNetUsd)),
          },
        ] satisfies Column<Row>[])
      : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {billed
          ? `${t("billingStatus.scaled")}: ${t("costs.byWorkflow.description")}`
          : t("billingStatus.estimated")}{" "}
        {t("costs.byWorkflow.ignoredNote")}
      </p>
      <FilterBar>
        <SearchBox label={t("costs.searchWorkflow")} />
        <ClearFilters />
      </FilterBar>
      <DataTable
        caption={t("costs.byWorkflow.title")}
        columns={columns}
        rows={page.rows}
        rowKey={(w) => `${w.repositoryFullName}|${w.sku}|${w.workflowId}`}
        sort={{ key: query.sort, dir: query.dir, base, params: sp }}
        empty={<EmptyState quiet message={t("costs.byWorkflow.empty")} />}
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

async function RunnerTypesTab({
  costs,
  locale,
}: {
  costs: Costs;
  locale: string;
}) {
  const t = await getTranslations();
  const billed = costs.source === "billed";
  const usd = (v: number) => formatUsd(v, locale);
  const min = (v: number) => formatMinutes(v, locale);
  type Row = Costs["bySku"][number];
  const columns: Column<Row>[] = [
    {
      id: "sku",
      label: t("costs.bySku.sku"),
      header: t("costs.bySku.sku"),
      cell: (s) => (
        <span className="flex flex-col">
          <span className="font-medium">{runnerTypeName(s.skuKey, t)}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {s.sku}
          </span>
        </span>
      ),
    },
    {
      id: "multiplier",
      label: t("costs.bySku.multiplier"),
      header: t("costs.bySku.multiplier"),
      align: "right",
      hideBelow: "md",
      cell: (s) =>
        s.minuteMultiplier == null
          ? "—"
          : `×${formatNumber(s.minuteMultiplier, locale)}`,
    },
    ...(billed
      ? ([
          {
            id: "quantity",
            label: t("costs.bySku.quantity"),
            header: t("costs.bySku.quantity"),
            align: "right",
            hideBelow: "lg",
            cell: (s) =>
              `${formatNumber(s.billedQuantity, locale)}${s.unitType ? ` ${s.unitType}` : ""}`,
          },
          {
            id: "gross",
            label: t("costs.bySku.gross"),
            header: t("costs.bySku.gross"),
            align: "right",
            hideBelow: "md",
            cell: (s) => usd(s.grossUsd),
          },
          {
            id: "discount",
            label: t("costs.bySku.discount"),
            header: t("costs.bySku.discount"),
            align: "right",
            hideBelow: "lg",
            cell: (s) => usd(s.discountUsd),
          },
          {
            id: "net",
            label: t("costs.bySku.net"),
            header: t("costs.bySku.net"),
            align: "right",
            cell: (s) => usd(s.netUsd),
          },
        ] satisfies Column<Row>[])
      : []),
    {
      id: "est",
      label: t("costs.reconciliation.estimate"),
      header: t("costs.reconciliation.estimate"),
      align: "right",
      cell: (s) => (
        <span className="flex flex-col items-end">
          <span>{usd(s.estUsd)}</span>
          <span className="text-xs text-muted-foreground">{min(s.estMin)}</span>
        </span>
      ),
    },
  ];
  return (
    <DataTable
      caption={t("costs.bySku.title")}
      columns={columns}
      rows={costs.bySku}
      rowKey={(s) => s.skuKey}
      empty={<EmptyState quiet message={t("costs.byWorkflow.empty")} />}
    />
  );
}

/** Readable runner type from the SkuRate key: "linux_4_core" → "Linux · 4 cores". */
function runnerTypeName(
  key: string,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  const os = key.startsWith("linux")
    ? "Linux"
    : key.startsWith("windows")
      ? "Windows"
      : key.startsWith("macos")
        ? "macOS"
        : key;
  const cores = /_(\d+)_core/.exec(key)?.[1];
  return cores ? `${os} · ${t("costs.cores", { n: Number(cores) })}` : os;
}
