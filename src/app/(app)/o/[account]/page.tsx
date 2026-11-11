import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { RepoTable } from "@/components/repo-table";
import { SyncNowButton } from "@/components/sync-now-button";
import { Badge } from "@/components/ui/badge";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import { findInstallationByAccount } from "@/server/data/installations";
import { liveRepositories } from "@/server/data/live-repositories";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope } = await requireScope();
  // Unknown or invisible accounts answer 404 (not 403), so slugs cannot be enumerated.
  const installation = await findInstallationByAccount(
    scope,
    decodeURIComponent(account),
  );
  if (!installation) notFound();

  const t = await getTranslations();
  const format = await getFormatter();
  const { repos, source } = await liveRepositories(scope, installation);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold">{installation.accountLogin}</h1>
        <Badge variant="outline">
          {installation.accountType === "ORGANIZATION"
            ? t("common.organization")
            : t("common.personalAccount")}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <span>
          {installation.lastReconciledAt
            ? t("account.lastReconciled", {
                time: format.relativeTime(installation.lastReconciledAt),
              })
            : t("account.neverReconciled")}
        </span>
        {hasRole(scope.role, "OPERATOR") ? (
          <SyncNowButton installationId={String(installation.id)} />
        ) : null}
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">
          {t("account.repos")}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {source === "live"
              ? t("dashboard.liveSource")
              : t("dashboard.storedSource")}
          </span>
        </h2>
        {repos.length > 0 ? (
          <RepoTable repos={repos} />
        ) : (
          <p className="text-muted-foreground">{t("account.noRepos")}</p>
        )}
      </section>
    </div>
  );
}
