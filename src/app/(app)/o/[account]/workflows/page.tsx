import { getLocale, getTranslations } from "next-intl/server";
import { RangeFilter } from "@/components/insights/range-filter";
import { WorkflowLink } from "@/components/insights/workflow-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatPercent,
} from "@/lib/format";
import { leaderboards, param, type SearchParams } from "@/lib/insights-view";
import { listWorkflowStats, parseRange } from "@/server/data/insights";
import type { WorkflowStat } from "@/server/data/insights";

export const metadata = { title: "Workflows" };

export default async function WorkflowsPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const range = parseRange(param(sp, "range") ?? "30d");
  const [t, locale, stats] = await Promise.all([
    getTranslations(),
    getLocale(),
    orNotFound(listWorkflowStats(scope, installation.id, { range })),
  ]);
  const boards = leaderboards(stats);
  const login = installation.accountLogin;

  const board = (
    key: keyof typeof boards,
    value: (w: WorkflowStat) => string,
  ) => (
    <Card key={key}>
      <CardHeader>
        <CardTitle>
          <h2>{t(`leaderboards.${key}`)}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {boards[key].length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("leaderboards.empty")}
          </p>
        ) : (
          <ol className="flex flex-col gap-2 text-sm">
            {boards[key].map((w, i) => (
              <li
                key={w.workflowId}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="mr-2 text-xs text-muted-foreground tabular-nums">
                    {i + 1}.
                  </span>
                  <WorkflowLink
                    accountLogin={login}
                    repoFullName={w.repoFullName}
                    workflowId={w.workflowId}
                    workflowName={w.workflowName}
                  />
                </span>
                <span className="shrink-0 tabular-nums">{value(w)}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("leaderboards.title")}</h1>
        <RangeFilter
          base={accountPath(login, "/workflows")}
          current={range}
          searchParams={sp}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {board("slowest", (w) =>
          approx(formatDuration(w.summary.p95), w.summary.approx),
        )}
        {board("flakiest", (w) => formatPercent(w.summary.flakyRate, locale))}
        {board("mostMinutes", (w) => formatMinutes(w.billableMinEst, locale))}
        {board("lowestSuccess", (w) =>
          formatPercent(w.summary.successRate, locale),
        )}
        {board("regressions", (w) =>
          t("leaderboards.ratio", {
            metric: w.regression!.metric,
            ratio: w.regression!.ratio.toFixed(2),
          }),
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("leaderboards.note")}</p>
    </div>
  );
}
