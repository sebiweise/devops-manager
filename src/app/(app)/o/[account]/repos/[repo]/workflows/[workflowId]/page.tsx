import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  DurationChart,
  MinutesChart,
  QueueChart,
  SuccessRateChart,
} from "@/components/insights/day-charts";
import { KpiGrid, KpiTile } from "@/components/insights/kpi-tile";
import { RunsTable } from "@/components/insights/runs-table";
import { repoHref } from "@/components/insights/workflow-link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { loadAccount, orNotFound } from "@/lib/account-page";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import {
  enoughData,
  hostedVsSelfHosted,
  MIN_SAMPLES,
  type SearchParams,
} from "@/lib/insights-view";
import {
  findRepositoryByName,
  getWorkflowDetail,
  listRuns,
} from "@/server/data/insights";
import { getManagementState } from "@/server/data/management";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";

export const generateMetadata = accountMeta("workflow");

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; repo: string; workflowId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account, repo: repoParam, workflowId } = await params;
  const sp = await searchParams;
  if (!/^\d{1,20}$/.test(workflowId)) notFound();
  const { scope, installation } = await loadAccount(account);
  const repo = await findRepositoryByName(
    scope,
    installation.id,
    decodeURIComponent(repoParam),
  );
  if (!repo || repo.ignored) notFound();
  const range = await pageRange(sp);
  const id = BigInt(workflowId);
  const detail = await orNotFound(
    getWorkflowDetail(scope, installation.id, id, range),
  );
  // The workflow must belong to the repository of the URL.
  if (detail.repositoryId !== repo.id) notFound();

  const [t, locale, state, recent] = await Promise.all([
    getTranslations(),
    getLocale(),
    orNotFound(getManagementState(scope, installation.id)),
    orNotFound(
      listRuns(scope, installation.id, {
        repositoryId: BigInt(repo.id),
        workflowId: id,
        limit: 20,
      }),
    ),
  ]);
  const login = installation.accountLogin;
  const s = detail.summary;
  const enough = enoughData(s.n);
  const percentile = (v: number | null, n = s.n) =>
    enoughData(n)
      ? approx(formatDuration(v), detail.approx)
      : t("common.notEnoughData");
  const compare = hostedVsSelfHosted(detail.jobs);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href={repoHref(login, repo.fullName)} className="underline">
              {repo.fullName}
            </Link>
          </p>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
            {detail.workflowName || detail.workflowId}
            {detail.regression ? (
              <Badge variant="destructive">
                {t("workflows.regressionBadge", {
                  metric: detail.regression.metric,
                })}
              </Badge>
            ) : null}
            {detail.successDrop ? (
              <Badge variant="outline">{t("workflows.successDropBadge")}</Badge>
            ) : null}
          </h1>
        </div>
      </div>

      {!enough ? (
        <p className="text-sm text-muted-foreground">
          {t("workflow.notEnough", { n: s.n, min: MIN_SAMPLES })}
        </p>
      ) : null}

      <KpiGrid>
        <KpiTile
          label={t("workflows.runs")}
          value={formatNumber(s.runs, locale)}
        />
        <KpiTile
          label={t("kpi.successRate")}
          value={formatPercent(s.successRate, locale)}
          hint={t("workflow.firstTry", {
            rate: formatPercent(s.firstTrySuccessRate, locale),
          })}
        />
        <KpiTile
          label={t("kpi.p50")}
          value={percentile(s.p50)}
          hint={t("kpi.samples", { n: s.n })}
        />
        <KpiTile label={t("kpi.p95")} value={percentile(s.p95)} />
        <KpiTile
          label={t("workflow.flakyRate")}
          value={formatPercent(s.flakyRate, locale)}
          hint={t("workflow.flakyRuns", { count: s.flakyRecovered })}
        />
        <KpiTile
          label={t("kpi.minutes")}
          value={formatMinutes(
            detail.perDay.reduce((sum, d) => sum + d.billableMinEst, 0),
            locale,
          )}
          hint={t("kpi.minutesHint")}
        />
      </KpiGrid>

      {detail.regression ? (
        <p className="text-sm">
          {t("overview.regression", {
            metric: detail.regression.metric,
            recent: formatDuration(detail.regression.recent),
            baseline: formatDuration(detail.regression.baseline),
            ratio: detail.regression.ratio.toFixed(2),
          })}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <DurationChart
          id="wf-duration"
          days={detail.perDay}
          approx={detail.approx}
        />
        <QueueChart id="wf-queue" days={detail.perDay} approx={detail.approx} />
        <SuccessRateChart id="wf-success" days={detail.perDay} />
        <MinutesChart id="wf-minutes" days={detail.perDay} />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("workflow.jobs")}</h2>
        {detail.jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("workflow.noJobs")}
          </p>
        ) : (
          <Table>
            <caption className="sr-only">{t("workflow.jobs")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("workflow.job")}</TableHead>
                <TableHead>{t("workflow.pool")}</TableHead>
                <TableHead className="text-right">
                  {t("workflow.count")}
                </TableHead>
                <TableHead className="text-right">{t("charts.p50")}</TableHead>
                <TableHead className="text-right">{t("charts.p95")}</TableHead>
                <TableHead className="text-right">
                  {t("charts.queueP95")}
                </TableHead>
                <TableHead className="text-right">
                  {t("workflow.failureRate")}
                </TableHead>
                <TableHead className="text-right">
                  {t("workflow.flaky")}
                </TableHead>
                <TableHead className="text-right">
                  {t("charts.minutes")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.jobs.map((j) => (
                <TableRow key={`${j.baseName}|${j.labelKey}|${j.runnerKind}`}>
                  <TableCell className="font-medium">{j.baseName}</TableCell>
                  <TableCell className="text-xs">
                    <div>{j.labelKey || "—"}</div>
                    <div className="text-muted-foreground">
                      {t(`runnerKind.${j.runnerKind}`)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(j.jobs, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percentile(j.p50, j.jobs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percentile(j.p95, j.jobs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percentile(j.queueP95, j.jobs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(j.failureRate, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(j.flakyRuns, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMinutes(j.billableMinEst, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("workflow.compare")}</h2>
        {compare.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("workflow.compareEmpty")}
          </p>
        ) : (
          <Table>
            <caption className="sr-only">{t("workflow.compare")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("workflow.job")}</TableHead>
                <TableHead className="text-right">
                  {t("workflow.hostedP50")}
                </TableHead>
                <TableHead className="text-right">
                  {t("workflow.selfHostedP50")}
                </TableHead>
                <TableHead className="text-right">
                  {t("workflow.hostedP95")}
                </TableHead>
                <TableHead className="text-right">
                  {t("workflow.selfHostedP95")}
                </TableHead>
                <TableHead className="text-right">
                  {t("workflow.queueCompare")}
                </TableHead>
                <TableHead className="text-right">
                  {t("workflow.delta")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {compare.map((c) => (
                <TableRow key={c.baseName}>
                  <TableCell className="font-medium">{c.baseName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(c.hosted.p50)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(c.selfHosted.p50)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(c.hosted.p95)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(c.selfHosted.p95)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(c.hosted.queueP95)} /{" "}
                    {formatDuration(c.selfHosted.queueP95)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.deltaP50 == null
                      ? "—"
                      : formatPercent(c.deltaP50, locale, 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("workflow.recentRuns")}</h2>
        <RunsTable
          accountLogin={login}
          runs={recent.runs}
          caption={t("workflow.recentRuns")}
          showWorkflow={false}
          actions={
            state.canOperate
              ? { installationId: String(installation.id) }
              : undefined
          }
        />
      </section>
    </div>
  );
}
