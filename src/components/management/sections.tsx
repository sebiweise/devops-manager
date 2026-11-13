import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { accountPath, orUnavailable } from "@/lib/account-page";
import type { TenantScope } from "@/server/authz/scope";
import { listDependabotAlerts } from "@/server/data/dependabot";
import type { ManagementState } from "@/server/data/management";
import { listOpenPulls, type PullRow } from "@/server/data/pulls";
import { listVariableMatrix } from "@/server/data/variables";
import { DependabotBulkMerge } from "./dependabot-bulk-merge";
import { AlertsTable, SeverityMatrix } from "./dependabot-table";
import { OrgVariablesTable } from "./org-variables";
import { PullsTable } from "./pulls-table";
import { deploymentsForShas } from "@/server/data/vercel";
import {
  NewVariableButton,
  RepoVariablesList,
  VariablesMatrix,
} from "./variable-editors";

/**
 * The live sections shared by the installation pages (/pulls, /variables,
 * /dependabot) and the repository tabs: read with installation tokens
 * narrowed per purpose, filtered to one repo for the tabs, with an
 * explainer for a permission the App was not granted (design §7 "each tab
 * explains a missing permission"). Edit controls exist only for the roles
 * that may use them while management is on.
 */

type SectionProps = {
  scope: TenantScope;
  installationId: bigint;
  accountLogin: string;
  state: ManagementState;
  /** Restricts the section to one repository (repository tabs). */
  repositoryId?: string;
};

export async function PermissionNote({ missing }: { missing: string[] }) {
  const t = await getTranslations("management");
  return (
    <p className="rounded-lg border p-3 text-sm text-muted-foreground">
      {t("missingPermission", { permissions: missing.join(", ") })}
    </p>
  );
}

async function Unavailable() {
  const t = await getTranslations("management");
  return (
    <p className="rounded-lg border p-3 text-sm text-muted-foreground">
      {t("liveUnavailable")}
    </p>
  );
}

export async function PullsSection({
  scope,
  installationId,
  state,
  repositoryId,
}: SectionProps) {
  const t = await getTranslations("management.pulls");
  const overview = await orUnavailable(listOpenPulls(scope, installationId));
  if (!overview) return <Unavailable />;
  if (overview.status === "no_permission")
    return <PermissionNote missing={overview.missing} />;
  const pulls = repositoryId
    ? overview.pulls.filter((p) => p.repositoryId === repositoryId)
    : overview.pulls;
  const repos = repositoryId
    ? overview.repos.filter((r) => r.repositoryId === repositoryId)
    : overview.repos;
  const unavailable = repos.filter((r) => r.status === "unavailable");
  const previews = Object.fromEntries(
    await deploymentsForShas(
      scope,
      installationId,
      pulls.map((p) => p.headSha),
    ).catch(() => new Map()),
  );
  const mergeMethods = Object.fromEntries(
    repos.map((r) => [r.repositoryId, r.mergeMethods]),
  );
  return (
    <div className="flex flex-col gap-3">
      {state.canAdmin ? (
        <div className="flex justify-end">
          <DependabotBulkMerge
            installationId={String(installationId)}
            pulls={pulls}
            mergeMethods={mergeMethods}
            workflowsGranted={overview.workflowsGranted}
          />
        </div>
      ) : null}
      {!overview.workflowsGranted &&
      pulls.some((p) => p.changesWorkflows !== false) ? (
        <p className="text-sm text-muted-foreground">
          {t("workflowsNotGranted")}
        </p>
      ) : null}
      <PullsTable
        installationId={String(installationId)}
        pulls={pulls}
        mergeMethods={mergeMethods}
        workflowsGranted={overview.workflowsGranted}
        canMerge={state.canAdmin}
        mergeAuditTrailer={state.mergeAuditTrailer}
        showRepo={!repositoryId}
        caption={t("title")}
        previews={previews}
      />
      {unavailable.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("reposUnavailable", {
            repos: unavailable.map((r) => r.fullName).join(", "),
          })}
        </p>
      ) : null}
      {overview.truncated || repos.some((r) => r.truncated) ? (
        <p className="text-xs text-muted-foreground">{t("truncated")}</p>
      ) : null}
    </div>
  );
}

