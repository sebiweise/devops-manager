import { getTranslations } from "next-intl/server";
import { DependabotSection } from "@/components/management/sections";
import { loadAccount, orNotFound } from "@/lib/account-page";
import { getManagementState } from "@/server/data/management";
import { accountMeta } from "@/lib/page-meta";

export const generateMetadata = accountMeta("dependabot");

/** Open Dependabot alerts by severity × repo; read-only (design §7). */
export default async function DependabotPage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);
  const [t, state] = await Promise.all([
    getTranslations("management.dependabot"),
    orNotFound(getManagementState(scope, installation.id)),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <DependabotSection
        scope={scope}
        installationId={installation.id}
        accountLogin={installation.accountLogin}
        state={state}
      />
    </div>
  );
}
