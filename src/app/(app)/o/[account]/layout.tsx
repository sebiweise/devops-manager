import { History, KeyRound, PauseCircle, Settings } from "lucide-react";
import Link from "next/link";
import { after } from "next/server";
import { getTranslations } from "next-intl/server";
import { AccountNav } from "@/components/insights/account-nav";
import { FreshnessBanner } from "@/components/insights/freshness-banner";
import { FreshnessChip } from "@/components/shell/freshness-chip";
import { RangeControl } from "@/components/shell/range-control";
import { accountPath, loadAccount } from "@/lib/account-page";
import { staleReasons } from "@/lib/insights-view";
import { cookieRange } from "@/lib/page-range";
import { hasRole } from "@/server/authz/roles";
import { getFreshness } from "@/server/data/insights";
import { getVercelSummary } from "@/server/data/vercel";
import { getAzureSummary } from "@/server/data/azure";
import {
  maybeLazyAzureRefresh,
  maybeLazyReconcile,
  maybeLazyVercelRefresh,
} from "@/server/ingest/triggers";

// The lazy reconcile and "Sync now" run in `after()` of these requests and are
// bounded by the function's deadline (minus a 30 s margin). Without this, the
// platform default leaves no time and every pass stops at "deadline" before
// its first GitHub request.
export const maxDuration = 300;

/**
 * Every `/o/[account]/*` page: resolves the installation (404 when it is not
 * visible), starts a lazy reconcile in `after()` when the installation was
 * last reconciled more than LAZY_RECONCILE_MINUTES ago, and renders the
 * account header (UI overhaul §1.2): the account name with its type, the
 * freshness chip, the shared range control, "Settings & sync" (admin) and
 * the grouped section navigation. The full freshness banner shows only
 * while there are stale reasons. The claim is atomic, so concurrent page
 * views start exactly one reconcile.
 */
