import {
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { getFormatter, getTranslations } from "next-intl/server";
import { AzureBuildBadge, SourceBadge } from "@/components/azure/azure-badges";
import {
  AzureLogExcerpt,
  BuildActions,
  StageRetryButton,
  type AzureActionContext,
} from "@/components/azure/azure-actions";
import { AzureBlockedNote } from "@/components/azure/azure-views";
import { AutoRefresh } from "@/components/insights/auto-refresh";
import { repoHref } from "@/components/insights/workflow-link";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/shell/page-header";
import { env } from "@/env";
import { loadAccount, orNotFound } from "@/lib/account-page";
import { stageRetryable } from "@/lib/azure-view";
import { formatDuration } from "@/lib/format";
import { accountMeta } from "@/lib/page-meta";
import {
  getAzureActionState,
  getAzureRun,
  type AzureJobDto,
} from "@/server/data/azure";
import { liveTasks } from "@/server/ingest/azure-live";
import { scheduleOpenAzureRefresh } from "@/server/ingest/triggers";

export const generateMetadata = accountMeta("pipelineRun");

/**
 * One Azure Pipelines run (design addendum M7 §6 "Run detail"; its own
 * route, so it never collides with the GitHub /runs/[runId]): the header
 * with links to the GitHub commit and pull request, stages with their jobs
 * (attempt, pool or image, OS, a bar against the job time limit), the live
 * tasks (read from Azure DevOps, cached 15 s, never stored), the job log
 * excerpt for operators (read live, scrubbed, never stored) and "Open in
 * Azure DevOps". A build of another installation or of an ignored
 * repository answers 404. While it runs the page polls every 15 s.
 */
export default async function AzureRunPage({
  params,
}: {
  params: Promise<{ account: string; buildId: string }>;
}) {
  const { account, buildId: raw } = await params;
  if (!/^\d{1,10}$/.test(raw)) notFound();
  const buildId = Number(raw);
  const { scope, installation } = await loadAccount(account);
  const detail = await orNotFound(getAzureRun(scope, installation.id, buildId));
  const now = new Date();
  const [t, format, state, tasks] = await Promise.all([
    getTranslations(),
    getFormatter(),
    orNotFound(
      getAzureActionState(
        scope,
        installation.id,
        env.MANAGEMENT_ENABLED,
        env.AZURE_MANAGEMENT_ENABLED,
        now,
      ),
    ),
    liveTasks(installation.id, buildId).catch(() => null),
  ]);
  const r = detail.run;
  const login = installation.accountLogin;
  const open = r.status !== "COMPLETED";
  if (open)
    scheduleOpenAzureRefresh(
      installation.id,
      [{ projectId: r.projectId, buildId: r.id }],
      (task) => after(task),
    );
  const ctx: AzureActionContext | null = state?.canAct
    ? {
        installationId: String(installation.id),
        minutesLeft: state.minutesLeft,
        maxJobMinutes: state.maxJobMinutes,
        running: state.running,
        limit: state.hostedParallelJobs,
        blockWhenQuotaExhausted: state.blockWhenQuotaExhausted,
      }
    : null;
  const tr = (k: string, v?: Record<string, string | number>) =>
    t(`ci.azure.run.${k}`, v);
  const repo = detail.repoFullName;
  const capS = detail.maxJobMinutes * 60;
  const build = {
    id: r.id,
    buildNumber: r.buildNumber,
    definitionName: r.definitionName,
    status: r.status,
    result: r.result,
  };
  const tasksOf = (job: AzureJobDto) =>
    (tasks ?? []).filter((x) => x.jobRecordId === job.recordId);

  const JobRow = ({ job }: { job: AzureJobDto }) => {
    const share =
      job.durationS != null
        ? Math.min(1, job.durationS / Math.max(1, capS))
        : null;
    const jobTasks = tasksOf(job);
    return (
      <li className="flex flex-col gap-1.5 border-t py-2 first:border-t-0">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <AzureBuildBadge
            status={job.state === "completed" ? "COMPLETED" : job.state}
            result={job.result}
            timedOut={job.hitJobCap}
          />
          <span className="font-medium">{job.name}</span>
          {job.attempt > 1 ? (
            <span className="text-xs text-muted-foreground">
              {t("runs.attempt", { n: job.attempt })}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {[
              job.hostedImage ??
                (job.isHosted
                  ? tr("hosted")
                  : job.isHosted === false
                    ? tr("selfHosted")
                    : null),
              t(
                `ci.azure.settings.os.${job.os === "UNKNOWN" ? "UNKNOWN" : job.os}`,
              ),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="ml-auto text-xs tabular-nums">
            {formatDuration(job.durationS)}
          </span>
        </div>
        {share != null ? (
          <span className="flex items-center gap-2">
            <span
              role="meter"
              aria-label={tr("capMeter", {
                job: job.name,
                minutes: detail.maxJobMinutes,
              })}
              aria-valuemin={0}
              aria-valuemax={capS}
              aria-valuenow={job.durationS ?? 0}
              className="relative block h-1.5 w-40 overflow-hidden rounded-full bg-seq-1/40"
            >
              <span
                className={
                  job.hitJobCap ||
                  share >= (detail.maxJobMinutes - 10) / detail.maxJobMinutes
                    ? "absolute inset-y-0 left-0 rounded-full bg-status-warning"
                    : "absolute inset-y-0 left-0 rounded-full bg-seq-3"
                }
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            </span>
            <span className="text-xs text-muted-foreground">
              {job.hitJobCap
                ? tr("hitCap", { minutes: detail.maxJobMinutes })
                : tr("ofCap", { minutes: detail.maxJobMinutes })}
            </span>
          </span>
        ) : null}
        {jobTasks.length > 0 ? (
          <details>
            <summary className="w-fit cursor-pointer text-xs text-muted-foreground select-none">
              {tr("tasks", { count: jobTasks.length })}
            </summary>
            <ol className="mt-1 flex flex-col gap-0.5 text-xs">
              {jobTasks.map((x, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <AzureBuildBadge
                    status={x.state === "completed" ? "COMPLETED" : x.state}
                    result={
                      x.result
                        ? x.result
                            .replace(/[A-Z]/g, (c) => `_${c}`)
                            .toUpperCase()
                        : null
                    }
                  />
                  <span>{x.name}</span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {state?.canViewLog && job.hasLog ? (
          <AzureLogExcerpt
            installationId={String(installation.id)}
            buildId={r.id}
            recordId={job.recordId}
            attempt={job.attempt}
          />
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {open ? <AutoRefresh intervalMs={15_000} /> : null}
      <Breadcrumbs
        items={[
          { kind: "accounts" },
          { kind: "account", login },
          { kind: "section", login, section: "pipelines" },
          { kind: "pipelineSection", login, section: "runs" },
          { kind: "azureRun", login, id: r.id, number: r.buildNumber },
        ]}
      />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {r.definitionName} #{r.buildNumber}
            <SourceBadge provider="azure" />
            <AzureBuildBadge
              status={r.status}
              result={r.result}
              timedOut={r.timedOut}
            />
          </span>
        }
        subtitle={tr("subtitle", {
          reason: t(`ci.azure.reason.${r.reason}`),
          branch: r.headBranch ?? "—",
          when: format.dateTime(new Date(r.queuedAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
        actions={
          <a
            href={r.azureUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            {t("ci.azure.openInAzure")}
          </a>
        }
      />
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{tr("repo")}</dt>
        <dd>
          {repo ? (
            <Link
              href={repoHref(login, repo)}
              className="underline-offset-2 hover:underline"
            >
              {repo}
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-muted-foreground">{tr("commit")}</dt>
        <dd className="flex flex-wrap items-center gap-3">
          {r.headSha && repo ? (
            <a
              href={`https://github.com/${repo}/commit/${r.headSha}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs underline-offset-2 hover:underline"
            >
              <GitCommitHorizontal aria-hidden="true" className="size-3.5" />
              {r.headSha.slice(0, 7)}
            </a>
          ) : (
            <span className="font-mono text-xs">
              {r.headSha?.slice(0, 7) ?? "—"}
            </span>
          )}
          {r.prNumber != null && repo ? (
            <a
              href={`https://github.com/${repo}/pull/${r.prNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              <GitPullRequest aria-hidden="true" className="size-3.5" />
              {tr("pr", { number: r.prNumber })}
            </a>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">{tr("timing")}</dt>
        <dd>
          {tr("timingValue", {
            queue: formatDuration(r.queueS),
            duration: formatDuration(r.durationS),
            minutes: r.minutes ?? "—",
          })}
        </dd>
        {r.maxAttempt > 1 ? (
          <>
            <dt className="text-muted-foreground">{tr("attempts")}</dt>
            <dd>{tr("attemptsValue", { n: r.maxAttempt })}</dd>
          </>
        ) : null}
        {r.auditEntryId ? (
          <>
            <dt className="text-muted-foreground">{tr("audit")}</dt>
            <dd>
              <Link
                href={`/o/${encodeURIComponent(login)}/audit?entry=${encodeURIComponent(r.auditEntryId)}`}
                className="underline-offset-2 hover:underline"
              >
                {r.auditLinkKind === "probable"
                  ? t("ci.azure.auditLink.probable")
                  : t("ci.azure.auditLink.exact")}
              </Link>
            </dd>
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted-foreground">{tr("durationNote")}</p>
      <AzureBlockedNote blockedBy={state?.blockedBy ?? null} />
      {ctx ? <BuildActions ctx={ctx} build={build} /> : null}
      {detail.stages.length === 0 && detail.jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr("noTimeline")}</p>
      ) : null}
      {detail.stages.map((s) => (
        <section
          key={`${s.recordId}:${s.attempt}`}
          aria-label={tr("stage", { name: s.name })}
          className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">{s.name}</h2>
            <AzureBuildBadge
              status={s.state === "completed" ? "COMPLETED" : s.state}
              result={s.result}
            />
            {s.attempt > 1 ? (
              <span className="text-xs text-muted-foreground">
                {t("runs.attempt", { n: s.attempt })}
              </span>
            ) : null}
            <span className="ml-auto text-xs tabular-nums">
              {formatDuration(s.durationS)}
            </span>
            {ctx && s.identifier && stageRetryable(build, s) ? (
              <StageRetryButton
                ctx={ctx}
                build={build}
                stage={{ identifier: s.identifier, name: s.name }}
              />
            ) : null}
          </div>
          <ul className="flex flex-col">
            {s.jobs.map((j) => (
              <JobRow key={`${j.recordId}:${j.attempt}`} job={j} />
            ))}
          </ul>
        </section>
      ))}
      {detail.jobs.length > 0 ? (
        <section
          aria-label={tr("otherJobs")}
          className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground"
        >
          <h2 className="font-medium">{tr("otherJobs")}</h2>
          <ul className="flex flex-col">
            {detail.jobs.map((j) => (
              <JobRow key={`${j.recordId}:${j.attempt}`} job={j} />
            ))}
          </ul>
        </section>
      ) : null}
      {tasks === null && open ? (
        <p className="text-xs text-muted-foreground">
          {tr("tasksUnavailable")}
        </p>
      ) : null}
      {!state?.canViewLog ? (
        <p className="text-xs text-muted-foreground">
          {t("ci.azure.log.viewerNote")}
        </p>
      ) : null}
    </div>
  );
}
