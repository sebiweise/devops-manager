import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  getFormatter,
  getLocale,
  getNow,
  getTranslations,
} from "next-intl/server";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DataTable } from "@/components/charts/data-table";
import { RunTimeline, TimelineLegend } from "@/components/charts/run-timeline";
import { AutoRefresh } from "@/components/insights/auto-refresh";
import { EmptyState } from "@/components/data/empty-state";
import { KpiStrip, KpiTile } from "@/components/data/kpi-strip";
import { RunStatusBadge } from "@/components/data/status-badge";
import { runHref } from "@/components/insights/workflow-link";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { ManagementBanner } from "@/components/management/management-banner";
import { RunActions } from "@/components/management/run-actions";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { criticalPath, timelineSegments } from "@/lib/chart-scale";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  shortSha,
} from "@/lib/format";
import { param, type SearchParams } from "@/lib/insights-view";
import { cn } from "@/lib/utils";
import { hasRole } from "@/server/authz/roles";
import { lastRunCancelAt } from "@/server/data/audit";
import { getRunDetail } from "@/server/data/insights";
import { deploymentsForShas } from "@/server/data/vercel";
import { PreviewBadge } from "@/components/hosting/preview-badge";
import { getManagementState } from "@/server/data/management";
import { getRunSteps } from "@/server/data/steps";
import { accountMeta } from "@/lib/page-meta";

