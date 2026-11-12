import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { RunActions } from "@/components/management/run-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDuration, shortSha } from "@/lib/format";
import type { RunListItem } from "@/server/data/insights";
import { StatusBadge } from "./status-badge";
import { runHref } from "./workflow-link";

/**
 * Paginated run list (repo detail and workflow pages). With `actions` (only
 * passed for operators and admins while management is on) each row gets
 * re-run, re-run failed and cancel; force cancel lives on the run page.
 */
export async function RunsTable({
  accountLogin,
  runs,
  caption,
  showWorkflow = true,
  actions,
}: {
  accountLogin: string;
  runs: ReadonlyArray<RunListItem>;
  caption: string;
  showWorkflow?: boolean;
  actions?: { installationId: string };
}) {
  const t = await getTranslations("runs");
  const format = await getFormatter();
  if (runs.length === 0)
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>{t("run")}</TableHead>
          {showWorkflow ? <TableHead>{t("workflow")}</TableHead> : null}
          <TableHead>{t("status")}</TableHead>
          <TableHead>{t("branch")}</TableHead>
          <TableHead>{t("event")}</TableHead>
          <TableHead>{t("actor")}</TableHead>
          <TableHead className="text-right">{t("duration")}</TableHead>
          <TableHead className="text-right">{t("created")}</TableHead>
          {actions ? <TableHead>{t("actions")}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link
                href={runHref(accountLogin, r.id)}
                className="font-medium underline-offset-2 hover:underline"
              >
                {r.runNumber != null ? `#${r.runNumber}` : r.id}
              </Link>
              {r.runAttempt > 1 ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  {t("attempt", { n: r.runAttempt })}
                </span>
              ) : null}
              <div className="font-mono text-xs text-muted-foreground">
                {shortSha(r.headSha)}
              </div>
            </TableCell>
            {showWorkflow ? (
              <TableCell className="max-w-48 truncate">
                {r.workflowName}
              </TableCell>
            ) : null}
            <TableCell>
              <StatusBadge status={r.status} conclusion={r.conclusion} />
            </TableCell>
            <TableCell className="max-w-40 truncate">
              {r.headBranch ?? "—"}
            </TableCell>
            <TableCell>{r.event ?? "—"}</TableCell>
            <TableCell>{r.actorLogin ?? "—"}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatDuration(r.durationS)}
            </TableCell>
            <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
              <time dateTime={r.createdAt}>
                {format.dateTime(new Date(r.createdAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </TableCell>
            {actions ? (
              <TableCell>
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
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
