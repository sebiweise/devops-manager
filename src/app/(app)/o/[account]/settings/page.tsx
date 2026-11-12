import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { SyncNowButton } from "@/components/sync-now-button";
import { KpiGrid, KpiTile } from "@/components/insights/kpi-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { env } from "@/env";
import { loadAccount, orNotFound } from "@/lib/account-page";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { hasRole } from "@/server/authz/roles";
import { getSyncHealth } from "@/server/data/insights";

export const metadata = { title: "Installation settings" };

const DELIVERY_STATUSES = [
  "PROCESSED",
  "RECEIVED",
  "PROCESSING",
  "FAILED",
  "DEAD",
  "SKIPPED",
  "REJECTED",
] as const;

/** Admin only (other roles get 404): sync health of one installation. */
export default async function InstallationSettingsPage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);
  if (!hasRole(scope.role, "ADMIN")) notFound();
  const [t, format, locale, health] = await Promise.all([
    getTranslations(),
    getFormatter(),
    getLocale(),
    orNotFound(getSyncHealth(scope, installation.id, env.BACKFILL_DAYS)),
  ]);
  const when = (iso: string | null) =>
    iso ? (
      <time dateTime={iso}>{format.relativeTime(new Date(iso))}</time>
    ) : (
      t("freshness.never")
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("syncHealth.title")}</h1>
        <SyncNowButton installationId={String(installation.id)} />
      </div>

      <KpiGrid>
        <KpiTile
          label={t("syncHealth.lastWebhook")}
          value={
            health.lastWebhookAt
              ? format.relativeTime(new Date(health.lastWebhookAt))
              : t("freshness.never")
          }
        />
        <KpiTile
          label={t("syncHealth.lastReconcile")}
          value={
            health.lastReconciledAt
              ? format.relativeTime(new Date(health.lastReconciledAt))
              : t("freshness.never")
          }
        />
        <KpiTile
          label={t("syncHealth.lastReconcileStatus")}
          value={health.lastReconcileStatus ?? "—"}
          hint={health.lastReconcileReason ?? undefined}
        />
        <KpiTile
          label={t("syncHealth.lagP50")}
          value={formatDuration(health.ingestionLag.p50)}
        />
        <KpiTile
          label={t("syncHealth.lagP95")}
          value={formatDuration(health.ingestionLag.p95)}
        />
        <KpiTile
          label={t("syncHealth.dirty")}
          value={formatNumber(health.dirtyPartitions, locale)}
          hint={t("syncHealth.dirtyHint")}
        />
        <KpiTile
          label={t("syncHealth.backfillDays")}
          value={formatNumber(env.BACKFILL_DAYS, locale)}
        />
      </KpiGrid>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("syncHealth.repos")}</h2>
        {health.repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("account.noRepos")}
          </p>
        ) : (
          <Table>
            <caption className="sr-only">{t("syncHealth.repos")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("repos.repo")}</TableHead>
                <TableHead>{t("syncHealth.cursor")}</TableHead>
                <TableHead>{t("syncHealth.backfill")}</TableHead>
                <TableHead>{t("syncHealth.state")}</TableHead>
                <TableHead>{t("syncHealth.lastError")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.repos.map((r) => (
                <TableRow key={r.repositoryId}>
                  <TableCell className="font-medium">{r.fullName}</TableCell>
                  <TableCell className="text-xs">
                    {when(r.runsCursor)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <progress
                        className="h-2 w-24"
                        max={1}
                        value={r.backfillProgress}
                        aria-label={t("syncHealth.backfillOf", {
                          repo: r.fullName,
                        })}
                      />
                      <span className="text-xs tabular-nums">
                        {r.backfillDone
                          ? t("syncHealth.done")
                          : formatPercent(r.backfillProgress, locale, 0)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.needsResync
                      ? t("syncHealth.needsResync")
                      : t("syncHealth.ok")}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                    <span title={r.lastError ?? undefined}>
                      {r.lastError ?? "—"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">{t("syncHealth.deliveries")}</h2>
          <Table>
            <caption className="sr-only">{t("syncHealth.deliveries")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("syncHealth.status")}</TableHead>
                <TableHead className="text-right">
                  {t("syncHealth.count")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {DELIVERY_STATUSES.map((s) => (
                <TableRow key={s}>
                  <TableCell>{t(`syncHealth.deliveryStatus.${s}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(health.deliveries24h[s] ?? 0, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">{t("syncHealth.rateLimits")}</h2>
          {health.rateLimits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("syncHealth.noRateLimits")}
            </p>
          ) : (
            <Table>
              <caption className="sr-only">
                {t("syncHealth.rateLimits")}
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("syncHealth.resource")}</TableHead>
                  <TableHead className="text-right">
                    {t("syncHealth.remaining")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("syncHealth.reset")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.rateLimits.map((l) => (
                  <TableRow key={l.resource}>
                    <TableCell>{l.resource}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(l.remaining, locale)} /{" "}
                      {formatNumber(l.limit, locale)}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {when(l.resetAt)}
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
