import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/data/empty-state";
import { workflowHref } from "@/components/insights/workflow-link";
import { AccountCard } from "@/components/shell/account-card";
import { PageHeader } from "@/components/shell/page-header";
import { env } from "@/env";
import { formatDuration, formatNumber } from "@/lib/format";
import { pageTitle } from "@/lib/page-meta";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import {
  getAccountSummaries,
  getCrossAccountHighlights,
  type HighlightWorkflow,
} from "@/server/data/summaries";

export async function generateMetadata() {
  return pageTitle("dashboard");
}

/**
 * The start page (UI overhaul §2.1): one card per account or organisation
 * that leads into its overview, then the most failing and slowest workflows
 * across all accounts. Rollups and counts only; no live GitHub read.
 */
export default async function DashboardPage() {
  const { scope } = await requireScope();
  const now = new Date();
  const [t, locale, summaries, highlights] = await Promise.all([
    getTranslations(),
    getLocale(),
    getAccountSummaries(scope, now, { backfillDays: env.BACKFILL_DAYS }),
    getCrossAccountHighlights(scope, now),
  ]);
  const isAdmin = hasRole(scope.role, "ADMIN");

  const list = (
    title: string,
    rows: HighlightWorkflow[],
    value: (w: HighlightWorkflow) => string,
    valueLabel: string,
  ) => (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("dashboard.across.empty")}
        </p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 text-left font-normal">
                {t("dashboard.across.workflow")}
              </th>
              <th scope="col" className="py-1 text-left font-normal">
                {t("dashboard.across.account")}
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                {valueLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr
                key={`${w.accountLogin}:${w.workflowId}`}
                className="border-t"
              >
                <td className="py-1.5 pr-2">
                  <Link
                    href={workflowHref(
                      w.accountLogin,
                      w.repoFullName,
                      w.workflowId,
                    )}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {w.workflowName}
                  </Link>
                  <span className="text-muted-foreground">
                    {" · "}
                    {w.repoFullName.split("/").pop()}
                  </span>
                </td>
                <td className="py-1.5 pr-2 text-muted-foreground">
                  {w.accountLogin}
                </td>
                <td className="py-1.5 text-right tabular-nums">{value(w)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );

  const across = (
    <div className="grid gap-6 md:grid-cols-2">
      {list(
        t("dashboard.across.failing"),
        highlights.failing,
        (w) => formatNumber(w.failures, locale),
        t("dashboard.across.failures"),
      )}
      {list(
        t("dashboard.across.slowest"),
        highlights.slowest,
        (w) => `~${formatDuration(w.p95)}`,
        t("dashboard.across.p95"),
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.intro")}
      />

      {summaries.length === 0 ? (
        <EmptyState
          message={
            isAdmin ? t("dashboard.emptyAdmin") : t("dashboard.emptyViewer")
          }
          action={
            isAdmin ? (
              <Link className="text-sm underline" href="/onboarding">
                {t("nav.onboarding")}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div
          className={
            summaries.length > 2
              ? "grid gap-4 md:grid-cols-2 xl:grid-cols-3"
              : "grid gap-4 md:grid-cols-2"
          }
        >
          {summaries.map((s) => (
            <AccountCard
              key={s.installationId}
              summary={s}
              now={now}
              settingsHref={
                isAdmin
                  ? `/o/${encodeURIComponent(s.accountLogin)}/settings`
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {summaries.length > 1 ? (
        <section
          aria-labelledby="across"
          className="flex flex-col gap-4 rounded-xl border p-5"
        >
          <h2 id="across" className="font-semibold">
            {t("dashboard.across.title")}
          </h2>
          {across}
        </section>
      ) : summaries.length === 1 ? (
        <details className="rounded-xl border p-5">
          <summary className="cursor-pointer font-semibold select-none">
            {t("dashboard.across.summary")}
          </summary>
          <div className="mt-4">{across}</div>
        </details>
      ) : null}
    </div>
  );
}
