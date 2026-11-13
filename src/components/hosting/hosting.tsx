import {
  CircleAlert,
  Clock,
  ExternalLink,
  Gauge,
  Hourglass,
  Link2Off,
  Unplug,
  Info,
  KeyRound,
  Rocket,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DataTable } from "@/components/charts/data-table";
import { Legend } from "@/components/charts/legend";
import {
  StackedBarChart,
  type BarSeries,
} from "@/components/charts/stacked-bar-chart";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { repoHref } from "@/components/insights/workflow-link";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import {
  deployBadgeKind,
  deploySuccessRate,
  shortSha,
  type DeployDay,
} from "@/lib/hosting-view";
import { bucketDays, type RangeBucket } from "@/lib/range";
import type {
  AttentionItem,
  DeploymentRow,
  RepoDeploymentCard,
  VercelActionState,
} from "@/server/data/vercel";
import {
  BuildLogExcerpt,
  DeploymentActions,
  type ActionContext,
  type ActionDeployment,
} from "./deployment-actions";

/**
 * Building blocks of the hosting (Vercel) views: state and target badges,
 * the preview badge of pull requests and runs, the deployments-per-day
 * chart (figure + legend + table view), the Needs-attention list and the
 * repository's Deployments card, and the M6 action blocks (buttons for
 * operators while every gate is open, the live build log excerpt, the
 * audit entry of a redeploy, the auto-assign banner with Promote). External
 * strings are rendered as text; links to Vercel are built from stored ids
 * (rel="noopener noreferrer").
 */

/** Where the action blocks of a page come from (null: no buttons). */
export type HostingActions = {
  installationId: string;
  login: string;
  state: VercelActionState | null;
};

function actionContext(a: HostingActions | undefined): ActionContext | null {
  return a?.state?.canAct
    ? {
        installationId: a.installationId,
        plan: a.state.plan,
        last24h: a.state.last24h,
      }
    : null;
}

export function actionDeployment(d: DeploymentRow): ActionDeployment {
  return {
    id: d.id,
    projectName: d.projectName,
    target: d.target,
    state: d.state,
    live: d.live,
    rollbackCandidate: d.rollbackCandidate,
    commitSha: d.commitSha,
    branch: d.branch,
  };
}

/**
 * The expanded deployment row: M6 buttons (operators, every gate open), the
 * build log excerpt (operators and admins; viewers use the Vercel link) and
 * the audit entry of the redeploy that created it ("probably" for a link by
 * time window).
 */
