import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { TenantScope } from "@/server/authz/scope";
import { db } from "@/server/db";
import { notIgnoredRepo } from "@/server/ingest/active-repos";
import { isActionsProduct, isMinutesUnit } from "@/server/metrics/billing";
import { includedMinutes } from "@/server/metrics/billing";
import { daysBetween, localDay } from "@/server/metrics/days";
import { successRate, trendDelta } from "@/server/metrics/stats";
import { listInstallations } from "./installations";

/**
 * The start page's account cards (UI overhaul §2.1, §4.2): one round-trip
 * per metric, grouped by installation, from the daily rollups and counts
 * only (no live GitHub read). Ignored repositories are left out of every
 * figure except the "ignored" count.
 */

const DAY_MS = 86_400_000;
const STUCK_MS = 15 * 60 * 1000;

export type AccountSummary = {
  installationId: string;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  lastWebhookAt: string | null;
  lastReconciledAt: string | null;
  runs7d: number;
  successRate7d: number | null;
  /** Success rate of the last 7 days minus the 7 days before. */
  successDelta: number | null;
  queuedNow: number;
  /** Self-hosted jobs queued for more than 15 minutes (likely stuck). */
  queuedLong: number;
  minutes: {
    used: number;
    included: number;
    source: "billed" | "estimate";
  };
  repositories: number;
  ignored: number;
  runnersOffline: number;
  failingWorkflows: number;
  /** Up to 3 workflows with the most failures in the last 7 days. */
  attention: Array<{
    workflowId: string;
    workflowName: string;
    repoFullName: string;
    failures: number;
  }>;
  /** Runs per day, last 14 days (UTC days), oldest first. */
  sparkline: Array<{ day: string; runs: number; failures: number }>;
};

type ByInst<T> = Map<bigint, T>;
const byInst = <T extends { installationId: bigint }>(
  rows: T[],
): ByInst<T[]> => {
  const m = new Map<bigint, T[]>();
  for (const r of rows)
    m.set(r.installationId, [...(m.get(r.installationId) ?? []), r]);
  return m;
};