export default async function AccountLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);

  let refreshing = false;
  try {
    refreshing = await maybeLazyReconcile(installation.id, (task) =>
      after(task),
    );
    // The GitHub pass includes step v; otherwise Vercel data older than
    // 5 minutes gets its own fast path (v2 to v5, 20 s).
    // Only one stale provider per page view: Vercel first, else Azure DevOps.
    if (
      !refreshing &&
      !(await maybeLazyVercelRefresh(installation.id, (task) => after(task)))
    )
      await maybeLazyAzureRefresh(installation.id, (task) => after(task));
  } catch (error) {
    // Freshness is best effort; the page renders from stored data.
    console.error(
      "lazy reconcile not scheduled",
      error instanceof Error ? error.message : "unknown",
    );
  }

  const now = new Date();
  const [t, freshness, range, vercel, azure] = await Promise.all([
    getTranslations(),
    getFreshness(scope, installation.id, now),
    cookieRange(),
    getVercelSummary(scope, installation.id),
    getAzureSummary(scope, installation.id, now),
  ]);
  const base = accountPath(installation.accountLogin);
  const isAdmin = hasRole(scope.role, "ADMIN");
  const stale = staleReasons(freshness, now).length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            href={base}
            className="text-lg font-semibold underline-offset-4 hover:underline"
          >
            {installation.accountLogin}
          </Link>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {installation.accountType === "ORGANIZATION"
              ? t("common.organization")
              : t("common.personalAccount")}
          </span>
          <FreshnessChip
            lastWebhookAt={freshness.lastWebhookAt}
            lastReconciledAt={freshness.lastReconciledAt}
            stale={stale}
            installationId={String(installation.id)}
            canSync={hasRole(scope.role, "OPERATOR")}
            settingsHref={isAdmin ? `${base}/settings` : undefined}
            now={now.toISOString()}
            refreshing={refreshing}
          />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <RangeControl accountBase={base} cookieRange={range} />
            {isAdmin ? (
              <Link
                href={`${base}/settings`}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-accent"
              >
                <Settings aria-hidden="true" className="size-3.5" />
                <span className="sr-only sm:not-sr-only">
                  {t("accountNav.settings")}
                </span>
              </Link>
            ) : null}
          </div>
        </div>
        <AccountNav
          label={t("accountNav.label")}
          groups={[
            {
              label: t("accountNav.groups.insights"),
              items: [
                { href: base, label: t("accountNav.overview"), exact: true },
                {
                  href: `${base}/repos`,
                  label: t("accountNav.repos"),
                  activePrefixes: [`${base}/runs`],
                },
                { href: `${base}/workflows`, label: t("accountNav.workflows") },
                { href: `${base}/runners`, label: t("accountNav.runners") },
                { href: `${base}/queue`, label: t("accountNav.queue") },
                { href: `${base}/costs`, label: t("accountNav.costs") },
              ],
            },
            ...(vercel
              ? [
                  {
                    label: t("accountNav.groups.hosting"),
                    items: [
                      {
                        href: `${base}/deployments`,
                        label: t("accountNav.deployments"),
                      },
                      {
                        href: `${base}/projects`,
                        label: t("accountNav.projects"),
                      },
                    ],
                  },
                ]
              : []),
            ...(azure
              ? [
                  {
                    label: t("ci.azure.nav.group"),
                    items: [
                      {
                        href: `${base}/pipelines`,
                        label: t("ci.azure.nav.pipelines"),
                        exact: true,
                      },
                      {
                        href: `${base}/pipelines/runs`,
                        label: t("ci.azure.nav.runs"),
                      },
                      {
                        href: `${base}/pipelines/usage`,
                        label: t("ci.azure.nav.usage"),
                      },
                    ],
                  },
                ]
              : []),
            {
              label: t("accountNav.groups.manage"),
              items: [
                { href: `${base}/pulls`, label: t("accountNav.pulls") },
                {
                  href: `${base}/dependabot`,
                  label: t("accountNav.dependabot"),
                },
                { href: `${base}/variables`, label: t("accountNav.variables") },
              ],
            },
            {
              label: t("accountNav.groups.audit"),
              items: [{ href: `${base}/audit`, label: t("accountNav.audit") }],
            },
          ]}
        />
        {vercel?.revoked ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md border border-status-critical/50 bg-status-critical/10 p-2 text-sm"
          >
            <KeyRound
              aria-hidden="true"
              className="size-4 text-status-critical"
            />
            {t("hosting.revokedBanner", { team: vercel.teamSlug })}
            {isAdmin ? (
              <Link
                href={`${base}/settings#hosting`}
                className="font-medium underline underline-offset-2"
              >
                {t("hosting.reconnect")}
              </Link>
            ) : null}
          </p>
        ) : vercel?.tokenExpiresAt &&
          Date.parse(vercel.tokenExpiresAt) - now.getTime() <
            14 * 86_400_000 ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md border border-status-warning/60 bg-status-warning/10 p-2 text-sm"
          >
            <KeyRound
              aria-hidden="true"
              className="size-4 text-status-warning"
            />
            {t("hosting.expiringBanner", {
              team: vercel.teamSlug,
              date: new Date(vercel.tokenExpiresAt).toISOString().slice(0, 10),
            })}
            {isAdmin ? (
              <Link
                href={`${base}/settings#hosting`}
                className="font-medium underline underline-offset-2"
              >
                {t("hosting.rotateNow")}
              </Link>
            ) : null}
          </p>
        ) : null}
        {azure?.revoked ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md border border-status-critical/50 bg-status-critical/10 p-2 text-sm"
          >
            <KeyRound
              aria-hidden="true"
              className="size-4 text-status-critical"
            />
            {t("ci.azure.banner.revoked", { org: azure.orgName })}
            {isAdmin ? (
              <Link
                href={`${base}/settings#azure`}
                className="font-medium underline underline-offset-2"
              >
                {t("ci.azure.banner.reconnect")}
              </Link>
            ) : null}
          </p>
        ) : azure?.tokenExpiresAt &&
          Date.parse(azure.tokenExpiresAt) - now.getTime() < 14 * 86_400_000 ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md border border-status-warning/60 bg-status-warning/10 p-2 text-sm"
          >
            <KeyRound
              aria-hidden="true"
              className="size-4 text-status-warning"
            />
            {t("ci.azure.banner.expiring", {
              org: azure.orgName,
              date: new Date(azure.tokenExpiresAt).toISOString().slice(0, 10),
            })}
            {azure.authKind === "PAT"
              ? ` ${t("ci.azure.banner.inactivity")}`
              : ""}
            {isAdmin ? (
              <Link
                href={`${base}/settings#azure`}
                className="font-medium underline underline-offset-2"
              >
                {t("ci.azure.banner.rotate")}
              </Link>
            ) : null}
          </p>
        ) : null}
        {azure?.pausedUntil ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md border border-status-warning/60 bg-status-warning/10 p-2 text-sm"
          >
            <PauseCircle
              aria-hidden="true"
              className="size-4 text-status-warning"
            />
            {t("ci.azure.banner.paused", {
              when: new Date(azure.pausedUntil).toISOString().slice(11, 16),
            })}
          </p>
        ) : null}
        {azure && azure.backfilling > 0 && azure.backfillDaysLeft ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            <History aria-hidden="true" className="size-4" />
            {t("ci.azure.banner.backfilling", {
              days: azure.backfillDaysLeft,
            })}
          </p>
        ) : null}
        {stale ? (
          <FreshnessBanner
            freshness={freshness}
            installationId={String(installation.id)}
            canSync={hasRole(scope.role, "OPERATOR")}
            now={now}
          />
        ) : null}
      </div>
      {children}
    </div>
  );
}
