import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/insights/auto-refresh";
import { runHref } from "@/components/insights/workflow-link";
import { LabelList, QueueFlagBadges } from "@/components/runners/runner-badges";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { loadAccount, orNotFound } from "@/lib/account-page";
import { formatDuration, formatNumber } from "@/lib/format";
import { lazyRunnerSample } from "@/lib/runner-sample";
import { getLiveQueue } from "@/server/data/runners";
import { accountMeta } from "@/lib/page-meta";

export const generateMetadata = accountMeta("queue");

/**
 * Live queue (design §7 /queue): queued jobs grouped by labels and
 * repository with STUCK and no-matching-runner flags, and environment
 * approvals in their own section. Opening the page schedules a lazy runner
 * sample (so STUCK reflects fresh runner state within one refresh); the page
 * refreshes every 30 s.
 */
export default async function QueuePage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const { scope, installation } = await loadAccount(account);
  const sampling = await lazyRunnerSample(installation.id);
  const [t, locale, format, queue] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    orNotFound(getLiveQueue(scope, installation.id)),
  ]);
  const login = installation.accountLogin;
  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("queue.title")}</h1>
        <p className="text-xs text-muted-foreground">
          <time dateTime={queue.at}>
            {t("queue.updated", {
              time: format.dateTime(new Date(queue.at), {
                timeStyle: "medium",
              }),
            })}
          </time>
        </p>
      </div>
      {sampling ? (
        <p className="text-xs text-muted-foreground">{t("runners.sampling")}</p>
      ) : null}

      {queue.jobs.length === 0 ? (
        <p className="text-muted-foreground">{t("queue.empty")}</p>
      ) : (
        <>
          <p
            className={
              queue.stuck > 0 ? "font-medium text-destructive" : undefined
            }
          >
            {t("queue.summary", {
              count: queue.jobs.length,
              oldest: formatDuration(queue.oldestAgeS),
              stuck: queue.stuck,
            })}
          </p>
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            <li>
              <span className="font-medium">{t("runnerData.stuck")}</span>:{" "}
              {t("runnerData.stuckHint")}
            </li>
            <li>
              <span className="font-medium">
                {t("runnerData.noMatchingRunner")}
              </span>
              : {t("runnerData.noMatchingRunnerHint")}
            </li>
          </ul>

          <section className="flex flex-col gap-2">
            <h2 className="font-medium">{t("queue.groups")}</h2>
            <Table>
              <caption className="sr-only">{t("queue.groups")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("queue.labels")}</TableHead>
                  <TableHead>{t("queue.repo")}</TableHead>
                  <TableHead className="text-right">
                    {t("queue.count")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("queue.oldest")}
                  </TableHead>
                  <TableHead className="text-right">{t("queue.p95")}</TableHead>
                  <TableHead>{t("queue.workflows")}</TableHead>
                  <TableHead>{t("queue.flags")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.groups.map((g) => (
                  <TableRow
                    key={`${g.labelKey}|${g.repositoryId}`}
                    className={g.stuck > 0 ? "bg-destructive/5" : undefined}
                  >
                    <TableCell className="max-w-64">
                      <LabelList labels={g.labels} />
                    </TableCell>
                    <TableCell className="text-sm">{g.repoFullName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(g.count, locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(g.oldestAgeS)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(g.p95AgeS)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {g.workflows.join(", ")}
                    </TableCell>
                    <TableCell>
                      <QueueFlagBadges
                        stuck={g.stuck}
                        noMatchingRunner={g.noMatchingRunner}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="font-medium">{t("queue.jobs")}</h2>
            <Table>
              <caption className="sr-only">{t("queue.jobs")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("queue.job")}</TableHead>
                  <TableHead>{t("queue.repo")}</TableHead>
                  <TableHead>{t("queue.labels")}</TableHead>
                  <TableHead className="text-right">{t("queue.age")}</TableHead>
                  <TableHead>{t("queue.flags")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.jobs.map((j) => (
                  <TableRow
                    key={j.jobId}
                    className={j.stuck ? "bg-destructive/5" : undefined}
                  >
                    <TableCell>
                      <Link
                        href={runHref(login, j.runId)}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {j.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {j.workflowName}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{j.repoFullName}</TableCell>
                    <TableCell className="max-w-64">
                      <LabelList labels={j.labels} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(j.ageS)}
                    </TableCell>
                    <TableCell>
                      <QueueFlagBadges
                        stuck={j.stuck}
                        noMatchingRunner={j.noMatchingRunner}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t("queue.approvals.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("queue.approvals.description")}
        </p>
        {queue.approvals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("queue.approvals.empty")}
          </p>
        ) : (
          <Table>
            <caption className="sr-only">{t("queue.approvals.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("queue.job")}</TableHead>
                <TableHead>{t("queue.repo")}</TableHead>
                <TableHead className="text-right">{t("queue.age")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.approvals.map((j) => (
                <TableRow key={j.jobId}>
                  <TableCell>
                    <Link
                      href={runHref(login, j.runId)}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {j.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {j.workflowName}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{j.repoFullName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(j.ageS)}
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
