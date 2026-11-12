import Link from "next/link";
import { notFound } from "next/navigation";
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
import { KpiGrid, KpiTile } from "@/components/insights/kpi-tile";
import { StatusBadge } from "@/components/insights/status-badge";
import {
  repoHref,
  runHref,
  workflowHref,
} from "@/components/insights/workflow-link";
import { ManagementBanner } from "@/components/management/management-banner";
import { RunActions } from "@/components/management/run-actions";
import { Badge } from "@/components/ui/badge";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import { criticalPath, timelineSegments } from "@/lib/chart-scale";
import { formatDuration, formatMinutes, shortSha } from "@/lib/format";
import { param, type SearchParams } from "@/lib/insights-view";
import { cn } from "@/lib/utils";
import { hasRole } from "@/server/authz/roles";
import { lastRunCancelAt } from "@/server/data/audit";
import { getRunDetail } from "@/server/data/insights";
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
  const steps = run.isPlaceholder
    ? ({ status: "unavailable" } as const)
    : await orNotFound(
        getRunSteps(scope, installation.id, BigInt(run.id), attempt),
      );

  const [t, format, locale, nowDate, state] = await Promise.all([
    getTranslations(),
    getFormatter(),
    getLocale(),
    getNow(),
    orNotFound(getManagementState(scope, installation.id)),
  ]);
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

  return (
    <div className="flex flex-col gap-6">
      {live ? <AutoRefresh /> : null}
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          <Link href={repoHref(login, run.repoFullName)} className="underline">
            {run.repoFullName}
          </Link>
          {run.workflowId ? (
            <>
              {" · "}
              <Link
                href={workflowHref(login, run.repoFullName, run.workflowId)}
                className="underline"
              >
                {run.workflowName}
              </Link>
            </>
          ) : null}
        </p>
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {run.workflowName}
          {run.runNumber != null ? (
            <span className="text-muted-foreground">#{run.runNumber}</span>
          ) : null}
          <StatusBadge status={run.status} conclusion={run.conclusion} />
          {live ? <Badge variant="outline">{t("run.live")}</Badge> : null}
        </h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("runs.event")}:</dt>
            <dd>{run.event ?? "—"}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("runs.branch")}:</dt>
            <dd>{run.headBranch ?? "—"}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("run.sha")}:</dt>
            <dd className="font-mono">{shortSha(run.headSha)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("runs.actor")}:</dt>
            <dd>{run.actorLogin ?? "—"}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("runs.created")}:</dt>
            <dd>
              <time dateTime={run.createdAt}>
                {format.dateTime(new Date(run.createdAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </dd>
          </div>
          {run.htmlUrl ? (
            <div>
              <a
                className="underline"
                href={run.htmlUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t("repo.openOnGithub")}
              </a>
            </div>
          ) : null}
        </dl>
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
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent",
                )}
              >
                {t("runs.attempt", { n: a })}
              </Link>
            ))}
          </nav>
        ) : null}
        {run.isPlaceholder ? (
          <p className="text-sm text-muted-foreground">
            {t("run.placeholder")}
          </p>
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

      <KpiGrid>
        <KpiTile label={t("run.wall")} value={formatDuration(timings.wallS)} />
        <KpiTile
          label={t("run.compute")}
          value={formatDuration(timings.computeS)}
        />
        <KpiTile
          label={t("run.parallelism")}
          value={
            timings.parallelism == null
              ? "—"
              : `${timings.parallelism.toFixed(1)}×`
          }
        />
        <KpiTile
          label={t("run.firstQueue")}
          value={formatDuration(timings.firstQueueS)}
        />
        <KpiTile label={t("run.jobs")} value={String(jobs.length)} />
        <KpiTile
          label={t("kpi.minutes")}
          value={formatMinutes(
            jobs.reduce((s, j) => s + (j.billableMinEst ?? 0), 0),
            locale,
          )}
          hint={t("kpi.minutesHint")}
        />
      </KpiGrid>

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
        {steps.status === "expired" ? (
          <p className="text-sm text-muted-foreground">
            {t("run.stepsExpired")}
          </p>
        ) : steps.status === "unavailable" && !run.isPlaceholder ? (
          <p className="text-sm text-muted-foreground">
            {t("run.stepsUnavailable")}
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {jobs.map((j) => {
            const jobSteps =
              steps.status === "ok" ? (steps.byJob[j.id] ?? []) : [];
            return (
              <li key={j.id} className="rounded-lg border">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium">{j.name}</span>
                    <StatusBadge status={j.status} conclusion={j.conclusion} />
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
                    {steps.status !== "ok" ? null : jobSteps.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("run.noSteps")}
                      </p>
                    ) : (
                      <ol className="flex flex-col gap-1">
                        {jobSteps.map((s) => (
                          <li
                            key={s.number}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <span className="w-6 text-right text-xs text-muted-foreground tabular-nums">
                              {s.number}
                            </span>
                            <StatusBadge
                              status={s.status}
                              conclusion={s.conclusion}
                            />
                            <span>{s.name}</span>
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                              {formatDuration(s.durationS)}
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
      </section>
    </div>
  );
}
