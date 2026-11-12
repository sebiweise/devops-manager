import { getLocale, getTranslations } from "next-intl/server";
import {
  DurationChart,
  QueueChart,
  RunsPerDayChart,
} from "@/components/insights/day-charts";
import { KpiGrid, KpiTile } from "@/components/insights/kpi-tile";
import { WorkflowLink } from "@/components/insights/workflow-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadAccount, orNotFound } from "@/lib/account-page";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
  formatPointsDelta,
} from "@/lib/format";
import { enoughData, type SearchParams } from "@/lib/insights-view";
import {
  getInstallationOverview,
  listAlerts,
  listFlakyJobs,
} from "@/server/data/insights";
import { accountMeta } from "@/lib/page-meta";
import { pageRange } from "@/lib/page-range";

export const generateMetadata = accountMeta("overview");

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const range = await pageRange(sp);
  const [t, locale, overview, alerts, flaky] = await Promise.all([
    getTranslations(),
    getLocale(),
    orNotFound(getInstallationOverview(scope, installation.id, range)),
    orNotFound(listAlerts(scope, installation.id)),
    orNotFound(listFlakyJobs(scope, installation.id, range)),
  ]);
  const s = overview.summary;
  const login = installation.accountLogin;
  const enough = enoughData(s.n);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("overview.title")}</h1>
      </div>

      {s.runs === 0 ? (
        <p className="text-muted-foreground">{t("overview.noRuns")}</p>
      ) : null}

      <KpiGrid>
        <KpiTile
          label={t("kpi.runs", { range: t(`filters.ranges.${range}`) })}
          value={formatNumber(s.runs, locale)}
        />
        <KpiTile
          label={t("kpi.successRate")}
          value={formatPercent(s.successRate, locale)}
          hint={t("kpi.delta7d", {
            delta: formatPointsDelta(overview.successRateDelta, locale),
          })}
        />
        <KpiTile
          label={t("kpi.p50")}
          value={
            enough
              ? approx(formatDuration(s.p50), s.approx)
              : t("common.notEnoughData")
          }
          hint={t("kpi.samples", { n: s.n })}
        />
        <KpiTile
          label={t("kpi.p95")}
          value={
            enough
              ? approx(formatDuration(s.p95), s.approx)
              : t("common.notEnoughData")
          }
        />
        <KpiTile
          label={t("kpi.queueP95")}
          value={approx(formatDuration(s.queueP95), s.approx)}
        />
        <KpiTile
          label={t("kpi.minutes")}
          value={formatMinutes(overview.billableMinEst, locale)}
          hint={t("kpi.minutesHint")}
        />
      </KpiGrid>

      <div className="grid gap-4 lg:grid-cols-2">
        <RunsPerDayChart id="overview-runs" days={overview.perDay} />
        <DurationChart
          id="overview-duration"
          days={overview.perDay}
          approx={s.approx}
        />
        <QueueChart
          id="overview-queue"
          days={overview.perDay}
          approx={s.approx}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("overview.regressions")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {alerts.regressions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("overview.noRegressions")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {alerts.regressions.slice(0, 10).map((w) => (
                  <li key={w.workflowId}>
                    <WorkflowLink
                      accountLogin={login}
                      repoFullName={w.repoFullName}
                      workflowId={w.workflowId}
                      workflowName={w.workflowName}
                    />
                    <div className="text-xs text-muted-foreground">
                      {t("overview.regression", {
                        metric: w.regression!.metric,
                        recent: formatDuration(w.regression!.recent),
                        baseline: formatDuration(w.regression!.baseline),
                        ratio: w.regression!.ratio.toFixed(2),
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("overview.flakyJobs")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {flaky.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("overview.noFlaky")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {flaky.slice(0, 10).map((f) => (
                  <li key={`${f.workflowId}:${f.baseName}`}>
                    <span className="font-medium">{f.baseName}</span>
                    <div className="text-xs">
                      <WorkflowLink
                        accountLogin={login}
                        repoFullName={f.repoFullName}
                        workflowId={f.workflowId}
                        workflowName={f.workflowName}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("overview.flakyRuns", { count: f.runs })}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("overview.successDrops")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {alerts.successDrops.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("overview.noSuccessDrops")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {alerts.successDrops.slice(0, 10).map((w) => (
                  <li key={w.workflowId}>
                    <WorkflowLink
                      accountLogin={login}
                      repoFullName={w.repoFullName}
                      workflowId={w.workflowId}
                      workflowName={w.workflowName}
                    />
                    <div className="text-xs text-muted-foreground">
                      {t("overview.successDrop", {
                        recent: formatPercent(w.successDrop!.recent, locale),
                        baseline: formatPercent(
                          w.successDrop!.baseline,
                          locale,
                        ),
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
