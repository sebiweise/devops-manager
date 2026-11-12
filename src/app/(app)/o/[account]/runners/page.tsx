import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/insights/auto-refresh";
import { RangeFilter } from "@/components/insights/range-filter";
import {
  LabelList,
  RunnerStateBadge,
  UtilisationValue,
} from "@/components/runners/runner-badges";
import {
  ConcurrencyChart,
  PoolHeatmap,
  RunnerSplitChart,
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
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatRatio,
  formatSignedPercent,
} from "@/lib/format";
import { param, type SearchParams } from "@/lib/insights-view";
import { lazyRunnerSample } from "@/lib/runner-sample";
import {
  groupRunners,
  runnerCounts,
  runnerHref,
  runnerState,
} from "@/lib/runners-view";
import { parseRange } from "@/server/data/insights";
import {
  getConcurrencyTimeline,
  getHostedVsSelfHosted,
  listRunnerPools,
  listRunners,
} from "@/server/data/runners";

export const metadata = { title: "Runners" };

/**
 * Live runners (org and repo level) with 7-day utilisation, speed index and
 * infra failures; pools with concurrency, queue and a weekday × hour
 * heatmap; the hosted vs self-hosted split (design §7 /runners). Opening
 * the page schedules a lazy runner sample; it refreshes every 30 s.
 */