export async function DependabotSection({
  scope,
  installationId,
  repositoryId,
}: SectionProps) {
  const t = await getTranslations("management.dependabot");
  const [overview, pulls] = await Promise.all([
    orUnavailable(listDependabotAlerts(scope, installationId)),
    orUnavailable(listOpenPulls(scope, installationId)),
  ]);
  if (!overview) return <Unavailable />;
  if (overview.status === "no_permission")
    return <PermissionNote missing={overview.missing} />;
  const openPulls: PullRow[] = pulls?.status === "ok" ? pulls.pulls : [];
  const alerts = repositoryId
    ? overview.alerts.filter((a) => a.repositoryId === repositoryId)
    : overview.alerts;
  const repos = repositoryId
    ? overview.repos.filter((r) => r.repositoryId === repositoryId)
    : overview.repos;
  const repoStatus = repositoryId ? repos[0]?.status : "ok";
  if (repoStatus === "disabled" || repoStatus === "unavailable")
    return (
      <p className="text-sm text-muted-foreground">
        {t(`repoStatus.${repoStatus}`)}
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      {!repositoryId ? (
        <SeverityMatrix
          repos={repos}
          totals={overview.totals}
          caption={t("byRepo")}
        />
      ) : null}
      <AlertsTable
        alerts={alerts}
        pulls={openPulls}
        showRepo={!repositoryId}
        caption={t("title")}
      />
      {overview.truncated ? (
        <p className="text-xs text-muted-foreground">{t("truncated")}</p>
      ) : null}
    </div>
  );
}

export async function VariablesSection({
  scope,
  installationId,
  accountLogin,
  state,
  repositoryId,
}: SectionProps) {
  const t = await getTranslations("management");
  const matrix = await orUnavailable(listVariableMatrix(scope, installationId));
  if (!matrix) return <Unavailable />;
  if (matrix.status === "no_permission")
    return <PermissionNote missing={matrix.missing} />;
  const id = String(installationId);
  const canEdit = state.canAdmin;

  if (repositoryId) {
    const repo = matrix.repos.find((r) => r.repositoryId === repositoryId);
    if (!repo) return <Unavailable />;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          {t("variablesNotSecrets")}
          {matrix.masked ? ` ${t("variables.maskedNote")}` : ""}
        </p>
        <RepoVariablesList
          installationId={id}
          repo={repo}
          canEdit={canEdit}
          caption={t("variables.title")}
        />
      </div>
    );
  }

  const choices = matrix.repos
    .filter((r) => !r.archived && r.status === "ok")
    .map((r) => ({ repositoryId: r.repositoryId, fullName: r.fullName }));
  const presetNames = matrix.presets
    .filter((p) => p.scope === "repository")
    .map((p) => p.name);
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="repo-vars">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="repo-vars" className="font-medium">
            {t("variables.repoTitle")}
          </h2>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <NewVariableButton installationId={id} repos={choices} />
              <Link
                href={accountPath(accountLogin, "/variables/bulk")}
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
              >
                {t("variables.bulkLink")}
              </Link>
            </div>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("variablesNotSecrets")}
          {matrix.masked ? ` ${t("variables.maskedNote")}` : ""}
        </p>
        {matrix.names.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("variables.noneYet", {
              presets: presetNames.join(", ") || "LINUX_RUNNER",
            })}
          </p>
        ) : (
          <VariablesMatrix
            installationId={id}
            names={matrix.names}
            repos={matrix.repos}
            canEdit={canEdit}
            caption={t("variables.repoTitle")}
          />
        )}
        {matrix.truncated ? (
          <p className="text-xs text-muted-foreground">
            {t("variables.truncated")}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("variables.runsOnHint")}{" "}
          <code className="font-mono">
            {"runs-on: ${{ vars.LINUX_RUNNER || 'ubuntu-latest' }}"}
          </code>
        </p>
      </section>

      {matrix.org ? (
        <section className="flex flex-col gap-3" aria-labelledby="org-vars">
          <h2 id="org-vars" className="font-medium">
            {t("variables.orgTitle")}
          </h2>
          {matrix.org.status === "ok" ? (
            <OrgVariablesTable
              installationId={id}
              variables={matrix.org.variables}
              repos={choices}
              canEdit={canEdit}
              caption={t("variables.orgTitle")}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(`variables.org_${matrix.org.status}`)}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
