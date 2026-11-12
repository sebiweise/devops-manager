import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { KpiGrid, KpiTile } from "@/components/insights/kpi-tile";
import { StatusBadge } from "@/components/insights/status-badge";
import {
  LabelList,
  RunnerStateBadge,
  UtilisationValue,
} from "@/components/runners/runner-badges";
import {
  DurationVsPoolChart,
  RunnerStatusChart,
  RunnerUtilisationChart,
} from "@/components/runners/runner-charts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { env } from "@/env";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatRatio,
} from "@/lib/format";
import { type SearchParams } from "@/lib/insights-view";
import { parseRunnerKey, runnerState } from "@/lib/runners-view";
import { rangeStart } from "@/server/data/insights";
import { getRunnerDetail } from "@/server/data/runners";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";

export const generateMetadata = accountMeta("runner");

/**
 * One self-hosted runner (design §7 /runners/[runnerKey]): utilisation with
 * the sample interval, daily utilisation, status timeline, duration
 * distribution vs the pool, top jobs and failures. A runner of another
 * installation answers 404.
 */
export default async function RunnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; runnerKey: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account, runnerKey } = await params;
  const sp = await searchParams;
  const key = parseRunnerKey(runnerKey);
  if (!key) notFound();
  const { scope, installation } = await loadAccount(account);
  const range = await pageRange(sp);
  const now = new Date();
  const [t, locale, format, detail] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(getRunnerDetail(scope, installation.id, key, range, now)),
  ]);
  const r = detail.runner;
  const base = accountPath(installation.accountLogin);
  const u = detail.utilisation;
  const ago = (iso: string | null) =>
    iso ? format.relativeTime(new Date(iso), now) : t("freshness.never");
  const rangeLabel = t(`filters.ranges.${range}`);
  // The status timeline covers the samples of the range, at most 30 days.
  const statusFrom = new Date(
    Math.max(rangeStart(range, now).getTime(), now.getTime() - 30 * 86_400_000),
  ).toISOString();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            <Link href={`${base}/runners`} className="underline">
              {t("runner.back")}
            </Link>
          </p>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
            {r.name}
            <RunnerStateBadge state={runnerState(r)} />
            {r.ephemeral ? (
              <Badge variant="outline">{t("runnerData.ephemeral")}</Badge>
            ) : null}
          </h1>
          <p className="text-sm text-muted-foreground">
            {r.scope === "ORG"
              ? t("runner.scopeOrg")
              : t("runner.scopeRepo", {
                  repo: r.repository?.fullName || "—",
                })}
            {" · "}
            {r.os}
            {r.groupName ? ` · ${r.groupName}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("runner.seen", {
              first: ago(r.firstSeenAt),
              last: ago(r.lastSeenAt),
            })}
          </p>
          <LabelList labels={r.labels} />
        </div>
      </div>

      <KpiGrid>
        <div className="flex flex-col gap-1 rounded-xl border bg-card p-4 text-card-foreground">
          <dt className="text-xs text-muted-foreground">
            {t("runner.utilisation", { range: rangeLabel })}
          </dt>
          <dd className="text-2xl font-semibold">
            <UtilisationValue u={u} />
          </dd>
        </div>
        <KpiTile
          label={t("runner.coverage")}
          value={formatPercent(u.coverage, locale, 0)}
          hint={t("runner.coverageHint")}
        />
        <KpiTile
          label={t("runners.jobs")}
          value={formatNumber(r.jobs7d, locale)}
        />
        <KpiTile
          label={t("runner.failures")}
          value={formatNumber(r.failures7d, locale)}
        />
        <KpiTile
          label={t("runnerData.infraFailures")}
          value={formatNumber(r.infraFailures7d, locale)}
        />
        <KpiTile
          label={t("runnerData.speedIndex")}
          value={formatRatio(r.speedIndex7d, locale)}
          hint={t("runnerData.speedIndexHint")}
        />
      </KpiGrid>

      {u.insufficientSamples ? (
        <p className="rounded-xl border border-dashed p-3 text-sm">
          {t("runner.insufficientExplain", {
            coverage: formatPercent(u.coverage, locale, 0),
            interval: formatDuration(env.CRON_INTERVAL_SECONDS),
          })}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <RunnerUtilisationChart days={detail.perDay} />
        <DurationVsPoolChart distribution={detail.distribution} />
      </div>
      <RunnerStatusChart
        name={r.name}
        samples={detail.statusTimeline}
        from={statusFrom}
        to={now.toISOString()}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">{t("runner.topJobs.title")}</h2>
          {detail.topJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("runner.topJobs.empty")}
            </p>
          ) : (
            <Table>
              <caption className="sr-only">{t("runner.topJobs.title")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("runner.topJobs.job")}</TableHead>
                  <TableHead className="text-right">
                    {t("runner.topJobs.jobs")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("charts.p50")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("runner.topJobs.failures")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.topJobs.map((j) => (
                  <TableRow key={`${j.workflowId}|${j.baseName}`}>
                    <TableCell>
                      <div className="font-medium">{j.baseName}</div>
                      <div className="text-xs text-muted-foreground">
                        {j.workflowName}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(j.jobs, locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(j.p50)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(j.failures, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">{t("runner.recentFailures.title")}</h2>
          {detail.recentFailures.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("runner.recentFailures.empty")}
            </p>
          ) : (
            <Table>
              <caption className="sr-only">
                {t("runner.recentFailures.title")}
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("runner.topJobs.job")}</TableHead>
                  <TableHead>{t("runner.recentFailures.conclusion")}</TableHead>
                  <TableHead>{t("runner.recentFailures.completed")}</TableHead>
                  <TableHead className="text-right">
                    {t("runner.recentFailures.duration")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.recentFailures.map((f) => (
                  <TableRow key={f.jobId}>
                    <TableCell>
                      <div className="font-medium">{f.baseName}</div>
                      <div className="text-xs text-muted-foreground">
                        {f.workflowName}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        <StatusBadge
                          status="COMPLETED"
                          conclusion={f.conclusion}
                        />
                        {f.infra ? (
                          <Badge variant="outline">
                            {t("runner.recentFailures.infra")}
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {f.completedAt ? (
                        <time dateTime={f.completedAt}>
                          {ago(f.completedAt)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(f.durationS)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </div>
  );
}