export default async function RunnersPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const range = parseRange(param(sp, "range") ?? "7d");
  const sampling = await lazyRunnerSample(installation.id);
  const [t, locale, format, list, pools, concurrency, compare] =
    await Promise.all([
      getTranslations(),
      getLocale(),
      getFormatter(),
      orNotFound(listRunners(scope, installation.id)),
      orNotFound(listRunnerPools(scope, installation.id, range)),
      orNotFound(getConcurrencyTimeline(scope, installation.id)),
      orNotFound(getHostedVsSelfHosted(scope, installation.id, { range })),
    ]);
  const base = accountPath(installation.accountLogin);
  const counts = runnerCounts(list.runners);
  const groups = groupRunners(list.runners);
  const ago = (iso: string | null) =>
    iso ? format.relativeTime(new Date(iso)) : t("freshness.never");
  const hostedPools = pools.pools.filter((p) => p.runnerKind !== "SELF_HOSTED");
  const heatPools = pools.pools.filter((p) => p.heatmap.length > 0).slice(0, 4);

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("runners.title")}</h1>
        <RangeFilter
          base={`${base}/runners`}
          current={range}
          searchParams={sp}
        />
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <p>
          {t("runners.summary", {
            total: counts.total,
            busy: counts.busy,
            idle: counts.idle,
            offline: counts.offline,
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("runners.sampled", {
            sampled: ago(list.sampledAt),
            discovered: ago(list.discoveredAt),
          })}
        </p>
        {sampling ? (
          <p className="text-xs text-muted-foreground">
            {t("runners.sampling")}
          </p>
        ) : null}
        {!list.repoRunnersGranted ? (
          <p className="text-xs text-muted-foreground">
            {t("runnerData.repoRunnersMissing")}
          </p>
        ) : null}
        {list.isOrganization && !list.orgRunnersGranted ? (
          <p className="text-xs text-muted-foreground">
            {t("runnerData.orgRunnersMissing")}
          </p>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("runners.noSelfHosted")}
        </p>
      ) : (
        groups.map((g) => {
          const title =
            g.repoFullName == null
              ? t("runners.orgRunners")
              : t("runners.repoRunners", { repo: g.repoFullName });
          return (
            <section
              key={g.repoFullName ?? "org"}
              className="flex flex-col gap-2"
            >
              <h2 className="font-medium">{title}</h2>
              <Table>
                <caption className="sr-only">{title}</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("runners.name")}</TableHead>
                    <TableHead>{t("runners.status")}</TableHead>
                    <TableHead>{t("runners.labels")}</TableHead>
                    <TableHead>{t("runners.os")}</TableHead>
                    <TableHead>{t("runners.group")}</TableHead>
                    <TableHead>{t("runners.lastSeen")}</TableHead>
                    <TableHead>{t("runners.utilisation")}</TableHead>
                    <TableHead className="text-right">
                      {t("runners.jobs")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("runnerData.speedIndex")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("runnerData.infraFailures")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.runners.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium">
                        <Link
                          href={runnerHref(base, r.key)}
                          className="underline-offset-2 hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.ephemeral ? (
                          <Badge variant="outline" className="ml-2">
                            {t("runnerData.ephemeral")}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <RunnerStateBadge state={runnerState(r)} />
                      </TableCell>
                      <TableCell className="max-w-64">
                        <LabelList labels={r.labels} />
                      </TableCell>
                      <TableCell className="text-xs">{r.os}</TableCell>
                      <TableCell className="text-xs">
                        {r.groupName ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        <time dateTime={r.lastSeenAt}>{ago(r.lastSeenAt)}</time>
                      </TableCell>
                      <TableCell className="text-sm">
                        <UtilisationValue u={r.utilisation7d} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.jobs7d, locale)}
                      </TableCell>
                      <TableCell
                        className="text-right tabular-nums"
                        title={t("runnerData.speedIndexHint")}
                      >
                        {formatRatio(r.speedIndex7d, locale)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.infraFailures7d, locale)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          );
        })
      )}
      {groups.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("runnerData.speedIndexHint")}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ConcurrencyChart data={concurrency} />
        <RunnerSplitChart split={pools.split} />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("runners.pools.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("runners.pools.description")}
        </p>
        {pools.pools.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("runners.pools.empty")}
          </p>
        ) : (
          <Table>
            <caption className="sr-only">{t("runners.pools.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("runners.pools.pool")}</TableHead>
                <TableHead>{t("runners.pools.kind")}</TableHead>
                <TableHead className="text-right">
                  {t("runners.split.jobs")}
                </TableHead>
                <TableHead className="text-right">
                  {t("runners.pools.minutes")}
                </TableHead>
                <TableHead className="text-right">
                  {t("runners.pools.avgConcurrency")}
                </TableHead>
                <TableHead className="text-right">
                  {t("runners.pools.peakConcurrency")}
                </TableHead>
                <TableHead className="text-right">
                  {t("runners.pools.queueP50")}
                </TableHead>
                <TableHead className="text-right">
                  {t("runners.pools.queueP95")}
                </TableHead>
                <TableHead>{t("runners.utilisation")}</TableHead>
                <TableHead className="text-right">
                  {t("runners.pools.runners")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pools.pools.map((p) => (
                <TableRow key={`${p.runnerKind}|${p.labelKey}`}>
                  <TableCell className="max-w-64">
                    <LabelList labels={p.labels} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {t(`runnerKind.${p.runnerKind}`)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(p.jobs, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMinutes(p.minutes, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.avgConcurrency.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(p.peakConcurrency, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(p.queueP50)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(p.queueP95)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.utilisation ? (
                      <UtilisationValue u={p.utilisation} />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.runnerKind === "SELF_HOSTED"
                      ? formatNumber(p.runners, locale)
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {hostedPools.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("runners.pools.highQueue")}
          </p>
        ) : null}
      </section>

      {heatPools.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {heatPools.map((p) => (
            <PoolHeatmap key={`${p.runnerKind}|${p.labelKey}`} pool={p} />
          ))}
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("runners.compare.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("runners.compare.description")}
        </p>
        {compare.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("runners.compare.empty")}
          </p>
        ) : (
          <Table>
            <caption className="sr-only">{t("runners.compare.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("workflows.workflow")}</TableHead>
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
              {compare.rows.map((c) => (
                <TableRow key={`${c.workflowId}|${c.baseName}`}>
                  <TableCell className="text-xs">
                    {c.workflowName || c.workflowId || "—"}
                  </TableCell>
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
                    {formatSignedPercent(c.deltaP50, locale)}
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
