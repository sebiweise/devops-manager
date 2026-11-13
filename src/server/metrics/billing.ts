import { z } from "zod";
import type { SkuRateLike } from "./classify";
import { rateFor } from "./cost";

/**
 * GitHub enhanced billing usage (design §6.6) and the cost arithmetic on top
 * of it: parsing, SKU mapping, included vs used, month-end projection,
 * per-workflow attribution and the estimate-vs-billed reconciliation. Pure
 * functions; amounts are USD, quantities as reported by GitHub.
 *
 * Endpoint shapes are documented in docs/BILLING.md.
 */

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]);

const usageItem = z.object({
  date: z.string(),
  product: z.string(),
  sku: z.string(),
  quantity: num,
  unitType: z.string(),
  pricePerUnit: num,
  grossAmount: num,
  discountAmount: num,
  netAmount: num,
  organizationName: z.string().optional().nullable(),
  repositoryName: z.string().optional().nullable(),
});

const usageReport = z.object({ usageItems: z.array(z.unknown()) });

export type UsageItem = {
  /** "YYYY-MM-DD" (UTC). */
  date: string;
  /** Lowercase, e.g. "actions". */
  product: string;
  sku: string;
  /** "owner/name", or "" when the item has no repository. */
  repositoryFullName: string;
  unitType: string;
  quantity: number;
  pricePerUnit: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
};

export class BillingFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingFormatError";
  }
}

