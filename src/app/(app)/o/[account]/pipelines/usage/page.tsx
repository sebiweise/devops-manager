import { CircleAlert, Clock, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import {
  MinutesGauge,
  MinutesPerDayChart,
  ParallelChart,
  PoolsSection,
  azureHrefs,
} from "@/components/azure/azure-views";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import { AutoRefresh } from "@/components/insights/auto-refresh";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { loadAccount, orNotFound } from "@/lib/account-page";
import { formatNumber, formatPercent } from "@/lib/format";
import { accountMeta } from "@/lib/page-meta";
import { hasRole } from "@/server/authz/roles";
import { getAzureSummary, getAzureUsage } from "@/server/data/azure";
import { maybeAzureUsageRefresh } from "@/server/ingest/triggers";

export const generateMetadata = accountMeta("pipelineUsage");

/**
 * Azure Pipelines usage (design addendum M7 §5.2): hosted minutes of the
 * billing month against the free tier (1,800 min), labelled API or
 * estimate (both shown when they differ by more than 5 %), the projection
 * and the day the limit is reached, the OS split per day, the parallel
 * jobs in use with the 24 h occupancy, saturation over 7 days, jobs near
 * the job time limit, the (assumed) reset, public project minutes apart,
 * the paid tier, the agent pools and the limits detected from Azure DevOps.
 * Opening the page reads resourceusage at most every 10 minutes.
 */
export default async function AzureUsagePage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);
  const summary = await orNotFound(getAzureSummary(scope, installation.id));
  if (!summary) notFound();
  try {
    await maybeAzureUsageRefresh(installation.id, (task) => after(task));
  } catch {
    // Best effort: the page renders from stored data.
  }
  const now = new Date();
  const [t, locale, format, usage] = await Promise.all([
    getTranslations("ci.azure.usage"),
    getLocale(),
    getFormatter(),
    orNotFound(getAzureUsage(scope, installation.id, now)),
  ]);
  if (!usage) notFound();
  const login = installation.accountLogin;
  const h = azureHrefs(login);
  const isAdmin = hasRole(scope.role, "ADMIN");
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  const total =
    usage.osSplit.macos + usage.osSplit.linux + usage.osSplit.windows;
  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh intervalMs={60_000} />
      <Breadcrumbs
        items={[
          { kind: "accounts" },
          { kind: "account", login },
          { kind: "section", login, section: "pipelines" },
          { kind: "pipelineSection", login, section: "usage" },
        ]}
      />
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", {
          org: usage.orgName,
          from: day(usage.month.startDay),
          reset: day(usage.month.endDay),
        })}
      />
      {usage.partial ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-status-warning/60 bg-status-warning/10 p-2 text-sm"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-status-warning"
          />
          {t("partial")}
        </p>
      ) : null}
      <section
        aria-labelledby="minutes"
        className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
      >
        <h2 id="minutes" className="font-medium">
          {usage.paid
            ? t("paidTitle", { parallel: usage.parallel.limit })
            : t("minutesTitle", {
                used: formatNumber(usage.used, locale),
                included: formatNumber(usage.included ?? 0, locale),
              })}
        </h2>
        <MinutesGauge usage={usage} />
        <p className="text-sm text-muted-foreground">
          {usage.paid
            ? t("paidText", { cap: usage.maxJobMinutes })
            : usage.limitDay
              ? t("projectionLimit", {
                  projected: formatNumber(usage.projected, locale),
                  day: day(usage.limitDay),
                })
              : t("projection", {
                  projected: formatNumber(usage.projected, locale),
                })}
        </p>
        {usage.differs ? (
          <p className="flex items-start gap-2 text-sm">
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-status-warning"
            />
            {t("differs", {
              api: formatNumber(usage.api ?? 0, locale),
              estimate: formatNumber(usage.estimate, locale),
            })}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("resetsIn", { days: usage.month.daysLeft })} {t("estimateNote")}
        </p>
      </section>
      <KpiStrip label={t("kpiLabel")}>
        <KpiTile
          label={t("macos")}
          value={formatNumber(usage.osSplit.macos, locale)}
          hint={t("share", {
            share: formatPercent(
              total > 0 ? usage.osSplit.macos / total : null,
              locale,
            ),
          })}
        />
        <KpiTile
          label={t("linux")}
          value={formatNumber(usage.osSplit.linux, locale)}
        />
        <KpiTile
          label={t("windows")}
          value={formatNumber(usage.osSplit.windows, locale)}
        />
        <KpiTile
          label={t("parallelNow")}
          info={t("parallelInfo")}
          value={`${usage.parallel.running}/${usage.parallel.limit}`}
          hint={
            usage.parallel.queued > 0
              ? t("queuedNow", { count: usage.parallel.queued })
              : t("noneQueued")
          }
        />
        <KpiTile
          label={t("saturation")}
          info={t("saturationInfo")}
          value={formatPercent(usage.saturation.share7d, locale)}
          hint={t("saturationQueue", {
            minutes: usage.saturation.queueMinutesWeek,
          })}
        />
        <KpiTile
          label={t("public")}
          info={t("publicInfo")}
          value={formatNumber(usage.publicMinutes, locale)}
        />
      </KpiStrip>
      <div className="grid gap-4 lg:grid-cols-2">
        <MinutesPerDayChart id="azure-minutes" days={usage.perDay} />
        <ParallelChart
          samples={usage.parallel.samples}
          limit={usage.parallel.limit}
        />
      </div>
      <section
        aria-labelledby="near-cap"
        className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground"
      >
        <h2 id="near-cap" className="flex items-center gap-2 font-medium">
          <Clock aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("nearCapTitle", { cap: usage.maxJobMinutes })}
        </h2>
        {usage.nearCap.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nearCapNone")}</p>
        ) : (
          <ul className="flex flex-col">
            {usage.nearCap.map((n) => (
              <li
                key={`${n.projectId}:${n.definitionId}`}
                className="flex flex-wrap items-center gap-2 border-t py-1.5 text-sm first:border-t-0"
              >
                <Link
                  href={`${h.runs}?definition=${n.projectId}:${n.definitionId}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {n.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {t("p90", { minutes: n.p90Minutes })}
                </span>
                {n.hits > 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs">
                    <CircleAlert
                      aria-hidden="true"
                      className="size-3 text-status-critical"
                    />
                    {t("hits", { count: n.hits })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <PoolsSection pools={usage.pools} />
      <section
        aria-labelledby="detected"
        className="flex flex-col gap-1 rounded-lg border p-3 text-sm"
      >
        <h2 id="detected" className="font-medium">
          {t("detectedTitle")}
        </h2>
        {usage.detected ? (
          <p className="text-muted-foreground">
            {t("detected", {
              minutes:
                usage.detected.totalMinutes == null
                  ? "—"
                  : formatNumber(usage.detected.totalMinutes, locale),
              parallel: usage.detected.totalCount ?? "—",
              premium:
                usage.detected.isPremium == null
                  ? "—"
                  : usage.detected.isPremium
                    ? t("yes")
                    : t("no"),
            })}
          </p>
        ) : (
          <p className="text-muted-foreground">{t("detectedNone")}</p>
        )}
        {isAdmin ? (
          <Link
            href={`/o/${encodeURIComponent(login)}/settings#azure`}
            className="w-fit text-xs underline-offset-2 hover:underline"
          >
            {t("toSettings")}
          </Link>
        ) : null}
      </section>
    </div>
  );
}
