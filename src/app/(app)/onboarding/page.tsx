import { ArrowRight, ExternalLink, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/data/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { env } from "@/env";
import { pageTitle } from "@/lib/page-meta";
import { activeInstallationIds } from "@/server/authz/scope";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import { listInstallations } from "@/server/data/installations";
import { getAccountSummaries } from "@/server/data/summaries";
import { installUrl } from "@/server/github/app";
import { verifyAndStoreInstallation } from "@/server/ingest/discovery";
import readonlyManifest from "../../../../github-app-manifest.readonly.json";
import { refreshInstallations } from "./actions";
import { compareCodeUnits } from "@/lib/compare";

export async function generateMetadata() {
  return pageTitle("onboarding");
}

const LEVEL = { read: 1, write: 2 } as const;

/** Read permissions the insights need that an installation lacks. */
function missingPermissions(
  granted: Record<string, string>,
  type: "USER" | "ORGANIZATION",
): string[] {
  const needed = readonlyManifest.default_permissions as Record<string, string>;
  return (
    Object.entries(needed)
      // "emails" is a permission of the signed-in user, not of an installation.
      .filter(([name]) => name !== "emails")
      .filter(
        ([name]) =>
          type === "ORGANIZATION" || !name.startsWith("organization_"),
      )
      .filter(
        ([name, level]) =>
          (LEVEL[granted[name] as keyof typeof LEVEL] ?? 0) <
          (LEVEL[level as keyof typeof LEVEL] ?? 1),
      )
      .map(([name]) => name)
      .sort(compareCodeUnits)
  );
}

/**
 * GitHub App installations (UI overhaul §2.14), admin only, and the App's
 * Setup URL. GitHub sends `?installation_id=…&setup_action=install` here
 * after an install; the id is never trusted: it is checked with
 * `GET /app/installations/{id}` (App JWT) and shown only when it belongs to
 * this App and to an allowed account. Each card names the account type and
 * repository selection, the history import progress, the granted
 * permissions (missing ones first) and links to the overview and to the
 * selection on GitHub.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ installation_id?: string; setup_action?: string }>;
}) {
  const { scope } = await requireScope();
  const t = await getTranslations("onboarding");
  const format = await getFormatter();

  if (!hasRole(scope.role, "ADMIN")) {
    return <EmptyState message={t("askAdmin")} />;
  }

  const { installation_id: rawId } = await searchParams;
  let verifiedAccount: string | null = null;
  if (rawId !== undefined) {
    if (!/^\d{1,19}$/.test(rawId)) notFound();
    verifiedAccount = await verifyAndStoreInstallation(BigInt(rawId));
    if (!verifiedAccount) notFound();
  }

  // Scope built after a possible verification, so a fresh install shows up.
  const fresh = { ...scope, installationIds: await activeInstallationIds() };
  const [installations, summaries] = await Promise.all([
    listInstallations(fresh),
    getAccountSummaries(fresh, new Date(), { backfillDays: env.BACKFILL_DAYS }),
  ]);
  const progressOf = new Map(
    summaries.map((s) => [s.installationId, s.importProgress]),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        subtitle={t("intro")}
        actions={
          <>
            <form action={refreshInstallations}>
              <Button type="submit" variant="outline" size="sm">
                {t("refresh")}
              </Button>
            </form>
            <Button asChild size="sm">
              <a href={installUrl()} rel="noopener noreferrer">
                {t("install")}
              </a>
            </Button>
          </>
        }
      />

      {verifiedAccount ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {t("verified", { account: verifiedAccount })}
        </p>
      ) : null}

      {installations.length === 0 ? (
        <EmptyState message={t("installHint")} />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {installations.map((inst) => {
          const granted = (inst.permissions ?? {}) as Record<string, string>;
          const missing = missingPermissions(granted, inst.accountType);
          const progress = progressOf.get(String(inst.id)) ?? null;
          const pct = Math.round(Math.min(1, progress ?? 0) * 100);
          const selectionUrl =
            inst.accountType === "ORGANIZATION"
              ? `https://github.com/organizations/${encodeURIComponent(inst.accountLogin)}/settings/installations/${inst.id}`
              : `https://github.com/settings/installations/${inst.id}`;
          return (
            <article
              key={String(inst.id)}
              className="flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground"
            >
              <header className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{inst.accountLogin}</h2>
                <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                  {t(`type.${inst.accountType}`)}
                </span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">
                  {t(`selection.${inst.repositorySelection}`)}
                </span>
                {inst.suspendedAt ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-status-warning/60 bg-status-warning/10 px-2 py-0.5 text-xs">
                    <TriangleAlert
                      aria-hidden="true"
                      className="size-3 text-status-warning"
                    />
                    {t("suspended")}
                  </span>
                ) : null}
              </header>

              <div className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-sm">
                  <span>{t("import")}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {progress == null
                      ? "—"
                      : format.number(pct / 100, { style: "percent" })}
                  </span>
                </span>
                <span
                  role="meter"
                  aria-label={t("importOf", { account: inst.accountLogin })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  className="block h-1.5 overflow-hidden rounded-full bg-seq-1/40"
                >
                  <span
                    className="block h-full rounded-full bg-seq-3"
                    style={{ width: `${pct}%` }}
                  />
                </span>
              </div>

              {missing.length > 0 ? (
                <div className="flex flex-col gap-1 rounded-lg border border-status-warning/60 bg-status-warning/10 p-3 text-sm">
                  <p className="flex items-center gap-1.5 font-medium">
                    <TriangleAlert
                      aria-hidden="true"
                      className="size-4 text-status-warning"
                    />
                    {t("missing", { count: missing.length })}
                  </p>
                  <p className="font-mono text-xs">{missing.join(", ")}</p>
                </div>
              ) : null}

              <details>
                <summary className="w-fit cursor-pointer text-sm select-none">
                  {t("grantedCount", { count: Object.keys(granted).length })}
                </summary>
                <ul className="mt-2 flex flex-wrap gap-1">
                  {Object.entries(granted)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, level]) => (
                      <li
                        key={name}
                        className="rounded-full border px-2 py-0.5 font-mono text-[11px]"
                      >
                        {name}: {level}
                      </li>
                    ))}
                </ul>
              </details>

              <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
                <a
                  href={selectionUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                  {t("changeSelection")}
                </a>
                <Link
                  href={`/o/${encodeURIComponent(inst.accountLogin)}`}
                  className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
                >
                  {t("openOverview")}
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
