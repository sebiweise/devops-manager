import { getTranslations } from "next-intl/server";
import { ManagementBanner } from "@/components/management/management-banner";
import { PullsSection } from "@/components/management/sections";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { hasRole } from "@/server/authz/roles";
import { getManagementState } from "@/server/data/management";

export const metadata = { title: "Pull requests" };

/** Open PRs across the installation's repos; merge for admins (design §7). */
export default async function PullsPage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);
  const [t, state] = await Promise.all([
    getTranslations("management"),
    orNotFound(getManagementState(scope, installation.id)),
  ]);
  const login = installation.accountLogin;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{t("pulls.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("pulls.description")}
        </p>
      </div>
      {hasRole(scope.role, "ADMIN") ? (
        <ManagementBanner
          state={state}
          settingsHref={accountPath(login, "/settings")}
        />
      ) : null}
      <PullsSection
        scope={scope}
        installationId={installation.id}
        accountLogin={login}
        state={state}
      />
    </div>
  );
}
