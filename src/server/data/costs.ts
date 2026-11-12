import "server-only";
import type { TenantScope } from "@/server/authz/scope";
import { hasRole } from "@/server/authz/roles";
import { db } from "@/server/db";
import { syncedBillingMonths } from "@/server/ingest/billing";
import { loadSkuRates } from "@/server/ingest/sku-rates";
import {
  attributeToWorkflows,
  daysInMonth,
  elapsedDays,
  includedMinutes,
  isActionsProduct,
  isMinutesUnit,
  projectMonth,
  reconcileEstimates,
  skuKeyOf,
  type BilledCell,
  type ReconcileRow,
  type WorkflowEstimate,
} from "@/server/metrics/billing";
import type { SkuRateLike } from "@/server/metrics/classify";
import { rateFor } from "@/server/metrics/cost";
import { visibleInstallation } from "./insights";

/**
 * Costs and minutes for the UI (design §6.6, §7 /costs). All roles may read
 * them. Billed figures come from BillingUsageItem (enhanced billing usage,
 * synced daily); estimates are recomputed from the job rows with the current
 * SkuRate table, so a changed rate shows up without a deploy. Without billed
 * data the page shows estimates only, with the reason.
 *
 * Months are calendar months in UTC, like GitHub's billing report.
 */

export type CostSource = "billed" | "estimate";

/** Why only estimates are shown. */
export type EstimateReason =
  | "no_permission"
  | "no_credential"
  | "unavailable"
  | "credential_error"
  | "not_synced";

export type CostMonth = { year: number; month: number };

export type SkuCost = {
  /** The billing SKU as GitHub names it, or the estimate SKU when not billed. */
  sku: string;
  /** SkuRate key ("linux", "macos", "linux_4_core"). */
  skuKey: string;
  minuteMultiplier: number | null;
  billedQuantity: number;
  unitType: string | null;
  grossUsd: number;
  discountUsd: number;
  netUsd: number;
  estMin: number;
  estUsd: number;
};

export type Costs = {
  month: string;
  source: CostSource;
  reason: EstimateReason | null;
  /** Admins only: the stored billing error (never a token) and whether to reconnect. */
  adminNotice: { error: string | null; reconnect: boolean } | null;
  syncedAt: string | null;
  totals: {
    /** Actions only. */
    netUsd: number;
    grossUsd: number;
    discountUsd: number;
    /** All products of the billing report (Actions, storage, Packages, Copilot ...). */
    netUsdAllProducts: number;
    estUsd: number;
    estMin: number;
  };
  included: {
    included: number;
    /** Multiplied minutes counted against the included quota. */
    used: number;
    usedSource: CostSource;
    projectedUsed: number;
    projectedNetUsd: number;
    elapsedDays: number;
    daysInMonth: number;
  };
  bySku: SkuCost[];
  byRepo: Array<{
    repositoryFullName: string;
    billedQuantity: number;
    grossUsd: number;
    netUsd: number;
    estMin: number;
    estUsd: number;
  }>;
  byDay: Array<{
    day: string;
    billedQuantity: number;
    netUsd: number;
    estMin: number;
    estUsd: number;
  }>;
  /** Estimated minutes per workflow, scaled to the billed figures ("estimated, scaled"). */
  byWorkflow: Array<{
    workflowId: string;
    workflowName: string;
    repositoryFullName: string;
    sku: string;
    estMin: number;
    estUsd: number;
    scale: number | null;
    scaledMin: number | null;
    scaledNetUsd: number | null;
  }>;
  reconciliation: ReconcileRow[];
  /** Larger or unknown runners without a SKU match: excluded from the estimates. */
  unmatchedJobs: number;
};

export function parseMonth(
  value: string | null | undefined,
  now: Date,
): CostMonth {
  const m = (value ?? "").match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month >= 1 && month <= 12 && year >= 2000 && year <= 2100)
      return { year, month };
  }
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

