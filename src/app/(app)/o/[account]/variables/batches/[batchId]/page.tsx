import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ManagementBanner } from "@/components/management/management-banner";
import { RevertBatchForm } from "@/components/management/revert-batch";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { hasRole } from "@/server/authz/roles";
import { findBatch } from "@/server/data/audit";
import { getManagementState } from "@/server/data/management";

export const metadata = { title: "Revert batch" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revert batch (design §8.2 #7). Admin only: other roles, malformed ids and
 * batches of other installations get 404. The preview and the revert run
 * through the management pipeline in the browser (Server Actions).
 */
export default async function RevertBatchPage({
  params,
}: {
  params: Promise<{ account: string; batchId: string }>;
}) {
  const { account, batchId } = await params;
  if (!UUID.test(batchId)) notFound();
  const { scope, installation } = await loadAccount(account);
  if (!hasRole(scope.role, "ADMIN")) notFound();
  const [t, format, state, batch] = await Promise.all([
    getTranslations("management"),
    getFormatter(),
    orNotFound(getManagementState(scope, installation.id)),
    orNotFound(findBatch(scope, installation.id, batchId)),
  ]);
  // Only bulk sets can be reverted; the raw params stay on the server.
  if (batch.parent.action !== "VAR_BULK") notFound();
  const name =
    typeof batch.parent.params.name === "string"
      ? batch.parent.params.name
      : "—";
  const login = installation.accountLogin;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={accountPath(login, "/variables")} className="underline">
            {t("variables.title")}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">
          {t("revert.title", { name })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("revert.description", {
            when: format.dateTime(batch.parent.createdAt, {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      </div>
      <ManagementBanner
        state={state}
        settingsHref={accountPath(login, "/settings")}
      />
      {state.canAdmin ? (
        <RevertBatchForm
          installationId={String(installation.id)}
          batchId={batchId}
        />
      ) : null}
    </div>
  );
}