export async function getAccountSummaries(
  scope: TenantScope,
  now: Date = new Date(),
): Promise<AccountSummary[]> {
  const installations = await listInstallations(scope);
  if (installations.length === 0) return [];
  const ids = installations.map((i) => i.id);
  const inIds = Prisma.join(ids);
  const day = (offset: number) =>
    localDay(new Date(now.getTime() - offset * DAY_MS), "UTC");
  const today = day(0);
  const from7 = day(6);
  const from14 = day(13);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [
    windows,
    spark,
    queued,
    repos,
    runners,
    attention,
    billed,
    estimated,
    meta,
  ] = await Promise.all([
    db.$queryRaw<
      Array<{
        installationId: bigint;
        recent: boolean;
        runs: number;
        success: number;
        failure: number;
      }>
    >`
        SELECT s."installationId", s."day" >= ${from7}::date AS recent,
          sum(s."runs")::int AS runs, sum(s."success")::int AS success,
          sum(s."failure")::int AS failure
        FROM "DailyWorkflowStat" s
        WHERE s."installationId" IN (${inIds}) AND s."day" >= ${from14}::date
          AND s."day" <= ${today}::date AND ${notIgnoredRepo("s")}
        GROUP BY 1, 2`,
    db.$queryRaw<
      Array<{
        installationId: bigint;
        day: string;
        runs: number;
        failures: number;
      }>
    >`
        SELECT s."installationId", to_char(s."day", 'YYYY-MM-DD') AS day,
          sum(s."runs")::int AS runs, sum(s."failure")::int AS failures
        FROM "DailyWorkflowStat" s
        WHERE s."installationId" IN (${inIds}) AND s."day" >= ${from14}::date
          AND ${notIgnoredRepo("s")}
        GROUP BY 1, 2`,
    db.$queryRaw<
      Array<{ installationId: bigint; queued: number; long: number }>
    >`
        SELECT j."installationId", count(*)::int AS queued,
          count(*) FILTER (WHERE j."runnerKind" = 'SELF_HOSTED'
            AND j."createdAt" < ${new Date(now.getTime() - STUCK_MS)})::int AS long
        FROM "WorkflowJob" j
        WHERE j."installationId" IN (${inIds}) AND j."status" = 'QUEUED'
          AND ${notIgnoredRepo("j")}
        GROUP BY 1`,
    db.$queryRaw<
      Array<{ installationId: bigint; active: number; ignored: number }>
    >`
        SELECT r."installationId",
          count(*) FILTER (WHERE r."ignoredAt" IS NULL)::int AS active,
          count(*) FILTER (WHERE r."ignoredAt" IS NOT NULL)::int AS ignored
        FROM "Repository" r
        WHERE r."installationId" IN (${inIds}) AND r."removedAt" IS NULL
        GROUP BY 1`,
    db.$queryRaw<Array<{ installationId: bigint; offline: number }>>`
        SELECT u."installationId", count(*)::int AS offline
        FROM "Runner" u
        WHERE u."installationId" IN (${inIds}) AND u."removedAt" IS NULL AND NOT u."online"
          AND (u."repositoryId" IS NULL OR ${notIgnoredRepo("u")})
        GROUP BY 1`,
    db.$queryRaw<
      Array<{
        installationId: bigint;
        workflowId: bigint;
        workflowName: string;
        repoFullName: string;
        failures: number;
      }>
    >`
        SELECT s."installationId", s."workflowId", max(s."workflowName") AS "workflowName",
          max(r."fullName") AS "repoFullName", sum(s."failure")::int AS failures
        FROM "DailyWorkflowStat" s JOIN "Repository" r ON r."id" = s."repositoryId"
        WHERE s."installationId" IN (${inIds}) AND s."day" >= ${from7}::date
          AND r."ignoredAt" IS NULL AND s."workflowId" <> 0
        GROUP BY 1, 2
        HAVING sum(s."failure") > 0
        ORDER BY 5 DESC, 3 ASC`,
    db.billingUsageItem.findMany({
      where: {
        installationId: { in: ids },
        date: { gte: new Date(`${monthStart}T00:00:00.000Z`) },
      },
      select: {
        installationId: true,
        product: true,
        unitType: true,
        quantity: true,
      },
    }),
    db.$queryRaw<Array<{ installationId: bigint; minutes: number }>>`
        SELECT s."installationId", sum(s."billableMinEst")::int AS minutes
        FROM "DailyWorkflowStat" s
        WHERE s."installationId" IN (${inIds}) AND s."day" >= ${monthStart}::date
          AND ${notIgnoredRepo("s")}
        GROUP BY 1`,
    db.installation.findMany({
      where: { id: { in: ids } },
      select: { id: true, includedMinutes: true, planName: true },
    }),
  ]);

  const w = byInst(windows);
  const sp = byInst(spark);
  const q = byInst(queued);
  const rp = byInst(repos);
  const rn = byInst(runners);
  const at = byInst(attention);
  const est = byInst(estimated);
  const metaBy = new Map(meta.map((m) => [m.id, m]));
  const billedBy = new Map<bigint, number>();
  const hasBilling = new Set<bigint>();
  for (const b of billed) {
    hasBilling.add(b.installationId);
    if (isActionsProduct(b.product) && isMinutesUnit(b.unitType))
      billedBy.set(
        b.installationId,
        (billedBy.get(b.installationId) ?? 0) + Number(b.quantity),
      );
  }
  const days = daysBetween(from14, today).slice(-14);

  return installations.map((inst) => {
    const win = w.get(inst.id) ?? [];
    const recent = win.find((x) => x.recent) ?? {
      runs: 0,
      success: 0,
      failure: 0,
    };
    const prev = win.find((x) => !x.recent) ?? {
      runs: 0,
      success: 0,
      failure: 0,
    };
    const sparkBy = new Map((sp.get(inst.id) ?? []).map((p) => [p.day, p]));
    const m = metaBy.get(inst.id);
    const att = at.get(inst.id) ?? [];
    const billedSource = hasBilling.has(inst.id);
    return {
      installationId: String(inst.id),
      accountLogin: inst.accountLogin,
      accountType: inst.accountType,
      lastWebhookAt: inst.lastWebhookAt?.toISOString() ?? null,
      lastReconciledAt: inst.lastReconciledAt?.toISOString() ?? null,
      runs7d: recent.runs,
      successRate7d: successRate(recent),
      successDelta: trendDelta(successRate(recent), successRate(prev)),
      queuedNow: q.get(inst.id)?.[0]?.queued ?? 0,
      queuedLong: q.get(inst.id)?.[0]?.long ?? 0,
      minutes: {
        used: Math.round(
          billedSource
            ? (billedBy.get(inst.id) ?? 0)
            : (est.get(inst.id)?.[0]?.minutes ?? 0),
        ),
        included: includedMinutes(
          m?.includedMinutes ?? null,
          m?.planName ?? null,
        ),
        source: billedSource ? "billed" : "estimate",
      },
      repositories: rp.get(inst.id)?.[0]?.active ?? 0,
      ignored: rp.get(inst.id)?.[0]?.ignored ?? 0,
      runnersOffline: rn.get(inst.id)?.[0]?.offline ?? 0,
      failingWorkflows: att.length,
      attention: att.slice(0, 3).map((a) => ({
        workflowId: String(a.workflowId),
        workflowName: a.workflowName,
        repoFullName: a.repoFullName,
        failures: a.failures,
      })),
      sparkline: days.map((d) => ({
        day: d,
        runs: sparkBy.get(d)?.runs ?? 0,
        failures: sparkBy.get(d)?.failures ?? 0,
      })),
    };
  });
}
