import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import { RunStatusBadge } from "@/components/data/status-badge";
import { RunActions } from "@/components/management/run-actions";
import { formatDuration, shortSha } from "@/lib/format";
import type { RunListItem } from "@/server/data/insights";
import { runHref, workflowHref } from "./workflow-link";

/**
 * The run list of the repository's Runs tab and the workflow page (UI
 * overhaul §2.7): run number with attempt and commit, status badge,
 * workflow, the trigger (branch · event · actor) as one muted line,
 * duration and age. With `actions` (operators and admins while management
 * is on) each row gets re-run, re-run failed and cancel; force cancel lives
 * on the run page. Below `md` the trigger moves into the row expander.
 */
export async function RunsTable({
  accountLogin,
  runs,
  caption,
  showWorkflow = true,
  actions,
  now = new Date(),
}: {
  accountLogin: string;
  runs: ReadonlyArray<RunListItem>;
  caption: string;
  showWorkflow?: boolean;
  actions?: { installationId: string };
  now?: Date;
}) {
  const t = await getTranslations("runs");
  const format = await getFormatter();
  const columns: Column<RunListItem>[] = [
    {
      id: "run",
      label: t("run"),
      header: t("run"),
      className: "whitespace-normal",
      cell: (r) => (
        <div className="flex flex-col">
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <Link
              href={runHref(accountLogin, r.id)}
              className="font-medium underline-offset-2 hover:underline"
            >
              {r.runNumber != null ? `#${r.runNumber}` : r.id}
            </Link>
            {r.runAttempt > 1 ? (
              <span className="text-xs text-muted-foreground">
                {t("attempt", { n: r.runAttempt })}
              </span>
            ) : null}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {shortSha(r.headSha)}
          </span>
        </div>
      ),
    },
    {
      id: "status",
      label: t("status"),
      header: t("status"),
      cell: (r) => (
        <RunStatusBadge status={r.status} conclusion={r.conclusion} />
      ),
    },
    ...(showWorkflow
      ? [
          {
            id: "workflow",
            label: t("workflow"),
            header: t("workflow"),
            hideBelow: "sm" as const,
            className: "max-w-48 truncate",
            cell: (r: RunListItem) =>
              r.workflowId ? (
                <Link
                  href={workflowHref(
                    accountLogin,
                    r.repoFullName,
                    r.workflowId,
                  )}
                  className="underline-offset-2 hover:underline"
                >
                  {r.workflowName}
                </Link>
              ) : (
                r.workflowName
              ),
          } satisfies Column<RunListItem>,
        ]
      : []),
    {
      id: "trigger",
      label: t("trigger"),
      header: t("trigger"),
      hideBelow: "md",
      className: "max-w-64",
      cell: (r) => (
        <span className="flex min-w-0 flex-wrap gap-x-1.5 text-sm">
          <span className="max-w-40 truncate font-medium">
            {r.headBranch ?? "—"}
          </span>
          <span className="text-muted-foreground">
            {[r.event, r.actorLogin].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      id: "duration",
      label: t("duration"),
      header: t("duration"),
      align: "right",
      cell: (r) => formatDuration(r.durationS),
    },
    {
      id: "created",
      label: t("created"),
      header: t("created"),
      align: "right",
      hideBelow: "md",
      cell: (r) => (
        <time
          dateTime={r.createdAt}
          title={format.dateTime(new Date(r.createdAt), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          className="text-xs whitespace-nowrap text-muted-foreground"
        >
          {format.relativeTime(new Date(r.createdAt), now)}
        </time>
      ),
    },
    ...(actions
      ? [
          {
            id: "actions",
            label: t("actions"),
            header: t("actions"),
            hideBelow: "md" as const,
            cell: (r: RunListItem) => (
              <RunActions
                installationId={actions.installationId}
                compact
                run={{
                  id: r.id,
                  repoFullName: r.repoFullName,
                  workflowName: r.workflowName,
                  runNumber: r.runNumber,
                  runAttempt: r.runAttempt,
                  status: r.status,
                  conclusion: r.conclusion,
                  isPlaceholder: r.isPlaceholder,
                }}
              />
            ),
          } satisfies Column<RunListItem>,
        ]
      : []),
  ];
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={runs}
      rowKey={(r) => r.id}
      empty={<EmptyState quiet message={t("empty")} />}
    />
  );
}
