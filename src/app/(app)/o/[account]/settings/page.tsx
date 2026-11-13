import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import { StatusBadge } from "@/components/data/status-badge";
import { repoHref } from "@/components/insights/workflow-link";
import { ManagementBanner } from "@/components/management/management-banner";
import { ManagementSettings } from "@/components/management/management-settings";
import { RepoIgnoreButton } from "@/components/management/repo-ignore";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { SyncNowButton } from "@/components/sync-now-button";
import { env } from "@/env";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { accountMeta } from "@/lib/page-meta";
import { hasRole } from "@/server/authz/roles";
import { getSyncHealth, type SyncHealth } from "@/server/data/insights";
import { getManagementState } from "@/server/data/management";
import { getVercelSettings } from "@/server/data/vercel";
import { VercelSection } from "@/components/hosting/vercel-section";
import { AzureSection } from "@/components/azure/azure-section";
import { getAzureSettings } from "@/server/data/azure";
import { hookUrlPrefix } from "@/server/ingest/azure-reconcile";
import {
  listIgnoredRepositories,
  type IgnoredRepository,
} from "@/server/data/repos";

export const generateMetadata = accountMeta("settings");

const DELIVERY_STATUSES = [
  "PROCESSED",
  "RECEIVED",
  "PROCESSING",
  "FAILED",
  "DEAD",
  "SKIPPED",
  "REJECTED",
] as const;

const SECTIONS = [
  "management",
  "hosting",
  "azure",
  "repositories",
  "sync",
  "diagnostics",
] as const;

/**
 * "Settings & sync" of one account (UI overhaul §2.13), admin only (other
 * roles get 404): an in-page navigation over Management (the toggle and
 * variable redaction), Repositories (the ignored ones with un-ignore),
 * Data sync (freshness, Sync now, the history import per repository,
 * errors first and collapsed while everything is fine) and Diagnostics
 * (webhook deliveries, rate limits, delays, summaries waiting).
 */
