import { Settings } from "lucide-react";
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
import { maybeLazyReconcile } from "@/server/ingest/triggers";

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
  } catch (error) {
    // Freshness is best effort; the page renders from stored data.
    console.error(
      "lazy reconcile not scheduled",
      error instanceof Error ? error.message : "unknown",
    );
  }

  const now = new Date();
  const [t, freshness, range] = await Promise.all([
    getTranslations(),
    getFreshness(scope, installation.id, now),
    cookieRange(),
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
