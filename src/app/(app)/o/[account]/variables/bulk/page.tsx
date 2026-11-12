import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BulkVariableForm } from "@/components/management/bulk-variable-form";
import { ManagementBanner } from "@/components/management/management-banner";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { hasRole } from "@/server/authz/roles";
import {
  getManagementState,
  listRepoTargets,
  variablePresets,
} from "@/server/data/management";
import { accountMeta } from "@/lib/page-meta";

export const generateMetadata = accountMeta("variablesBulk");

/**
 * Bulk set with the runs-on presets (design §8.2 #6). Admin only: other
 * roles get 404.
 */
export default async function BulkVariablePage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);
  if (!hasRole(scope.role, "ADMIN")) notFound();
  const [t, state, repos] = await Promise.all([
    getTranslations("management"),
    orNotFound(getManagementState(scope, installation.id)),
    orNotFound(listRepoTargets(scope, installation.id)),
  ]);
  const login = installation.accountLogin;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={accountPath(login, "/variables")} className="underline">
            {t("variables.title")}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">{t("bulk.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("bulk.description")}</p>
        <p className="text-xs text-muted-foreground">
          {t("variablesNotSecrets")}
        </p>
      </div>
      <ManagementBanner
        state={state}
        settingsHref={accountPath(login, "/settings")}
      />
      {state.canAdmin ? (
        <BulkVariableForm
          installationId={String(installation.id)}
          presets={variablePresets()}
          repos={repos.map((r) => ({
            repositoryId: String(r.id),
            fullName: r.fullName,
            archived: r.archived,
          }))}
        />
      ) : null}
    </div>
  );
}
