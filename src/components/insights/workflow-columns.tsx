import Link from "next/link";
import type { getTranslations } from "next-intl/server";
import { Sparkline } from "@/components/charts/sparkline";
import type { Column } from "@/components/data/data-table";
import { StatusBadge } from "@/components/data/status-badge";
import {
  approx,
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { enoughData } from "@/lib/insights-view";
import type { WorkflowStat } from "@/server/data/insights";
import { repoHref, workflowHref } from "./workflow-link";

type T = Awaited<ReturnType<typeof getTranslations>>;

/**
 * Columns of the workflow tables (UI overhaul §2.5): the account-wide
 * Workflows page (with the repository as a secondary line) and a
 * repository's Workflows tab. Every numeric column is sortable and gets a
 * magnitude bar while it is the sort column; badges carry regressions and
 * success drops with their definition.
 */
export function workflowColumns({
  t,
  locale,
  login,
  rows,
  showRepo,
  rangeLabel,
}: {
  t: T;
  locale: string;
  login: string;
  rows: ReadonlyArray<WorkflowStat>;
  showRepo: boolean;
  rangeLabel: string;
}): Column<WorkflowStat>[] {
  const max = (f: (w: WorkflowStat) => number | null) =>
    Math.max(1e-9, ...rows.map((w) => f(w) ?? 0));
  const runsMax = max((w) => w.summary.runs);
  const p50Max = max((w) => (enoughData(w.summary.n) ? w.summary.p50 : 0));
  const p95Max = max((w) => (enoughData(w.summary.n) ? w.summary.p95 : 0));
  const minMax = max((w) => w.billableMinEst);
  const flakyMax = max((w) => w.summary.flakyRate);
  const twoLine = (name: string, sub: string) => (
    <span className="inline-flex flex-col leading-tight">
      <span>{name}</span>
      <span className="text-xs font-normal text-muted-foreground">{sub}</span>
    </span>
  );
  const pct = (w: WorkflowStat, v: number | null) =>
    enoughData(w.summary.n) ? (
      approx(formatDuration(v), w.summary.approx)
    ) : (
      <span
        title={t("common.notEnoughData")}
        className="text-xs text-muted-foreground"
      >
        {t("workflows.fewRuns")}
      </span>
    );
  return [
    {
      id: "name",
      label: t("workflows.workflow"),
      header: t("workflows.workflow"),
      sortKey: "name",
      className: "whitespace-normal",
      cell: (w) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <Link
              href={workflowHref(login, w.repoFullName, w.workflowId)}
              className="font-medium underline-offset-2 hover:underline"
            >
              {w.workflowName || w.workflowId}
            </Link>
            {w.regression ? (
              <StatusBadge
                kind="regression"
                label={t("workflows.regressionBadge", {
                  metric: w.regression.metric,
                })}
              />
            ) : null}
            {w.successDrop ? <StatusBadge kind="successDrop" /> : null}
          </span>
          {showRepo ? (
            <Link
              href={repoHref(login, w.repoFullName)}
              className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {w.repoFullName.split("/").pop()}
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      id: "runs",
      label: t("workflows.runs"),
      header: twoLine(t("workflows.runs"), rangeLabel),
      sortKey: "runs",
      align: "right",
      magnitude: (w) => w.summary.runs / runsMax,
      cell: (w) => formatNumber(w.summary.runs, locale),
    },
    {
      id: "success",
      label: t("workflows.success"),
      header: twoLine(t("workflows.success"), rangeLabel),
      sortKey: "success",
      align: "right",
      magnitude: (w) => w.summary.successRate,
      cell: (w) => formatPercent(w.summary.successRate, locale),
    },
    {
      id: "flaky",
      label: t("workflows.flaky"),
      header: twoLine(t("workflows.flaky"), t("workflows.flakySub")),
      sortKey: "flaky",
      align: "right",
      hideBelow: "lg",
      magnitude: (w) => (w.summary.flakyRate ?? 0) / flakyMax,
      cell: (w) =>
        w.summary.flakyRate ? (
          formatPercent(w.summary.flakyRate, locale)
        ) : (
          <span className="text-muted-foreground">
            {formatPercent(w.summary.flakyRate ?? 0, locale)}
          </span>
        ),
    },
    {
      id: "p50",
      label: t("charts.p50"),
      header: twoLine(t("workflows.p50Short"), t("workflows.p50Sub")),
      sortKey: "p50",
      align: "right",
      hideBelow: "md",
      magnitude: (w) =>
        enoughData(w.summary.n) ? (w.summary.p50 ?? 0) / p50Max : null,
      cell: (w) => pct(w, w.summary.p50),
    },
    {
      id: "p95",
      label: t("charts.p95"),
      header: twoLine(t("workflows.p95Short"), t("workflows.p95Sub")),
      sortKey: "p95",
      align: "right",
      hideBelow: "md",
      magnitude: (w) =>
        enoughData(w.summary.n) ? (w.summary.p95 ?? 0) / p95Max : null,
      cell: (w) => pct(w, w.summary.p95),
    },
    {
      id: "minutes",
      label: t("charts.minutes"),
      header: twoLine(t("charts.minutes"), rangeLabel),
      sortKey: "minutes",
      align: "right",
      hideBelow: "lg",
      magnitude: (w) => w.billableMinEst / minMax,
      cell: (w) => formatMinutes(w.billableMinEst, locale),
    },
    {
      id: "trend",
      label: t("repos.trend"),
      header: twoLine(t("repos.colTrend"), t("repos.colTrendWindow")),
      hideBelow: "lg",
      cell: (w) => {
        const runs = w.sparkline.reduce((s, p) => s + p.runs, 0);
        const failures = w.sparkline.reduce((s, p) => s + p.failures, 0);
        return (
          <Sparkline
            id={`wf-spark-${w.workflowId}`}
            label={t("charts.sparkTitle", { runs, failures })}
            points={w.sparkline}
          />
        );
      },
    },
  ];
}