function dayOf(value: string): string | null {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  return Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`)) ? null : m[1]!;
}

/**
 * Parses `GET /organizations/{org}/settings/billing/usage` and
 * `GET /users/{username}/settings/billing/usage`. Items that do not match the
 * documented shape are skipped (and counted), so one odd row cannot drop a
 * whole month; a body without `usageItems` is a format error.
 */
export function parseUsageReport(body: unknown): {
  items: UsageItem[];
  skipped: number;
} {
  const report = usageReport.safeParse(body);
  if (!report.success)
    throw new BillingFormatError("billing usage response has no usageItems");
  const items: UsageItem[] = [];
  let skipped = 0;
  for (const raw of report.data.usageItems) {
    const parsed = usageItem.safeParse(raw);
    const date = parsed.success ? dayOf(parsed.data.date) : null;
    if (!parsed.success || !date) {
      skipped++;
      continue;
    }
    const v = parsed.data;
    const repo = (v.repositoryName ?? "").trim();
    items.push({
      date,
      product: v.product.trim().toLowerCase(),
      sku: v.sku.trim(),
      // The org report names the repository without its owner in some
      // responses; keep whatever GitHub sends, owner-qualified when it is.
      repositoryFullName:
        repo && !repo.includes("/") && v.organizationName
          ? `${v.organizationName}/${repo}`
          : repo,
      unitType: v.unitType.trim(),
      quantity: Number(v.quantity),
      pricePerUnit: Number(v.pricePerUnit),
      grossAmount: Number(v.grossAmount),
      discountAmount: Number(v.discountAmount),
      netAmount: Number(v.netAmount),
    });
  }
  return { items, skipped };
}

/** Sums items with the same (date, product, sku, repository): the table's key. */
export function aggregateUsageItems(
  items: ReadonlyArray<UsageItem>,
): UsageItem[] {
  const out = new Map<string, UsageItem>();
  for (const i of items) {
    const k = [i.date, i.product, i.sku, i.repositoryFullName].join("\u0000");
    const prev = out.get(k);
    if (!prev) {
      out.set(k, { ...i });
      continue;
    }
    prev.quantity += i.quantity;
    prev.grossAmount += i.grossAmount;
    prev.discountAmount += i.discountAmount;
    prev.netAmount += i.netAmount;
  }
  return [...out.values()];
}

export type MinuteItemLike = {
  product: string;
  unitType: string;
  sku: string;
  date: Date;
  quantity: unknown;
};

/**
 * Minutes counted against the included minutes: the billed quantity of the
 * Actions minute items times the runner type's minute multiplier on that
 * day (1 when the SKU is unknown). The start page card and the costs page
 * both use this, so they show the same "minutes used".
 */
export function includedMinutesUsed(
  items: ReadonlyArray<MinuteItemLike>,
  rates: ReadonlyArray<SkuRateLike>,
): number {
  let used = 0;
  for (const i of items) {
    if (!isActionsProduct(i.product) || !isMinutesUnit(i.unitType)) continue;
    const multiplier =
      rateFor(rates, skuKeyOf(i.sku), i.date)?.minuteMultiplier ?? 1;
    used += Number(i.quantity) * multiplier;
  }
  return used;
}

export function isActionsProduct(product: string): boolean {
  return product.trim().toLowerCase() === "actions";
}

export function isMinutesUnit(unitType: string): boolean {
  return /^minutes?$/i.test(unitType.trim());
}

/**
 * Maps a billing SKU to the SkuRate key used by the estimates:
 * "Actions Linux" -> "linux", "Actions macOS 3-core" -> "macos_3_core",
 * "actions_linux_4_core" -> "linux_4_core". The plain 2-core Linux/Windows
 * and 3-core macOS runners are the base SKUs.
 */
export function skuKeyOf(billingSku: string): string {
  const key = billingSku
    .trim()
    .toLowerCase()
    .replace(/^actions[\s_-]+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const base: Record<string, string> = {
    linux_2_core: "linux",
    windows_2_core: "windows",
    macos_3_core: "macos",
  };
  return base[key] ?? key;
}

// ---------- included vs used, projection ----------

/** Included Actions minutes per month by plan (editable via Installation.includedMinutes). */
export const PLAN_INCLUDED_MINUTES: Record<string, number> = {
  free: 2_000,
  pro: 3_000,
  team: 3_000,
  enterprise: 50_000,
};

export function includedMinutes(
  override: number | null | undefined,
  planName: string | null | undefined,
): number {
  if (override != null) return override;
  const plan = (planName ?? "free").trim().toLowerCase();
  for (const [name, minutes] of Object.entries(PLAN_INCLUDED_MINUTES))
    if (plan.startsWith(name)) return minutes;
  return PLAN_INCLUDED_MINUTES.free!;
}

/** Days in a month (month 1..12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * MTD + (MTD / elapsedDays) × remainingDays. A past month projects to its
 * total; a month that has not started projects to 0.
 */
export function projectMonth(
  mtd: number,
  elapsedDays: number,
  totalDays: number,
): number {
  if (elapsedDays <= 0) return 0;
  if (elapsedDays >= totalDays) return mtd;
  return mtd + (mtd / elapsedDays) * (totalDays - elapsedDays);
}

/** Days of `year-month` elapsed at `now` (UTC; partial today counts as one). */
export function elapsedDays(year: number, month: number, now: Date): number {
  const start = Date.UTC(year, month - 1, 1);
  const total = daysInMonth(year, month);
  if (now.getTime() < start) return 0;
  const days = Math.floor((now.getTime() - start) / 86_400_000) + 1;
  return Math.min(total, days);
}

// ---------- attribution and reconciliation ----------

export type WorkflowEstimate = {
  repositoryFullName: string;
  sku: string;
  workflowId: bigint;
  /** Estimated raw minutes of the workflow's jobs on this SKU. */
  estMin: number;
  estUsd: number;
};

export type BilledCell = {
  repositoryFullName: string;
  sku: string;
  quantity: number;
  grossAmount: number;
  netAmount: number;
};

export type AttributedWorkflow = WorkflowEstimate & {
  /** billed(repo, sku) / Σ estMin(repo, sku); null when nothing was billed for the cell. */
  scale: number | null;
  /** estMin × scale (billed minutes attributed to the workflow). */
  scaledMin: number | null;
  /** The cell's net amount, split by estMin share. */
  scaledNetUsd: number | null;
};

/**
 * Per-workflow attribution (labelled "estimated, scaled"):
 * estMin(workflow) × billed(repo, sku, month) / Σ estMin(repo, sku, month).
 * `estimates` and `billed` use the same SKU keys (see `skuKeyOf`).
 */
export function attributeToWorkflows(
  estimates: ReadonlyArray<WorkflowEstimate>,
  billed: ReadonlyArray<BilledCell>,
): AttributedWorkflow[] {
  const cell = (repo: string, sku: string) => `${repo}\u0000${sku}`;
  const totals = new Map<string, number>();
  for (const e of estimates) {
    const k = cell(e.repositoryFullName, e.sku);
    totals.set(k, (totals.get(k) ?? 0) + e.estMin);
  }
  const bill = new Map<string, BilledCell>();
  for (const b of billed) {
    const k = cell(b.repositoryFullName, b.sku);
    const prev = bill.get(k);
    bill.set(
      k,
      prev
        ? {
            ...prev,
            quantity: prev.quantity + b.quantity,
            grossAmount: prev.grossAmount + b.grossAmount,
            netAmount: prev.netAmount + b.netAmount,
          }
        : { ...b },
    );
  }
  return estimates.map((e) => {
    const k = cell(e.repositoryFullName, e.sku);
    const total = totals.get(k) ?? 0;
    const b = bill.get(k);
    if (!b || total <= 0)
      return { ...e, scale: null, scaledMin: null, scaledNetUsd: null };
    const scale = b.quantity / total;
    return {
      ...e,
      scale,
      scaledMin: e.estMin * scale,
      scaledNetUsd: b.netAmount * (e.estMin / total),
    };
  });
}

/** Deviation above which estimate vs billed is flagged (usually an unknown larger-runner SKU). */
export const RECONCILE_TOLERANCE = 0.15;

export type ReconcileRow = {
  repositoryFullName: string;
  sku: string;
  estUsd: number;
  billedGrossUsd: number;
  estMin: number;
  billedQuantity: number;
  /** (est - billed) / billed on gross USD; null when nothing was billed. */
  deviation: number | null;
  flagged: boolean;
};

/**
 * Estimate vs billed per repository and SKU, on gross USD (the list price
 * before the included-minutes discount, which is what the estimate models).
 * A cell is flagged when the deviation exceeds 15%, or when one side is zero
 * and the other is not.
 */
export function reconcileEstimates(
  estimates: ReadonlyArray<{
    repositoryFullName: string;
    sku: string;
    estMin: number;
    estUsd: number;
  }>,
  billed: ReadonlyArray<BilledCell>,
): ReconcileRow[] {
  const rows = new Map<string, ReconcileRow>();
  const row = (repositoryFullName: string, sku: string) => {
    const k = `${repositoryFullName}\u0000${sku}`;
    let r = rows.get(k);
    if (!r) {
      r = {
        repositoryFullName,
        sku,
        estUsd: 0,
        billedGrossUsd: 0,
        estMin: 0,
        billedQuantity: 0,
        deviation: null,
        flagged: false,
      };
      rows.set(k, r);
    }
    return r;
  };
  for (const e of estimates) {
    const r = row(e.repositoryFullName, e.sku);
    r.estUsd += e.estUsd;
    r.estMin += e.estMin;
  }
  for (const b of billed) {
    const r = row(b.repositoryFullName, b.sku);
    r.billedGrossUsd += b.grossAmount;
    r.billedQuantity += b.quantity;
  }
  for (const r of rows.values()) {
    if (r.billedGrossUsd > 0) {
      r.deviation = (r.estUsd - r.billedGrossUsd) / r.billedGrossUsd;
      r.flagged = Math.abs(r.deviation) > RECONCILE_TOLERANCE;
    } else {
      r.flagged = r.estUsd > 0.005;
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.repositoryFullName.localeCompare(b.repositoryFullName) ||
      a.sku.localeCompare(b.sku),
  );
}
