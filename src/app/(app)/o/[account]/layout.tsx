import { after } from "next/server";
import { getTranslations } from "next-intl/server";
import { AccountNav } from "@/components/insights/account-nav";
import { FreshnessBanner } from "@/components/insights/freshness-banner";
import { Badge } from "@/components/ui/badge";
import { accountPath, loadAccount } from "@/lib/account-page";
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
 * last reconciled more than LAZY_RECONCILE_MINUTES ago, and shows the
 * section navigation and the freshness banner. The claim is atomic, so
 * concurrent page views start exactly one reconcile.
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

  const [t, freshness] = await Promise.all([
    getTranslations(),
    getFreshness(scope, installation.id),
  ]);
  const base = accountPath(installation.accountLogin);
  const isAdmin = hasRole(scope.role, "ADMIN");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-lg font-semibold">{installation.accountLogin}</p>
          <Badge variant="outline">
            {installation.accountType === "ORGANIZATION"
              ? t("common.organization")
              : t("common.personalAccount")}
          </Badge>
        </div>
        <AccountNav
          label={t("accountNav.label")}
          items={[
            { href: base, label: t("accountNav.overview"), exact: true },
            { href: `${base}/repos`, label: t("accountNav.repos") },
            { href: `${base}/workflows`, label: t("accountNav.workflows") },
            { href: `${base}/runners`, label: t("accountNav.runners") },
            { href: `${base}/queue`, label: t("accountNav.queue") },
            { href: `${base}/costs`, label: t("accountNav.costs") },
            ...(isAdmin
              ? [{ href: `${base}/settings`, label: t("accountNav.settings") }]
              : []),
          ]}
        />
        <FreshnessBanner
          freshness={freshness}
          installationId={String(installation.id)}
          refreshing={refreshing}
          canSync={hasRole(scope.role, "OPERATOR")}
        />
      </div>
      {children}
    </div>
  );
}
