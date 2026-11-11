import { after } from "next/server";
import { notFound } from "next/navigation";
import { requireScope } from "@/server/better-auth/session";
import { findInstallationByAccount } from "@/server/data/installations";
import { maybeLazyReconcile } from "@/server/ingest/triggers";

/**
 * Every `/o/[account]/*` page: resolves the installation (404 when it is not
 * visible) and starts a lazy reconcile in `after()` when the installation was
 * last reconciled more than LAZY_RECONCILE_MINUTES ago. The claim is atomic,
 * so concurrent page views start exactly one reconcile.
 */
export default async function AccountLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope } = await requireScope();
  const installation = await findInstallationByAccount(
    scope,
    decodeURIComponent(account),
  );
  if (!installation) notFound();

  try {
    await maybeLazyReconcile(installation.id, (task) => after(task));
  } catch (error) {
    // Freshness is best effort; the page renders from stored data.
    console.error(
      "lazy reconcile not scheduled",
      error instanceof Error ? error.message : "unknown",
    );
  }
  return children;
}