export async function DeploymentRowActions({
  deployment: d,
  installationId,
  login,
  state,
  paused = false,
}: {
  deployment: DeploymentRow;
  installationId: string;
  login: string;
  state: VercelActionState | null;
  paused?: boolean;
}) {
  const t = await getTranslations("hosting");
  const ctx = actionContext({ installationId, login, state });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {ctx ? (
        <DeploymentActions
          ctx={ctx}
          deployment={actionDeployment(d)}
          paused={paused}
          compact
        />
      ) : null}
      {state?.canViewLog ? (
        <BuildLogExcerpt installationId={installationId} deploymentId={d.id} />
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("log.viewerNote")}
        </span>
      )}
      {d.auditEntryId ? (
        <Link
          href={`/o/${encodeURIComponent(login)}/audit?entry=${encodeURIComponent(d.auditEntryId)}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <ScrollText aria-hidden="true" className="size-3" />
          {d.auditLinkKind === "probable"
            ? t("auditLink.probable")
            : t("auditLink.exact")}
        </Link>
      ) : null}
    </div>
  );
}

/** Why an operator sees no action buttons (a toggle is off, or the token was rejected). */
export async function ActionsBlockedNote({
  state,
}: {
  state: VercelActionState | null;
}) {
  if (!state?.blockedBy || state.blockedBy === "role") return null;
  const t = await getTranslations("hosting.actions.blocked");
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {t(state.blockedBy)}
    </p>
  );
}

/** "Production auto-assignment paused since …" with Promote (W4). */
export async function PausedBanner({
  since,
  promote,
  actions,
}: {
  since: string;
  promote: DeploymentRow | null;
  actions?: HostingActions;
}) {
  const [t, format] = await Promise.all([
    getTranslations("hosting"),
    getFormatter(),
  ]);
  const ctx = actionContext(actions);
  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-2 rounded-md border border-status-warning/60 bg-status-warning/10 p-2 text-sm"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-status-warning"
      />
      <span className="min-w-0 flex-1">
        {t("pausedBanner", { when: format.relativeTime(new Date(since)) })}
        {promote ? (
          <span className="block text-xs text-muted-foreground">
            {t("pausedPromote", {
              commit: shortSha(promote.commitSha) ?? promote.id,
            })}
          </span>
        ) : null}
      </span>
      {ctx && promote ? (
        <DeploymentActions
          ctx={ctx}
          deployment={actionDeployment(promote)}
          paused
          only={["promote"]}
          compact
        />
      ) : null}
    </div>
  );
}

export function DeployStateBadge({ state }: { state: string | null }) {
  return <StatusBadge kind={deployBadgeKind(state)} />;
}

export function TargetBadge({ target }: { target: string }) {
  return (
    <StatusBadge kind={target === "production" ? "production" : "preview"} />
  );
}

export { PreviewBadge } from "./preview-badge";

export function ExternalVercelLink({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        className ??
        "inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      }
    >
      <ExternalLink aria-hidden="true" className="size-3" />
      {label}
    </a>
  );
}

const SERIES = (t: (k: string) => string): BarSeries[] => [
  { key: "ready", label: t("state.deployReady"), tone: "success" },
  {
    key: "error",
    label: t("state.deployError"),
    tone: "failure",
    pattern: "hatch",
  },
  {
    key: "canceled",
    label: t("state.deployCanceled"),
    tone: "cancelled",
    pattern: "dots",
  },
  { key: "other", label: t("state.other"), tone: "other", pattern: "cross" },
];

/** Deployments per day (or week/month), stacked by state. */
export async function DeploymentsPerDayChart({
  id,
  days,
  bucket,
}: {
  id: string;
  days: ReadonlyArray<DeployDay>;
  bucket: RangeBucket;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("hosting"),
    getLocale(),
  ]);
  const b = bucket === "hour" ? "day" : bucket;
  const points = bucketDays(days, b, [
    "ready",
    "error",
    "canceled",
    "other",
  ]).map((p) => ({
    day: p.bucket,
    ready: p.ready ?? 0,
    error: p.error ?? 0,
    canceled: p.canceled ?? 0,
    other: p.other ?? 0,
  }));
  const fmt = new Intl.DateTimeFormat(
    locale,
    b === "month"
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { day: "numeric", month: "short", timeZone: "UTC" },
  );
  const label = (day: string) => fmt.format(new Date(`${day}T00:00:00.000Z`));
  const series = SERIES((k) => t(k));
  const total = points.reduce(
    (s, d) => s + d.ready + d.error + d.canceled + d.other,
    0,
  );
  const title = t("chart.title", { bucket: b });
  return (
    <ChartFrame
      title={title}
      description={t("chart.description")}
      chart={
        <StackedBarChart
          id={id}
          label={t("chart.label", { bucket: b, n: points.length, total })}
          series={series}
          points={points.map((d) => ({
            x: label(d.day),
            title: label(d.day),
            values: {
              ready: d.ready,
              error: d.error,
              canceled: d.canceled,
              other: d.other,
            },
          }))}
        />
      }
      legend={
        <Legend
          items={series.map((s) => ({
            label: s.label,
            tone: s.tone,
            kind: "bar" as const,
            pattern: s.pattern,
          }))}
        />
      }
      table={
        <DataTable
          caption={title}
          columns={[
            t(`chart.bucketName.${b}`),
            t("chart.total"),
            ...series.map((s) => s.label),
            t("chart.successRate"),
          ]}
          rows={points.map((d) => [
            label(d.day),
            formatNumber(d.ready + d.error + d.canceled + d.other, locale),
            formatNumber(d.ready, locale),
            formatNumber(d.error, locale),
            formatNumber(d.canceled, locale),
            formatNumber(d.other, locale),
            formatPercent(deploySuccessRate(d.ready, d.error), locale),
          ])}
        />
      }
    />
  );
}

const ATTENTION_ICON = {
  prod_failing: CircleAlert,
  auto_assign_paused: TriangleAlert,
  token_expiring: KeyRound,
  credential_revoked: KeyRound,
  // Azure Pipelines (M7)
  azure_default_failing: CircleAlert,
  azure_job_cap: Clock,
  azure_minutes: Gauge,
  azure_parallel_saturated: Hourglass,
  azure_pool_offline: Unplug,
  azure_hook_disabled: TriangleAlert,
  azure_definition_unlinked: Link2Off,
  azure_token_expiring: KeyRound,
  azure_credential_revoked: KeyRound,
} as const;

/** The Needs-attention list (findings), most severe first. */
export async function NeedsAttention({
  items,
  login,
  settingsHref,
  actions,
}: {
  items: ReadonlyArray<AttentionItem>;
  login: string;
  settingsHref?: string;
  /** Offers Promote on "auto-assign paused" to operators (W4). */
  actions?: HostingActions;
}) {
  const ctx = actionContext(actions);
  const [t, format] = await Promise.all([
    getTranslations("hosting.attention"),
    getFormatter(),
  ]);
  if (items.length === 0) return <EmptyState quiet message={t("empty")} />;
  return (
    <ul className="flex flex-col">
      {items.map((i) => {
        const Icon =
          ATTENTION_ICON[i.kind as keyof typeof ATTENTION_ICON] ?? CircleAlert;
        const known = i.kind in ATTENTION_ICON;
        const when = i.at ? new Date(i.at) : new Date(i.since);
        const azure = i.kind.startsWith("azure_");
        const credential =
          i.kind === "token_expiring" ||
          i.kind === "credential_revoked" ||
          i.kind === "azure_token_expiring" ||
          i.kind === "azure_credential_revoked";
        return (
          <li
            key={i.id}
            className="flex items-start gap-2 border-t py-1.5 text-sm first:border-t-0"
          >
            <Icon
              aria-hidden="true"
              className={
                i.severity === "HIGH" || i.severity === "CRITICAL"
                  ? "mt-0.5 size-4 shrink-0 text-status-critical"
                  : "mt-0.5 size-4 shrink-0 text-status-warning"
              }
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-medium">
                  {known
                    ? t(`kind.${i.kind}`, { project: i.projectName ?? "—" })
                    : i.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(`severity.${i.severity}`)}
                </span>
                {i.repoFullName ? (
                  <Link
                    href={repoHref(login, i.repoFullName)}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  >
                    {i.repoFullName.split("/").pop()}
                  </Link>
                ) : null}
              </span>
              <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <time
                  dateTime={when.toISOString()}
                  title={format.dateTime(when, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                >
                  {i.kind === "token_expiring" ||
                  i.kind === "azure_token_expiring"
                    ? t("expires", { when: format.relativeTime(when) })
                    : t("since", { when: format.relativeTime(when) })}
                </time>
                {credential && settingsHref ? (
                  <Link
                    href={`${settingsHref}#${azure ? "azure" : "hosting"}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {t("reconnect")}
                  </Link>
                ) : i.externalUrl ? (
                  <ExternalVercelLink
                    href={i.externalUrl}
                    label={azure ? t("openInAzure") : t("openInVercel")}
                  />
                ) : null}
              </span>
              {ctx && i.promote ? (
                <span className="mt-1">
                  <DeploymentActions
                    ctx={ctx}
                    deployment={{
                      id: i.promote.deploymentId,
                      projectName: i.promote.projectName,
                      target: "production",
                      state: "READY",
                      live: false,
                      rollbackCandidate: false,
                      commitSha: i.promote.commitSha,
                      branch: null,
                    }}
                    paused
                    only={["promote"]}
                    compact
                  />
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DeploymentLine({
  d,
  ctx,
  paused,
}: {
  d: DeploymentRow;
  ctx: ActionContext | null;
  paused: boolean;
}) {
  const t = useTranslations("hosting");
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t py-1.5 text-sm first:border-t-0">
      <DeployStateBadge state={d.state} />
      <TargetBadge target={d.target} />
      <span className="font-mono text-xs">{shortSha(d.commitSha) ?? "—"}</span>
      <span className="max-w-48 truncate text-xs text-muted-foreground">
        {d.branch ?? "—"}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        title={d.commitMessage ?? undefined}
      >
        {d.commitMessage ?? ""}
      </span>
      <RelTime iso={d.createdAt} />
      <ExternalVercelLink href={d.vercelUrl} label={t("openInVercel")} />
      {ctx ? (
        <DeploymentActions
          ctx={ctx}
          deployment={actionDeployment(d)}
          paused={paused}
          compact
        />
      ) : null}
    </li>
  );
}

async function RelTime({ iso }: { iso: string }) {
  const format = await getFormatter();
  const d = new Date(iso);
  return (
    <time
      dateTime={iso}
      title={format.dateTime(d, { dateStyle: "medium", timeStyle: "short" })}
      className="text-xs whitespace-nowrap text-muted-foreground"
    >
      {format.relativeTime(d)}
    </time>
  );
}

/** The repository page's Deployments card, one block per linked project. */
export async function RepoDeployments({
  cards,
  actions,
}: {
  cards: ReadonlyArray<RepoDeploymentCard>;
  /** M6 buttons for operators (every gate open). */
  actions?: HostingActions;
}) {
  const t = await getTranslations("hosting");
  if (cards.length === 0) return null;
  const ctx = actionContext(actions);
  return (
    <section
      aria-labelledby="repo-deployments"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <h2 id="repo-deployments" className="flex items-center gap-2 font-medium">
        <Rocket aria-hidden="true" className="size-4 text-muted-foreground" />
        {t("repoCard.title")}
      </h2>
      {cards.map((c) => {
        const prod = c.production;
        const live = c.live && c.live.id !== prod?.id ? c.live : null;
        return (
          <div
            key={c.projectId}
            className="flex flex-col gap-2 border-t pt-3 first-of-type:border-t-0 first-of-type:pt-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{c.projectName}</span>
              {c.manualLink ? <StatusBadge kind="manualLink" /> : null}
              <ExternalVercelLink
                href={c.vercelUrl}
                label={t("openInVercel")}
              />
            </div>
            {c.autoAssignPausedAt ? (
              <PausedBanner
                since={c.autoAssignPausedAt}
                promote={c.promote}
                actions={actions}
              />
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-xs text-muted-foreground">
                {t("repoCard.production")}
              </dt>
              <dd className="flex flex-wrap items-center gap-2">
                {prod ? (
                  <>
                    <DeployStateBadge state={prod.state} />
                    <span className="font-mono text-xs">
                      {shortSha(prod.commitSha) ?? "—"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {prod.branch ?? c.productionBranch ?? "—"}
                    </span>
                    <RelTime iso={prod.readyAt ?? prod.createdAt} />
                    {prod.url && prod.state === "READY" ? (
                      <ExternalVercelLink
                        href={`https://${prod.url}`}
                        label={prod.url}
                      />
                    ) : null}
                    {ctx ? (
                      <DeploymentActions
                        ctx={ctx}
                        deployment={actionDeployment(prod)}
                        paused={!!c.autoAssignPausedAt}
                        only={["redeploy", "cancel"]}
                        compact
                      />
                    ) : null}
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("repoCard.none")}
                  </span>
                )}
              </dd>
              {live ? (
                <>
                  <dt className="text-xs text-muted-foreground">
                    {t("repoCard.live")}
                  </dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <DeployStateBadge state={live.state} />
                    <span className="font-mono text-xs">
                      {shortSha(live.commitSha) ?? "—"}
                    </span>
                    <RelTime iso={live.readyAt ?? live.createdAt} />
                  </dd>
                </>
              ) : null}
              <dt className="text-xs text-muted-foreground">
                {t("repoCard.preview")}
              </dt>
              <dd className="flex flex-wrap items-center gap-2">
                {c.latestPreview ? (
                  <>
                    <DeployStateBadge state={c.latestPreview.state} />
                    <span className="max-w-48 truncate text-xs">
                      {c.latestPreview.branch ?? "—"}
                    </span>
                    <span className="font-mono text-xs">
                      {shortSha(c.latestPreview.commitSha) ?? "—"}
                    </span>
                    <RelTime iso={c.latestPreview.createdAt} />
                    {c.latestPreview.url &&
                    c.latestPreview.state === "READY" ? (
                      <ExternalVercelLink
                        href={`https://${c.latestPreview.url}`}
                        label={t("openPreview")}
                      />
                    ) : null}
                    {ctx ? (
                      <DeploymentActions
                        ctx={ctx}
                        deployment={actionDeployment(c.latestPreview)}
                        compact
                      />
                    ) : null}
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("repoCard.none")}
                  </span>
                )}
              </dd>
            </dl>
            <details>
              <summary className="w-fit cursor-pointer text-xs text-muted-foreground select-none">
                {t("repoCard.recent", { count: c.recent.length })}
              </summary>
              <ul className="mt-1 flex flex-col">
                {c.recent.map((d) => (
                  <DeploymentLine
                    key={d.id}
                    d={d}
                    ctx={ctx}
                    paused={!!c.autoAssignPausedAt}
                  />
                ))}
              </ul>
            </details>
          </div>
        );
      })}
    </section>
  );
}

/** Build time for tables (seconds-based formatter). */
export function buildTime(ms: number | null): string {
  return ms == null ? "—" : formatDuration(Math.round(ms / 1000));
}