export const generateMetadata = accountMeta("run");

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; runId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account, runId } = await params;
  const sp = await searchParams;
  if (!/^\d{1,20}$/.test(runId)) notFound();
  const { scope, installation } = await loadAccount(account);
  const attemptParam = Number(param(sp, "attempt"));
  const detail = await orNotFound(
    getRunDetail(
      scope,
      installation.id,
      BigInt(runId),
      Number.isInteger(attemptParam) && attemptParam > 0
        ? attemptParam
        : undefined,
    ),
  );
  const { run, jobs, attempt, attempts, timings } = detail;

  const [t, format, locale, nowDate, state, deployed] = await Promise.all([
    getTranslations(),
    getFormatter(),
    getLocale(),
    getNow(),
    orNotFound(getManagementState(scope, installation.id)),
    orNotFound(deploymentsForShas(scope, installation.id, [run.headSha])),
  ]);
  const deployedAs = deployed.get(run.headSha.toLowerCase()) ?? [];
  const login = installation.accountLogin;
  const now = nowDate.getTime();
  const origin = Math.min(
    ...jobs.map((j) => Date.parse(j.createdAt)),
    run.runStartedAt ? Date.parse(run.runStartedAt) : Infinity,
  );
  const nowOffset = Number.isFinite(origin)
    ? Math.max(0, Math.round((now - origin) / 1000))
    : 0;
  const live = run.status !== "COMPLETED" && attempt === run.runAttempt;
  // Actions act on the run as GitHub holds it: only on its latest attempt.
  const showActions =
    state.canOperate && !run.isPlaceholder && attempt === run.runAttempt;
  const cancelledAt =
    showActions && run.status !== "COMPLETED"
      ? await lastRunCancelAt(installation.id, BigInt(run.id))
      : null;
  const forceCancelAvailable =
    cancelledAt !== null && now - cancelledAt.getTime() >= 60_000;
  const path = criticalPath(
    jobs.map((j) => ({
      id: j.id,
      started: j.offsets.started,
      completed: j.offsets.completed,
    })),
  );
  const rows = jobs.map((j) => ({
    id: j.id,
    name: j.name,
    detail: [
      j.status === "COMPLETED" && j.conclusion
        ? t(`status.${j.conclusion}`)
        : t(`status.${j.status}`),
      j.runnerName ?? t("run.noRunner"),
    ].join(" · "),
    segments: timelineSegments(j.offsets, j.waitingS, nowOffset),
    critical: path.has(j.id),
  }));
  const span = Math.max(1, ...rows.flatMap((r) => r.segments.map((s) => s.to)));
  const kindLabels = {
    queue: t("run.queue"),
    wait: t("run.wait"),
    run: t("run.execution"),
  };
  const timelineTitle = t("run.timeline");
  const failedJobs = jobs.filter(
    (j) => j.status === "COMPLETED" && isFailure(j.conclusion),
  ).length;

  return (
    <div className="flex flex-col gap-6">
      {live ? <AutoRefresh /> : null}
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[
            { kind: "accounts" },
            { kind: "account", login },
            { kind: "section", login, section: "repos" },
            {
              kind: "repo",
              login,
              name: run.repoFullName.split("/").pop() ?? run.repoFullName,
              fullName: run.repoFullName,
            },
            ...(run.workflowId
              ? [
                  {
                    kind: "workflow" as const,
                    login,
                    repoFullName: run.repoFullName,
                    name: run.workflowName,
                    id: run.workflowId,
                  },
                ]
              : []),
            {
              kind: "run",
              login,
              id: run.id,
              number: run.runNumber,
              attempt,
            },
          ]}
        />
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {run.workflowName}
              {run.runNumber != null ? (
                <span className="text-muted-foreground">#{run.runNumber}</span>
              ) : null}
              <RunStatusBadge status={run.status} conclusion={run.conclusion} />
              {live ? (
                <span className="rounded-full border px-2 py-0.5 text-xs font-normal">
                  {t("run.live")}
                </span>
              ) : null}
              {deployedAs.length > 0 ? (
                <span className="text-sm font-normal">
                  <PreviewBadge deployments={deployedAs} />
                </span>
              ) : null}
            </span>
          }
          subtitle={
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="sr-only">{t("runs.branch")}</span>
              <span className="font-medium text-foreground">
                {run.headBranch ?? "—"}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono" title={run.headSha}>
                {shortSha(run.headSha)}
              </span>
              <span aria-hidden="true">·</span>
              <span className="sr-only">{t("runs.event")}</span>
              <span>{run.event ?? "—"}</span>
              <span aria-hidden="true">·</span>
              <span className="sr-only">{t("runs.actor")}</span>
              <span>{run.actorLogin ?? "—"}</span>
              <span aria-hidden="true">·</span>
              <time
                dateTime={run.createdAt}
                title={format.dateTime(new Date(run.createdAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              >
                {format.relativeTime(new Date(run.createdAt), nowDate)}
              </time>
            </span>
          }
          actions={
            run.htmlUrl ? (
              <a
                href={run.htmlUrl}
                rel="noopener noreferrer"
                target="_blank"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
                {t("repo.openOnGithub")}
              </a>
            ) : null
          }
        />
        {attempts.length > 1 ? (
          <nav aria-label={t("run.attempts")} className="flex flex-wrap gap-1">
            {attempts.map((a) => (
              <Link
                key={a}
                href={runHref(login, run.id, a)}
                aria-current={a === attempt ? "page" : undefined}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  a === attempt
                    ? "bg-secondary font-medium"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {t("runs.attempt", { n: a })}
              </Link>
            ))}
          </nav>
        ) : null}
        {run.isPlaceholder ? (
          <EmptyState quiet message={t("run.placeholder")} />
        ) : null}
      </div>

      {hasRole(scope.role, "OPERATOR") ? (
        <ManagementBanner
          state={state}
          settingsHref={
            hasRole(scope.role, "ADMIN")
              ? accountPath(login, "/settings")
              : undefined
          }
        />
      ) : null}
      {showActions ? (
        <section
          aria-label={t("management.runs.actions")}
          className="flex flex-col gap-2"
        >
          <RunActions
            installationId={String(installation.id)}
            run={{
              id: run.id,
              repoFullName: run.repoFullName,
              workflowName: run.workflowName,
              runNumber: run.runNumber,
              runAttempt: run.runAttempt,
              status: run.status,
              conclusion: run.conclusion,
              isPlaceholder: run.isPlaceholder,
            }}
            forceCancelAvailable={forceCancelAvailable}
          />
          <p className="text-xs text-muted-foreground">
            {t("management.actingAsNote")}
          </p>
        </section>
      ) : null}

      <KpiStrip label={t("overview.kpiLabel")}>
        <KpiTile
          label={t("run.wall")}
          info={t("run.wallInfo")}
          value={formatDuration(timings.wallS)}
        />
        <KpiTile
          label={t("run.firstQueue")}
          info={t("run.firstQueueInfo")}
          value={formatDuration(timings.firstQueueS)}
        />
        <KpiTile
          label={t("run.jobs")}
          value={formatNumber(jobs.length, locale)}
          hint={
            failedJobs > 0
              ? t("run.jobsFailed", { count: failedJobs })
              : undefined
          }
        />
        <KpiTile
          label={t("overview.kpi.minutes")}
          info={t("overview.kpi.minutesInfo")}
          value={formatMinutes(
            jobs.reduce((sum, j) => sum + (j.billableMinEst ?? 0), 0),
            locale,
          )}
        />
        <KpiTile
          label={t("run.compute")}
          info={t("run.computeInfo")}
          value={formatDuration(timings.computeS)}
        />
        <KpiTile
          label={t("run.parallelism")}
          info={t("run.parallelismInfo")}
          value={
            timings.parallelism == null
              ? "—"
              : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(timings.parallelism)}×`
          }
        />
      </KpiStrip>

      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("run.noJobs")}</p>
      ) : (
        <ChartFrame
          title={timelineTitle}
          description={t("run.timelineDescription")}
          chart={
            <RunTimeline
              label={t("run.timelineLabel", {
                jobs: jobs.length,
                span: formatDuration(span),
              })}
              rows={rows}
              spanS={span}
              kindLabels={kindLabels}
              criticalLabel={t("run.critical")}
              formatS={formatDuration}
            />
          }
          legend={<TimelineLegend kindLabels={kindLabels} />}
          table={
            <DataTable
              caption={timelineTitle}
              columns={[
                t("workflow.job"),
                t("runs.status"),
                t("run.runner"),
                t("run.queue"),
                t("run.wait"),
                t("run.execution"),
                t("run.critical"),
              ]}
              rows={jobs.map((j) => [
                j.name,
                j.status === "COMPLETED" && j.conclusion
                  ? t(`status.${j.conclusion}`)
                  : t(`status.${j.status}`),
                j.runnerName ?? "—",
                formatDuration(j.queueS),
                j.waitingS > 0 ? formatDuration(j.waitingS) : "—",
                formatDuration(j.durationS),
                path.has(j.id) ? t("common.yes") : t("common.no"),
              ])}
            />
          }
        />
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">{t("run.jobsAndSteps")}</h2>
        {run.isPlaceholder ? (
          <JobList jobs={jobs} steps={null} />
        ) : (
          <Suspense fallback={<JobList jobs={jobs} steps="loading" />}>
            <JobsWithSteps
              scope={scope}
              installationId={installation.id}
              runId={BigInt(run.id)}
              attempt={attempt}
              jobs={jobs}
            />
          </Suspense>
        )}
      </section>
    </div>
  );
}

type Job = Awaited<ReturnType<typeof getRunDetail>>["jobs"][number];
type Steps = Awaited<ReturnType<typeof getRunSteps>>;

const isFailure = (c: string | null) =>
  c === "FAILURE" || c === "TIMED_OUT" || c === "STARTUP_FAILURE";

/** Loads the steps live from GitHub; the job list shows meanwhile. */
async function JobsWithSteps({
  scope,
  installationId,
  runId,
  attempt,
  jobs,
}: {
  scope: Awaited<ReturnType<typeof loadAccount>>["scope"];
  installationId: bigint;
  runId: bigint;
  attempt: number;
  jobs: Job[];
}) {
  const steps = await orNotFound(
    getRunSteps(scope, installationId, runId, attempt),
  );
  return <JobList jobs={jobs} steps={steps} />;
}

/**
 * Jobs with their steps (UI overhaul §2.8): one disclosure per job, failed
 * jobs open by default; while the steps load, a skeleton line shows.
 */
async function JobList({
  jobs,
  steps,
}: {
  jobs: Job[];
  steps: Steps | "loading" | null;
}) {
  const t = await getTranslations();
  const loaded = steps !== null && steps !== "loading" ? steps : null;
  return (
    <div className="flex flex-col gap-2">
      {loaded?.status === "expired" ? (
        <EmptyState quiet message={t("run.stepsExpired")} />
      ) : loaded?.status === "unavailable" ? (
        <EmptyState quiet message={t("run.stepsUnavailable")} />
      ) : null}
      <ul className="flex flex-col gap-2">
        {jobs.map((j) => {
          const failed = j.status === "COMPLETED" && isFailure(j.conclusion);
          const jobSteps =
            loaded?.status === "ok" ? (loaded.byJob[j.id] ?? []) : null;
          return (
            <li key={j.id} className="rounded-lg border">
              <details open={failed || undefined}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-medium">{j.name}</span>
                  <RunStatusBadge status={j.status} conclusion={j.conclusion} />
                  <span className="text-xs text-muted-foreground">
                    {j.runnerName ?? t("run.noRunner")} ·{" "}
                    {t(`runnerKind.${j.runnerKind}`)} ·{" "}
                    {formatDuration(j.durationS)}
                  </span>
                </summary>
                <div className="flex flex-col gap-2 border-t px-3 py-2 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {t("run.labels")}:{" "}
                    {j.labels.length > 0 ? j.labels.join(", ") : "—"}
                  </p>
                  {steps === "loading" ? (
                    <p
                      role="status"
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span
                        aria-hidden="true"
                        className="block h-3 w-48 animate-pulse rounded bg-muted"
                      />
                      {t("run.stepsLoading")}
                    </p>
                  ) : jobSteps === null ? null : jobSteps.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("run.noSteps")}
                    </p>
                  ) : (
                    <ol className="flex flex-col gap-1">
                      {jobSteps.map((st) => (
                        <li
                          key={st.number}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span className="w-6 text-right text-xs text-muted-foreground tabular-nums">
                            {st.number}
                          </span>
                          <RunStatusBadge
                            status={st.status}
                            conclusion={st.conclusion}
                          />
                          <span>{st.name}</span>
                          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                            {formatDuration(st.durationS)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