export default async function InstallationSettingsPage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);
  if (!hasRole(scope.role, "ADMIN")) notFound();
  const [t, format, locale, health, state, ignored, vercel, azure] =
    await Promise.all([
      getTranslations(),
      getFormatter(),
      getLocale(),
      orNotFound(getSyncHealth(scope, installation.id, env.BACKFILL_DAYS)),
      orNotFound(getManagementState(scope, installation.id)),
      orNotFound(listIgnoredRepositories(scope, installation.id)),
      orNotFound(getVercelSettings(scope, installation.id)),
      orNotFound(getAzureSettings(scope, installation.id, hookUrlPrefix())),
    ]);
  const login = installation.accountLogin;
  const installationId = String(installation.id);
  const when = (iso: string | null) =>
    iso ? (
      <time
        dateTime={iso}
        title={format.dateTime(new Date(iso), {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      >
        {format.relativeTime(new Date(iso))}
      </time>
    ) : (
      t("freshness.never")
    );
  const progress =
    health.repos.length > 0
      ? health.repos.reduce((s, r) => s + r.backfillProgress, 0) /
        health.repos.length
      : null;
  const problems = health.repos.filter((r) => r.lastError || r.needsResync);
  const sorted = [
    ...problems,
    ...health.repos.filter((r) => !problems.includes(r)),
  ];

  type RepoSync = SyncHealth["repos"][number];
  const syncColumns: Column<RepoSync>[] = [
    {
      id: "repo",
      label: t("repos.repo"),
      header: t("repos.repo"),
      cell: (r) => (
        <Link
          href={repoHref(login, r.fullName)}
          className="font-medium underline-offset-2 hover:underline"
        >
          {r.fullName.split("/").pop()}
        </Link>
      ),
    },
    {
      id: "cursor",
      label: t("syncHealth.cursor"),
      header: t("syncHealth.cursor"),
      hideBelow: "md",
      cell: (r) => <span className="text-xs">{when(r.runsCursor)}</span>,
    },
    {
      id: "backfill",
      label: t("syncHealth.backfill"),
      header: t("syncHealth.backfill"),
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span
            role="meter"
            aria-label={t("syncHealth.backfillOf", { repo: r.fullName })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(r.backfillProgress * 100)}
            className="block h-1.5 w-20 overflow-hidden rounded-full bg-seq-1/40"
          >
            <span
              className="block h-full rounded-full bg-seq-3"
              style={{ width: `${Math.round(r.backfillProgress * 100)}%` }}
            />
          </span>
          <span className="text-xs tabular-nums">
            {r.backfillDone
              ? t("syncHealth.done")
              : formatPercent(r.backfillProgress, locale, 0)}
          </span>
        </span>
      ),
    },
    {
      id: "until",
      label: t("syncHealth.until"),
      header: t("syncHealth.until"),
      hideBelow: "lg",
      cell: (r) => <span className="text-xs">{when(r.backfillUntil)}</span>,
    },
    {
      id: "state",
      label: t("syncHealth.state"),
      header: t("syncHealth.state"),
      cell: (r) =>
        r.lastError ? (
          <span
            title={r.lastError}
            className="inline-flex max-w-72 items-center gap-1 text-xs"
          >
            <CircleAlert
              aria-hidden="true"
              className="size-3.5 shrink-0 text-status-critical"
            />
            <span className="truncate">{r.lastError}</span>
          </span>
        ) : r.needsResync ? (
          <span className="text-xs">{t("syncHealth.needsResync")}</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("syncHealth.ok")}
          </span>
        ),
    },
  ];

  const ignoredColumns: Column<IgnoredRepository>[] = [
    {
      id: "repo",
      label: t("ignore.settings.repo"),
      header: t("ignore.settings.repo"),
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Link
            href={repoHref(login, r.fullName)}
            className="font-medium underline-offset-2 hover:underline"
          >
            {r.fullName.split("/").pop()}
          </Link>
          {r.fork ? <StatusBadge kind="fork" /> : null}
          {r.removed ? (
            <span className="text-xs text-muted-foreground">
              {t("ignore.settings.removed")}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "by",
      label: t("ignore.settings.ignoredBy"),
      header: t("ignore.settings.ignoredBy"),
      hideBelow: "md",
      cell: (r) => (
        <span className="text-sm">
          {r.ignoredBy ?? "—"} · {when(r.ignoredAt)}
        </span>
      ),
    },
    {
      id: "state",
      label: t("ignore.settings.state"),
      header: t("ignore.settings.state"),
      hideBelow: "sm",
      cell: (r) => (
        <span className="text-sm text-muted-foreground">
          {r.purged ? t("ignore.settings.purged") : t("ignore.banner.purging")}
        </span>
      ),
    },
    ...(state.globalEnabled
      ? [
          {
            id: "action",
            label: t("ignore.settings.actions"),
            header: (
              <span className="sr-only">{t("ignore.settings.actions")}</span>
            ),
            align: "right" as const,
            cell: (r: IgnoredRepository) => (
              <RepoIgnoreButton
                installationId={installationId}
                mode="unignore"
                repos={[
                  { id: r.repositoryId, fullName: r.fullName, fork: r.fork },
                ]}
              />
            ),
          } satisfies Column<IgnoredRepository>,
        ]
      : []),
  ];

  const h2 = "scroll-mt-4 text-lg font-semibold";
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[
            { kind: "accounts" },
            { kind: "account", login },
            { kind: "section", login, section: "settings" },
          ]}
        />
        <PageHeader title={t("accountNav.settings")} />
        <nav aria-label={t("settingsPage.sections")}>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {SECTIONS.map((s) => (
              <li key={s}>
                <a
                  href={`#${s}`}
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t(`settingsPage.${s}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <section aria-labelledby="management" className="flex flex-col gap-3">
        <h2 id="management" className={h2}>
          {t("settingsPage.management")}
        </h2>
        {!state.globalEnabled ? <ManagementBanner state={state} /> : null}
        <ManagementSettings
          installationId={installationId}
          globalEnabled={state.globalEnabled}
          managementEnabled={state.installationEnabled}
          redactVariableValues={state.redactVariableValues}
        />
      </section>

      <VercelSection
        installationId={installationId}
        settings={vercel}
        globalEnabled={state.globalEnabled}
      />

      <AzureSection
        installationId={installationId}
        settings={azure}
        globalEnabled={state.globalEnabled}
        azureGlobal={env.AZURE_MANAGEMENT_ENABLED}
      />

      <section aria-labelledby="repositories" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="repositories" className={h2}>
            {t("ignore.settings.title", { count: ignored.length })}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`${accountPath(login, "/repos")}?f=forks`}
              className="text-sm underline-offset-2 hover:underline"
            >
              {t("settingsPage.ignoreForks")}
            </Link>
            {state.globalEnabled && ignored.length > 1 ? (
              <RepoIgnoreButton
                installationId={installationId}
                mode="unignore"
                label={t("ignore.action.unignoreAll", {
                  count: ignored.length,
                })}
                repos={ignored.map((r) => ({
                  id: r.repositoryId,
                  fullName: r.fullName,
                  fork: r.fork,
                }))}
              />
            ) : null}
          </div>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("ignore.settings.description")}
        </p>
        <DataTable
          caption={t("ignore.settings.title", { count: ignored.length })}
          columns={ignoredColumns}
          rows={ignored}
          rowKey={(r) => r.repositoryId}
          empty={<EmptyState quiet message={t("ignore.settings.empty")} />}
        />
      </section>

      <section aria-labelledby="sync" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="sync" className={h2}>
            {t("settingsPage.sync")}
          </h2>
          <SyncNowButton installationId={installationId} />
        </div>
        {vercel.connection ? (
          <p className="text-sm">
            <span className="text-muted-foreground">
              {t("vercelSettings.syncRow")}:{" "}
            </span>
            {t(
              `vercelSettings.status.${vercel.connection.lastSyncStatus ?? "never"}`,
            )}
            {vercel.connection.lastSyncedAt ? (
              <> · {when(vercel.connection.lastSyncedAt)}</>
            ) : null}
            {vercel.connection.lastError ? (
              <span className="text-muted-foreground">
                {" "}
                · {vercel.connection.lastError}
              </span>
            ) : null}
          </p>
        ) : null}
        {azure.connection ? (
          <p className="text-sm">
            <span className="text-muted-foreground">
              {t("ci.azure.settings.syncRow")}:{" "}
            </span>
            {t(
              `ci.azure.settings.status.${azure.connection.lastSyncStatus ?? "never"}`,
            )}
            {azure.connection.lastSyncedAt ? (
              <> · {when(azure.connection.lastSyncedAt)}</>
            ) : null}
            {azure.rateLimit ? (
              <span className="text-muted-foreground">
                {" "}
                ·{" "}
                {t("ci.azure.settings.rateLimitValue", {
                  remaining: azure.rateLimit.remaining,
                  limit: azure.rateLimit.limit,
                })}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              {" "}
              ·{" "}
              {t("ci.azure.settings.backfillRow", {
                done: azure.projects.filter((p) => p.selected && p.backfillDone)
                  .length,
                total: azure.projects.filter((p) => p.selected).length,
              })}
              {" · "}
              {azure.connection.hook.subscriptions.length > 0
                ? t("ci.azure.settings.hookRow", {
                    count: azure.connection.hook.subscriptions.length,
                  })
                : t("ci.azure.settings.noHookRow")}
            </span>
            {azure.connection.lastError ? (
              <span className="text-muted-foreground">
                {" "}
                · {azure.connection.lastError}
              </span>
            ) : null}
          </p>
        ) : null}
        <KpiStrip label={t("settingsPage.sync")} columns={4}>
          <KpiTile
            label={t("syncHealth.lastWebhook")}
            value={
              health.lastWebhookAt
                ? format.relativeTime(new Date(health.lastWebhookAt))
                : t("freshness.never")
            }
          />
          <KpiTile
            label={t("syncHealth.lastReconcile")}
            value={
              health.lastReconciledAt
                ? format.relativeTime(new Date(health.lastReconciledAt))
                : t("freshness.never")
            }
            hint={
              health.lastReconcileStatus
                ? `${health.lastReconcileStatus}${health.lastReconcileReason ? ` · ${health.lastReconcileReason}` : ""}`
                : undefined
            }
          />
          <KpiTile
            variant="meter"
            label={t("syncHealth.backfill")}
            info={t("settingsPage.importInfo", { days: env.BACKFILL_DAYS })}
            value={progress == null ? "—" : formatPercent(progress, locale, 0)}
            ratio={progress}
            hint={t("settingsPage.importDays", { days: env.BACKFILL_DAYS })}
          />
          {problems.length > 0 ? (
            <KpiTile
              variant="status"
              icon={CircleAlert}
              tone="critical"
              label={t("settingsPage.problems")}
              value={formatNumber(problems.length, locale)}
            />
          ) : (
            <KpiTile
              label={t("settingsPage.problems")}
              value={formatNumber(0, locale)}
            />
          )}
        </KpiStrip>
        {problems.length > 0 ? (
          <DataTable
            caption={t("syncHealth.repos")}
            columns={syncColumns}
            rows={sorted}
            rowKey={(r) => r.repositoryId}
          />
        ) : health.repos.length === 0 ? (
          <EmptyState quiet message={t("account.noRepos")} />
        ) : (
          <details>
            <summary className="w-fit cursor-pointer text-sm select-none">
              {t("settingsPage.allOk", { count: health.repos.length })}
            </summary>
            <div className="mt-2">
              <DataTable
                caption={t("syncHealth.repos")}
                columns={syncColumns}
                rows={sorted}
                rowKey={(r) => r.repositoryId}
              />
            </div>
          </details>
        )}
      </section>

      <section aria-labelledby="diagnostics" className="flex flex-col gap-3">
        <h2 id="diagnostics" className={h2}>
          {t("settingsPage.diagnostics")}
        </h2>
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer text-sm select-none">
            {t("settingsPage.diagnosticsSummary", {
              lag: formatDuration(health.ingestionLag.p50),
              dirty: health.dirtyPartitions,
            })}
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">
                {t("syncHealth.lagP50")}
              </dt>
              <dd>{formatDuration(health.ingestionLag.p50)}</dd>
              <dt className="text-muted-foreground">
                {t("syncHealth.lagP95")}
              </dt>
              <dd>{formatDuration(health.ingestionLag.p95)}</dd>
              <dt className="text-muted-foreground">{t("syncHealth.dirty")}</dt>
              <dd>{formatNumber(health.dirtyPartitions, locale)}</dd>
              <dt className="text-muted-foreground">
                {t("syncHealth.backfillDays")}
              </dt>
              <dd>{formatNumber(env.BACKFILL_DAYS, locale)}</dd>
            </dl>
            <div className="grid gap-6 md:grid-cols-2">
              <DataTable
                caption={t("syncHealth.deliveries")}
                columns={[
                  {
                    id: "status",
                    label: t("syncHealth.status"),
                    header: t("syncHealth.deliveries"),
                    cell: (s: (typeof DELIVERY_STATUSES)[number]) =>
                      t(`syncHealth.deliveryStatus.${s}`),
                  },
                  {
                    id: "count",
                    label: t("syncHealth.count"),
                    header: t("syncHealth.count"),
                    align: "right",
                    cell: (s) =>
                      formatNumber(health.deliveries24h[s] ?? 0, locale),
                  },
                ]}
                rows={DELIVERY_STATUSES}
                rowKey={(s) => s}
              />
              <DataTable
                caption={t("syncHealth.rateLimits")}
                columns={[
                  {
                    id: "resource",
                    label: t("syncHealth.resource"),
                    header: t("syncHealth.rateLimits"),
                    cell: (l: SyncHealth["rateLimits"][number]) => l.resource,
                  },
                  {
                    id: "remaining",
                    label: t("syncHealth.remaining"),
                    header: t("syncHealth.remaining"),
                    align: "right",
                    cell: (l) =>
                      `${formatNumber(l.remaining, locale)} / ${formatNumber(l.limit, locale)}`,
                  },
                  {
                    id: "reset",
                    label: t("syncHealth.reset"),
                    header: t("syncHealth.reset"),
                    align: "right",
                    cell: (l) => (
                      <span className="text-xs">{when(l.resetAt)}</span>
                    ),
                  },
                ]}
                rows={health.rateLimits}
                rowKey={(l) => l.resource}
                empty={
                  <EmptyState quiet message={t("syncHealth.noRateLimits")} />
                }
              />
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}
