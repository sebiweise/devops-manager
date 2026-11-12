import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { ManagementBanner } from "@/components/management/management-banner";
import { VariablesSection } from "@/components/management/sections";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { hasRole } from "@/server/authz/roles";
import { listVariableBatches } from "@/server/data/audit";
import { getManagementState } from "@/server/data/management";
import { accountMeta } from "@/lib/page-meta";

export const generateMetadata = accountMeta("variables");

/**
 * Repository and organisation variables (design §7 /variables): every role
 * reads the matrix (values masked for viewers and operators when redaction
 * is on); admins edit, use the bulk presets and revert batches.
 */
export default async function VariablesPage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);
  const [t, format, state, batches] = await Promise.all([
    getTranslations("management"),
    getFormatter(),
    orNotFound(getManagementState(scope, installation.id)),
    orNotFound(listVariableBatches(scope, installation.id)),
  ]);
  const login = installation.accountLogin;
  const isAdmin = hasRole(scope.role, "ADMIN");
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("variables.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("variables.description")}
        </p>
      </div>
      {isAdmin ? (
        <ManagementBanner
          state={state}
          settingsHref={accountPath(login, "/settings")}
        />
      ) : null}
      <VariablesSection
        scope={scope}
        installationId={installation.id}
        accountLogin={login}
        state={state}
      />
      <section className="flex flex-col gap-3" aria-labelledby="batches">
        <h2 id="batches" className="font-medium">
          {t("batches.title")}
        </h2>
        {batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("batches.empty")}</p>
        ) : (
          <Table>
            <caption className="sr-only">{t("batches.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("batches.when")}</TableHead>
                <TableHead scope="col">{t("batches.who")}</TableHead>
                <TableHead scope="col">{t("batches.kind")}</TableHead>
                <TableHead scope="col">{t("variables.name")}</TableHead>
                <TableHead scope="col">{t("batches.outcome")}</TableHead>
                <TableHead scope="col">{t("batches.links")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((b) => (
                <TableRow key={b.auditId}>
                  <TableCell className="text-xs whitespace-nowrap">
                    <time dateTime={b.createdAt}>
                      {format.dateTime(new Date(b.createdAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                  </TableCell>
                  <TableCell className="text-xs">{b.actorDisplay}</TableCell>
                  <TableCell className="text-xs">
                    {t(`batches.kindOf.${b.action}`)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {b.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {t("bulk.summary", {
                      succeeded: b.succeeded,
                      failed: b.failed,
                    })}
                    {b.revertedBy ? (
                      <span className="block text-muted-foreground">
                        {t("batches.reverted")}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex flex-col gap-1">
                      <Link
                        className="underline"
                        href={`${accountPath(login, "/audit")}?batch=${encodeURIComponent(b.batchId)}`}
                      >
                        {t("batches.entries")}
                      </Link>
                      {state.canAdmin &&
                      b.action === "VAR_BULK" &&
                      !b.revertedBy ? (
                        <Link
                          className="font-medium underline"
                          href={accountPath(
                            login,
                            `/variables/batches/${encodeURIComponent(b.batchId)}`,
                          )}
                        >
                          {t("batches.revert")}
                        </Link>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
