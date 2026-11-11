import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Sparkline } from "@/components/charts/sparkline";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { enoughData } from "@/lib/insights-view";
import type { WorkflowStat } from "@/server/data/insights";
import { workflowHref } from "./workflow-link";

/** Workflows of a repository: success, p50/p95, sparkline, badges. */
export async function WorkflowsTable({
  accountLogin,
  stats,
  caption,
}: {
  accountLogin: string;
  stats: ReadonlyArray<WorkflowStat>;
  caption: string;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (stats.length === 0)
    return (
      <p className="text-sm text-muted-foreground">{t("workflows.empty")}</p>
    );
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>{t("workflows.workflow")}</TableHead>
          <TableHead className="text-right">{t("workflows.runs")}</TableHead>
          <TableHead className="text-right">{t("workflows.success")}</TableHead>
          <TableHead className="text-right">{t("charts.p50")}</TableHead>
          <TableHead className="text-right">{t("charts.p95")}</TableHead>
          <TableHead className="text-right">{t("charts.minutes")}</TableHead>
          <TableHead>{t("repos.trend")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stats.map((w) => {
          const s = w.summary;
          const enough = enoughData(s.n);
          const runs = w.sparkline.reduce((sum, p) => sum + p.runs, 0);
          const failures = w.sparkline.reduce((sum, p) => sum + p.failures, 0);
          return (
            <TableRow key={w.workflowId}>
              <TableCell>
                <Link
                  href={workflowHref(
                    accountLogin,
                    w.repoFullName,
                    w.workflowId,
                  )}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {w.workflowName || w.workflowId}
                </Link>
                {w.regression ? (
                  <Badge variant="destructive" className="ml-2">
                    {t("workflows.regressionBadge", {
                      metric: w.regression.metric,
                    })}
                  </Badge>
                ) : null}
                {w.successDrop ? (
                  <Badge variant="outline" className="ml-2">
                    {t("workflows.successDropBadge")}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(s.runs, locale)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(s.successRate, locale)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {enough
                  ? approx(formatDuration(s.p50), s.approx)
                  : t("common.notEnoughData")}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {enough
                  ? approx(formatDuration(s.p95), s.approx)
                  : t("common.notEnoughData")}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMinutes(w.billableMinEst, locale)}
              </TableCell>
              <TableCell>
                <Sparkline
                  id={`wf-spark-${w.workflowId}`}
                  label={t("repos.sparkline", { runs, failures })}
                  points={w.sparkline}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