type EstRow = {
  repositoryFullName: string;
  private: boolean;
  runnerKind: "GITHUB_HOSTED" | "LARGER_HOSTED";
  sku: string;
  workflowId: bigint | null;
  workflowName: string;
  day: string;
  rawMin: number;
};

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Estimated raw minutes and USD per (repo, sku, workflow, day), with the current SkuRates. */
async function estimates(
  installationId: bigint,
  from: Date,
  to: Date,
  rates: ReadonlyArray<SkuRateLike>,
) {
  const rows = await db.$queryRaw<EstRow[]>`
    SELECT r."fullName" AS "repositoryFullName", r."private",
      j."runnerKind"::text AS "runnerKind", j."sku", j."workflowId",
      max(j."workflowName") AS "workflowName",
      to_char((COALESCE(j."startedAt", j."createdAt") AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
      sum(ceil(j."durationS" / 60.0))::int AS "rawMin"
    FROM "WorkflowJob" j JOIN "Repository" r ON r."id" = j."repositoryId"
    WHERE j."installationId" = ${installationId} AND r."installationId" = ${installationId}
      AND j."statusRank" = 4 AND j."durationS" IS NOT NULL AND j."sku" IS NOT NULL
      AND j."runnerKind" IN ('GITHUB_HOSTED', 'LARGER_HOSTED')
      AND COALESCE(j."startedAt", j."createdAt") >= ${from}
      AND COALESCE(j."startedAt", j."createdAt") < ${to}
    GROUP BY 1, 2, 3, 4, 5, 7`;
  const out: Array<
    EstRow & { estUsd: number; billableMin: number; multiplier: number }
  > = [];
  for (const r of rows) {
    // Standard hosted runners are free for public repositories.
    if (r.runnerKind === "GITHUB_HOSTED" && !r.private) continue;
    const rate = rateFor(rates, r.sku, new Date(`${r.day}T00:00:00.000Z`));
    if (!rate) continue;
    out.push({
      ...r,
      estUsd: r.rawMin * rate.pricePerMinuteUsd,
      billableMin: Math.round(r.rawMin * rate.minuteMultiplier),
      multiplier: rate.minuteMultiplier,
    });
  }
  const [unmatched] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "WorkflowJob" j
    WHERE j."installationId" = ${installationId} AND j."statusRank" = 4
      AND j."runnerKind" IN ('LARGER_HOSTED', 'UNKNOWN') AND j."sku" IS NULL
      AND COALESCE(j."startedAt", j."createdAt") >= ${from}
      AND COALESCE(j."startedAt", j."createdAt") < ${to}`;
  return { rows: out, unmatched: unmatched?.n ?? 0 };
}

export async function getCosts(
  scope: TenantScope,
  installationId: bigint,
  month?: CostMonth,
  now: Date = new Date(),
): Promise<Costs> {
  await visibleInstallation(scope, installationId);
  const m = month ?? parseMonth(null, now);
  const from = new Date(Date.UTC(m.year, m.month - 1, 1));
  const to = new Date(Date.UTC(m.year, m.month, 1));
  const label = `${m.year}-${String(m.month).padStart(2, "0")}`;

  const [inst, credential, items, rates, synced] = await Promise.all([
    db.installation.findUniqueOrThrow({
      where: { id: installationId },
      select: {
        accountType: true,
        planName: true,
        includedMinutes: true,
        billingStatus: true,
        billingError: true,
        billingSyncedAt: true,
      },
    }),
    db.gitHubCredential.findUnique({
      where: { installationId },
      select: { revokedAt: true, lastError: true, accessToken: true },
    }),
    db.billingUsageItem.findMany({
      where: { installationId, date: { gte: from, lt: to } },
    }),
    loadSkuRates(),
    syncedBillingMonths(installationId),
  ]);
  const est = await estimates(installationId, from, to, rates);

  const actions = items.filter((i) => isActionsProduct(i.product));
  const minuteItems = actions.filter((i) => isMinutesUnit(i.unitType));
  // A month the billing API answered for is billed, even with no items
  // (only self-hosted or public-repo usage, or nothing used yet): $0.
  const source: CostSource =
    items.length > 0 || synced.has(label) ? "billed" : "estimate";
  let reason: EstimateReason | null = null;
  if (source === "estimate") {
    const s = inst.billingStatus;
    reason =
      s === "no_permission" ||
      s === "no_credential" ||
      s === "unavailable" ||
      s === "credential_error"
        ? s
        : "not_synced";
  }

  const n = (v: unknown) => Number(v);
  const multiplierOf = (skuKey: string, day: Date) =>
    rateFor(rates, skuKey, day)?.minuteMultiplier ?? null;

  // ---- by SKU
  const bySku = new Map<string, SkuCost>();
  const skuRow = (sku: string, skuKey: string) => {
    let r = bySku.get(skuKey);
    if (!r) {
      r = {
        sku,
        skuKey,
        minuteMultiplier: multiplierOf(skuKey, from),
        billedQuantity: 0,
        unitType: null,
        grossUsd: 0,
        discountUsd: 0,
        netUsd: 0,
        estMin: 0,
        estUsd: 0,
      };
      bySku.set(skuKey, r);
    }
    return r;
  };
  for (const i of actions) {
    const r = skuRow(i.sku, skuKeyOf(i.sku));
    r.sku = i.sku;
    r.unitType = i.unitType;
    r.billedQuantity += n(i.quantity);
    r.grossUsd += n(i.grossAmount);
    r.discountUsd += n(i.discountAmount);
    r.netUsd += n(i.netAmount);
  }
  for (const e of est.rows) {
    const r = skuRow(e.sku, e.sku);
    r.estMin += e.rawMin;
    r.estUsd += e.estUsd;
  }

  // ---- by repo and day
  const byRepo = new Map<string, Costs["byRepo"][number]>();
  const repoRow = (name: string) => {
    let r = byRepo.get(name);
    if (!r) {
      r = {
        repositoryFullName: name,
        billedQuantity: 0,
        grossUsd: 0,
        netUsd: 0,
        estMin: 0,
        estUsd: 0,
      };
      byRepo.set(name, r);
    }
    return r;
  };
  const byDay = new Map<string, Costs["byDay"][number]>();
  for (let d = 1; d <= daysInMonth(m.year, m.month); d++) {
    const day = `${label}-${String(d).padStart(2, "0")}`;
    byDay.set(day, { day, billedQuantity: 0, netUsd: 0, estMin: 0, estUsd: 0 });
  }
  for (const i of actions) {
    const r = repoRow(i.repositoryFullName);
    r.grossUsd += n(i.grossAmount);
    r.netUsd += n(i.netAmount);
    const d = byDay.get(i.date.toISOString().slice(0, 10));
    if (d) d.netUsd += n(i.netAmount);
    if (isMinutesUnit(i.unitType)) {
      r.billedQuantity += n(i.quantity);
      if (d) d.billedQuantity += n(i.quantity);
    }
  }
  for (const e of est.rows) {
    const r = repoRow(e.repositoryFullName);
    r.estMin += e.rawMin;
    r.estUsd += e.estUsd;
    const d = byDay.get(e.day);
    if (d) {
      d.estMin += e.rawMin;
      d.estUsd += e.estUsd;
    }
  }

  // ---- attribution and reconciliation (per repo and SKU key)
  const billed: BilledCell[] = minuteItems.map((i) => ({
    repositoryFullName: i.repositoryFullName,
    sku: skuKeyOf(i.sku),
    quantity: n(i.quantity),
    grossAmount: n(i.grossAmount),
    netAmount: n(i.netAmount),
  }));
  const perWorkflow = new Map<string, WorkflowEstimate & { name: string }>();
  for (const e of est.rows) {
    if (e.workflowId == null) continue;
    const k = `${e.repositoryFullName}\u0000${e.sku}\u0000${e.workflowId}`;
    const w = perWorkflow.get(k) ?? {
      repositoryFullName: e.repositoryFullName,
      sku: e.sku,
      workflowId: e.workflowId,
      estMin: 0,
      estUsd: 0,
      name: e.workflowName,
    };
    w.estMin += e.rawMin;
    w.estUsd += e.estUsd;
    perWorkflow.set(k, w);
  }
  const names = new Map(
    [...perWorkflow.values()].map((w) => [String(w.workflowId), w.name]),
  );
  const attributed = attributeToWorkflows([...perWorkflow.values()], billed);

  // ---- included vs used, projection
  const included = includedMinutes(inst.includedMinutes, inst.planName);
  const usedBilled = minuteItems.reduce(
    (s, i) => s + n(i.quantity) * (multiplierOf(skuKeyOf(i.sku), i.date) ?? 1),
    0,
  );
  const usedEst = est.rows.reduce((s, e) => s + e.billableMin, 0);
  const used = source === "billed" ? usedBilled : usedEst;
  const elapsed = elapsedDays(m.year, m.month, now);
  const total = daysInMonth(m.year, m.month);
  const netUsd = actions.reduce((s, i) => s + n(i.netAmount), 0);
  const estUsd = est.rows.reduce((s, e) => s + e.estUsd, 0);

  const isAdmin = hasRole(scope.role, "ADMIN");
  const reconnect =
    inst.accountType === "USER" &&
    !!credential &&
    (credential.revokedAt != null || credential.accessToken == null);

  return {
    month: label,
    source,
    reason,
    adminNotice: isAdmin
      ? {
          error: inst.billingError ?? credential?.lastError ?? null,
          reconnect: reconnect || inst.billingStatus === "credential_error",
        }
      : null,
    syncedAt: inst.billingSyncedAt?.toISOString() ?? null,
    totals: {
      netUsd: r4(netUsd),
      grossUsd: r4(actions.reduce((s, i) => s + n(i.grossAmount), 0)),
      discountUsd: r4(actions.reduce((s, i) => s + n(i.discountAmount), 0)),
      netUsdAllProducts: r4(items.reduce((s, i) => s + n(i.netAmount), 0)),
      estUsd: r4(estUsd),
      estMin: est.rows.reduce((s, e) => s + e.rawMin, 0),
    },
    included: {
      included,
      used: Math.round(used),
      usedSource: source,
      projectedUsed: Math.round(projectMonth(used, elapsed, total)),
      projectedNetUsd: r4(
        projectMonth(source === "billed" ? netUsd : estUsd, elapsed, total),
      ),
      elapsedDays: elapsed,
      daysInMonth: total,
    },
    bySku: [...bySku.values()]
      .map((r) => ({
        ...r,
        grossUsd: r4(r.grossUsd),
        discountUsd: r4(r.discountUsd),
        netUsd: r4(r.netUsd),
        estUsd: r4(r.estUsd),
      }))
      .sort((a, b) => b.netUsd - a.netUsd || b.estUsd - a.estUsd),
    byRepo: [...byRepo.values()]
      .map((r) => ({
        ...r,
        grossUsd: r4(r.grossUsd),
        netUsd: r4(r.netUsd),
        estUsd: r4(r.estUsd),
      }))
      .sort((a, b) => b.netUsd - a.netUsd || b.estUsd - a.estUsd),
    byDay: [...byDay.values()].map((d) => ({
      ...d,
      netUsd: r4(d.netUsd),
      estUsd: r4(d.estUsd),
    })),
    byWorkflow: attributed
      .map((a) => ({
        workflowId: String(a.workflowId),
        workflowName: names.get(String(a.workflowId)) ?? "",
        repositoryFullName: a.repositoryFullName,
        sku: a.sku,
        estMin: a.estMin,
        estUsd: r4(a.estUsd),
        scale: a.scale,
        scaledMin: a.scaledMin,
        scaledNetUsd: a.scaledNetUsd == null ? null : r4(a.scaledNetUsd),
      }))
      .sort((a, b) => b.estMin - a.estMin),
    reconciliation:
      source === "billed"
        ? reconcileEstimates(
            est.rows.map((e) => ({
              repositoryFullName: e.repositoryFullName,
              sku: e.sku,
              estMin: e.rawMin,
              estUsd: e.estUsd,
            })),
            billed,
          )
        : [],
    unmatchedJobs: est.unmatched,
  };
}
