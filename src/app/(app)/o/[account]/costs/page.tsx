import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import {
  CostsPerDayChart,
  EstimateNotice,
  IncludedGauge,
} from "@/components/costs/cost-charts";
import { KpiGrid, KpiTile } from "@/components/insights/kpi-tile";
import { WorkflowLink } from "@/components/insights/workflow-link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { adjacentMonths, currentMonth } from "@/lib/costs-view";
import {
  formatMinutes,
  formatNumber,
  formatRatio,
  formatSignedPercent,
  formatUsd,
} from "@/lib/format";
import { param, withParams, type SearchParams } from "@/lib/insights-view";
import { getCosts, parseMonth } from "@/server/data/costs";
import { accountMeta } from "@/lib/page-meta";

export const generateMetadata = accountMeta("costs");

/**
 * Costs for all roles (design §6.6, §7 /costs): month picker, used vs
 * included with the projection, by SKU (multiplier shown), by repository,
 * by day, by workflow (estimated, scaled), estimate vs billed with ⚠ flags.
 * Without billed data: estimates only, with the reason; admins get a link
 * to /admin/github when a billing credential would help.
 */
export default async function CostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const now = new Date();
  const month = parseMonth(param(sp, "month"), now);
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
  const sourceBadge = (
    <Badge variant={billed ? "secondary" : "outline"}>
      {billed ? t("costs.kpi.billedFlag") : t("costs.kpi.estimateFlag")}
    </Badge>
  );
  const empty =
    costs.bySku.length === 0 && costs.totals.estMin === 0 && !billed;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {t("costs.title")}: {monthLabel} {sourceBadge}
        </h1>
        <nav aria-label={t("costs.monthNav")} className="flex gap-1 text-xs">
          <Link
            href={withParams(base, sp, { month: prev })}
            className="rounded-md border px-2.5 py-1 hover:bg-accent"
          >
            {t("costs.prev")}
          </Link>
          <Link
            href={withParams(base, sp, { month: undefined })}
            aria-current={costs.month === thisMonth ? "true" : undefined}
            className={
              costs.month === thisMonth
                ? "rounded-md border bg-primary px-2.5 py-1 text-primary-foreground"
                : "rounded-md border px-2.5 py-1 hover:bg-accent"
            }
          >
            {t("costs.current")}
          </Link>
          {costs.month < thisMonth ? (
            <Link
              href={withParams(base, sp, {
                month: next === thisMonth ? undefined : next,
              })}
              className="rounded-md border px-2.5 py-1 hover:bg-accent"
            >
              {t("costs.next")}
            </Link>
          ) : null}
        </nav>
      </div>

      <p className="text-xs text-muted-foreground">
        {billed ? t("billingStatus.billed") : t("billingStatus.estimated")}{" "}
        {costs.syncedAt
          ? t("costs.synced", {
              ago: format.relativeTime(new Date(costs.syncedAt), now),
            })
          : t("costs.neverSynced")}
      </p>

      <EstimateNotice costs={costs} accountType={installation.accountType} />

      {empty ? (
        <p className="text-muted-foreground">{t("costs.noData")}</p>
      ) : null}

      <KpiGrid>
        {billed ? (
          <>
            <KpiTile
              label={t("costs.kpi.net")}
              value={usd(costs.totals.netUsd)}
            />
            <KpiTile
              label={t("costs.kpi.gross")}
              value={usd(costs.totals.grossUsd)}
            />
            <KpiTile
              label={t("costs.kpi.discount")}
              value={usd(costs.totals.discountUsd)}
            />
            <KpiTile
              label={t("costs.kpi.projectedNet")}
              value={usd(costs.included.projectedNetUsd)}
            />
            <KpiTile
              label={t("costs.kpi.allProducts")}
              value={usd(costs.totals.netUsdAllProducts)}
            />
          </>
        ) : (
          <KpiTile
            label={t("costs.kpi.projectedEst")}
            value={usd(costs.included.projectedNetUsd)}
            hint={t("costs.kpi.estimateFlag")}
          />
        )}
        <KpiTile
          label={t("costs.kpi.estUsd")}
          value={usd(costs.totals.estUsd)}
          hint={t("costs.kpi.estimateFlag")}
        />
        <KpiTile
          label={t("costs.kpi.estMin")}
          value={min(costs.totals.estMin)}
          hint={t("costs.kpi.estimateFlag")}
        />
      </KpiGrid>

      {costs.unmatchedJobs > 0 ? (
        <p className="text-sm">
          {t("costs.unmatched", { count: costs.unmatchedJobs })}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <IncludedGauge costs={costs} />
        <CostsPerDayChart costs={costs} />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("costs.bySku.title")}</h2>
        <Table>
          <caption className="sr-only">{t("costs.bySku.title")}</caption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("costs.bySku.sku")}</TableHead>
              <TableHead className="text-right">
                {t("costs.bySku.multiplier")}
              </TableHead>
              {billed ? (
                <>
                  <TableHead className="text-right">
                    {t("costs.bySku.quantity")}
                  </TableHead>
                  <TableHead>{t("costs.bySku.unit")}</TableHead>
                  <TableHead className="text-right">
                    {t("costs.bySku.gross")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("costs.bySku.discount")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("costs.bySku.net")}
                  </TableHead>
                </>
              ) : null}
              <TableHead className="text-right">
                {t("costs.bySku.estMin")}
              </TableHead>
              <TableHead className="text-right">
                {t("costs.bySku.estUsd")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {costs.bySku.map((s) => (
              <TableRow key={s.skuKey}>
                <TableCell className="font-medium">{s.sku}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.minuteMultiplier == null
                    ? "—"
                    : `×${formatNumber(s.minuteMultiplier, locale)}`}
                </TableCell>
                {billed ? (
                  <>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(s.billedQuantity, locale)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {s.unitType ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(s.grossUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(s.discountUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(s.netUsd)}
                    </TableCell>
                  </>
                ) : null}
                <TableCell className="text-right tabular-nums">
                  {min(s.estMin)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd(s.estUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("costs.byRepo.title")}</h2>
        <Table>
          <caption className="sr-only">{t("costs.byRepo.title")}</caption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("costs.byRepo.repo")}</TableHead>
              {billed ? (
                <>
                  <TableHead className="text-right">
                    {t("costs.bySku.quantity")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("costs.bySku.gross")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("costs.bySku.net")}
                  </TableHead>
                </>
              ) : null}
              <TableHead className="text-right">
                {t("costs.bySku.estMin")}
              </TableHead>
              <TableHead className="text-right">
                {t("costs.bySku.estUsd")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {costs.byRepo.map((r) => (
              <TableRow key={r.repositoryFullName}>
                <TableCell className="font-medium">
                  {r.repositoryFullName || "—"}
                </TableCell>
                {billed ? (
                  <>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.billedQuantity, locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(r.grossUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(r.netUsd)}
                    </TableCell>
                  </>
                ) : null}
                <TableCell className="text-right tabular-nums">
                  {min(r.estMin)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd(r.estUsd)}
                </TableCell>
              </TableRow>
            ))}
            {costs.ignored ? (
              <TableRow className="text-muted-foreground italic">
                <TableCell>
                  {t("costs.byRepo.ignored", {
                    count: costs.ignored.repositories,
                  })}
                </TableCell>
                {billed ? (
                  <>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(costs.ignored.billedQuantity, locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(costs.ignored.grossUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(costs.ignored.netUsd)}
                    </TableCell>
                  </>
                ) : null}
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">—</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        {costs.ignored ? (
          <p className="text-xs text-muted-foreground">
            {t("costs.byRepo.ignoredInfo")}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("costs.byWorkflow.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {billed
            ? `${t("billingStatus.scaled")}: ${t("costs.byWorkflow.description")}`
            : t("billingStatus.estimated")}
        </p>
        {costs.byWorkflow.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("costs.byWorkflow.empty")}
          </p>
        ) : (
          <Table>
            <caption className="sr-only">{t("costs.byWorkflow.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("costs.byWorkflow.workflow")}</TableHead>
                <TableHead>{t("costs.bySku.sku")}</TableHead>
                <TableHead className="text-right">
                  {t("costs.bySku.estMin")}
                </TableHead>
                <TableHead className="text-right">
                  {t("costs.bySku.estUsd")}
                </TableHead>
                {billed ? (
                  <>
                    <TableHead className="text-right">
                      {t("costs.byWorkflow.scale")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("costs.byWorkflow.scaledMin")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("costs.byWorkflow.scaledNet")}
                    </TableHead>
                  </>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {costs.byWorkflow.map((w) => (
                <TableRow
                  key={`${w.repositoryFullName}|${w.sku}|${w.workflowId}`}
                >
                  <TableCell>
                    <WorkflowLink
                      accountLogin={login}
                      repoFullName={w.repositoryFullName}
                      workflowId={w.workflowId}
                      workflowName={w.workflowName}
                    />
                  </TableCell>
                  <TableCell className="text-xs">{w.sku}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {min(w.estMin)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {usd(w.estUsd)}
                  </TableCell>
                  {billed ? (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {w.scale == null
                          ? t("costs.notBilled")
                          : `×${formatRatio(w.scale, locale)}`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.scaledMin == null ? "—" : min(w.scaledMin)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.scaledNetUsd == null ? "—" : usd(w.scaledNetUsd)}
                      </TableCell>
                    </>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("costs.reconciliation.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("costs.reconciliation.description")} {t("billingStatus.deviation")}
        </p>
        {costs.reconciliation.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("costs.reconciliation.empty")}
          </p>
        ) : (
          <Table>
            <caption className="sr-only">
              {t("costs.reconciliation.title")}
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("costs.byRepo.repo")}</TableHead>
                <TableHead>{t("costs.bySku.sku")}</TableHead>
                <TableHead className="text-right">
                  {t("costs.reconciliation.estimate")}
                </TableHead>
                <TableHead className="text-right">
                  {t("costs.reconciliation.billed")}
                </TableHead>
                <TableHead className="text-right">
                  {t("costs.reconciliation.deviation")}
                </TableHead>
                <TableHead>{t("costs.reconciliation.flag")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {costs.reconciliation.map((r) => (
                <TableRow
                  key={`${r.repositoryFullName}|${r.sku}`}
                  className={r.flagged ? "bg-destructive/5" : undefined}
                >
                  <TableCell className="font-medium">
                    {r.repositoryFullName || "—"}
                  </TableCell>
                  <TableCell className="text-xs">{r.sku}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {usd(r.estUsd)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {usd(r.billedGrossUsd)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatSignedPercent(r.deviation, locale)}
                  </TableCell>
                  <TableCell>
                    {r.flagged ? (
                      <Badge variant="destructive">
                        {t("costs.reconciliation.flagged")}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t("costs.reconciliation.ok")}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
