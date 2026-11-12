import "server-only";
import { db } from "@/server/db";
import { PermissionNotGrantedError } from "@/server/github/purposes";
import {
  aggregateUsageItems,
  BillingFormatError,
  parseUsageReport,
  type UsageItem,
} from "@/server/metrics/billing";
import { DeadlineReached, RateLimited, type Deadline } from "./budget";
import {
  billingTokenFor,
  credentialDepsFromEnv,
  recordCredentialUse,
  type CredentialDeps,
} from "./billing-credential";
import {
  errorStatus,
  withDeadline,
  type GitHubApi,
  type GitHubClients,
} from "./github-client";
import { redactError } from "./webhook";

/**
 * Reconcile step h, billing (design §5.3 h, §6.6). Once a day per
 * installation the current month (and the previous one on days 1-3) is read
 * from GitHub's enhanced billing usage report into BillingUsageItem. A month
 * is replaced as a whole in one transaction, so a re-sync never double-counts.
 *
 * - Organisations: installation token `sync.billing` (Organization
 *   "Administration: read"), `GET /organizations/{org}/settings/billing/usage`.
 * - Personal accounts: the optional billing credential (env token, stored PAT
 *   or "Connect GitHub" user-to-server token, refreshed on demand),
 *   `GET /users/{username}/settings/billing/usage`.
 *
 * Without the permission or a credential the step records the status and the
 * costs page shows estimates only; that is not an error.
 */

export const BILLING_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type BillingStatus =
  "ok" | "no_permission" | "no_credential" | "unavailable" | "credential_error";

export type BillingResult = {
  status: BillingStatus | "not_due";
  months: string[];
  items: number;
  error?: string;
};

export type BillingInstallation = {
  id: bigint;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  permissions: Record<string, unknown>;
  billingSyncedAt: Date | null;
};

/** "YYYY-MM" months to sync at `now`: the current one, plus the previous one on days 1-3. */
export function monthsToSync(
  now: Date,
): Array<{ year: number; month: number }> {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const out = [{ year, month }];
  if (now.getUTCDate() <= 3)
    out.unshift(
      month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 },
    );
  return out;
}

const monthKey = (m: { year: number; month: number }) =>
  `${m.year}-${String(m.month).padStart(2, "0")}`;

const syncedKey = (installationId: bigint) =>
  `billing-months:${installationId}`;
/** Synced months remembered per installation (two years of history). */
const SYNCED_MONTHS_KEPT = 24;

/**
 * "YYYY-MM" months whose usage report was read successfully at least once.
 * A synced month without items is billed at $0, not "not synced yet".
 */
export async function syncedBillingMonths(
  installationId: bigint,
): Promise<Set<string>> {
  const row = await db.appState.findUnique({
    where: { key: syncedKey(installationId) },
  });
  const months = (row?.value as { months?: unknown } | undefined)?.months;
  return new Set(
    Array.isArray(months)
      ? months.filter((m): m is string => typeof m === "string")
      : [],
  );
}

async function recordSyncedMonths(
  installationId: bigint,
  months: ReadonlyArray<string>,
): Promise<void> {
  if (months.length === 0) return;
  const key = syncedKey(installationId);
  const all = [
    ...new Set([...(await syncedBillingMonths(installationId)), ...months]),
  ]
    .sort()
    .slice(-SYNCED_MONTHS_KEPT);
  const value = { months: all };
  await db.appState.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/** Replaces the stored items of one month with `items`. */
export async function storeUsageMonth(
  installationId: bigint,
  m: { year: number; month: number },
  items: ReadonlyArray<UsageItem>,
  fetchedAt: Date,
): Promise<number> {
  const from = new Date(Date.UTC(m.year, m.month - 1, 1));
  const to = new Date(Date.UTC(m.year, m.month, 1));
  const prefix = monthKey(m);
  const rows = aggregateUsageItems(
    items.filter((i) => i.date.startsWith(prefix)),
  );
  await db.$transaction([
    db.billingUsageItem.deleteMany({
      where: { installationId, date: { gte: from, lt: to } },
    }),
    db.billingUsageItem.createMany({
      data: rows.map((i) => ({
        installationId,
        date: new Date(`${i.date}T00:00:00.000Z`),
        product: i.product,
        sku: i.sku,
        repositoryFullName: i.repositoryFullName,
        unitType: i.unitType,
        quantity: i.quantity,
        pricePerUnit: i.pricePerUnit,
        grossAmount: i.grossAmount,
        discountAmount: i.discountAmount,
        netAmount: i.netAmount,
        fetchedAt,
      })),
    }),
  ]);
  return rows.length;
}

async function setStatus(
  installationId: bigint,
  status: BillingStatus,
  error: string | null,
  at: Date | null,
) {
  await db.installation.updateMany({
    where: { id: installationId },
    data: {
      billingStatus: status,
      billingError: error,
      // A transient failure (5xx, timeout) leaves the sync due for the next tick.
      ...(at ? { billingSyncedAt: at } : {}),
    },
  });
}

async function fetchMonths(
  api: GitHubApi,
  route: string,
  params: Record<string, unknown>,
  installationId: bigint,
  now: Date,
): Promise<{ months: string[]; items: number }> {
  const months: string[] = [];
  let count = 0;
  for (const m of monthsToSync(now)) {
    const res = await api.request<unknown>(route, {
      ...params,
      year: m.year,
      month: m.month,
    });
    const { items } = parseUsageReport(res.data);
    count += await storeUsageMonth(installationId, m, items, now);
    months.push(monthKey(m));
  }
  await recordSyncedMonths(installationId, months);
  return { months, items: count };
}

/**
 * Syncs billing for one installation when due (`force` for the admin's
 * on-demand refresh). Never throws for GitHub-side refusals; deadline and
 * rate-limit stops propagate like in the other steps.
 */
export async function syncBilling(
  inst: BillingInstallation,
  clients: GitHubClients,
  deadline: Deadline,
  opts: { force?: boolean; credentials?: CredentialDeps } = {},
): Promise<BillingResult> {
  const now = new Date(deadline.now());
  if (
    !opts.force &&
    inst.billingSyncedAt &&
    now.getTime() - inst.billingSyncedAt.getTime() < BILLING_INTERVAL_MS
  ) {
    return { status: "not_due", months: [], items: 0 };
  }

  let api: GitHubApi;
  let route: string;
  let params: Record<string, unknown>;
  let stored = false;
  if (inst.accountType === "ORGANIZATION") {
    try {
      api = await clients.installation(
        inst.id,
        "sync.billing",
        inst.permissions,
      );
    } catch (error) {
      if (!(error instanceof PermissionNotGrantedError)) throw error;
      await setStatus(inst.id, "no_permission", null, now);
      return { status: "no_permission", months: [], items: 0 };
    }
    route = "GET /organizations/{org}/settings/billing/usage";
    params = { org: inst.accountLogin };
  } else {
    const token = await billingTokenFor(
      inst.id,
      opts.credentials ?? credentialDepsFromEnv(),
    );
    if (token.kind === "none" || !clients.user) {
      await setStatus(inst.id, "no_credential", null, now);
      return { status: "no_credential", months: [], items: 0 };
    }
    if (token.kind === "reconnect") {
      await setStatus(inst.id, "credential_error", token.reason, now);
      return {
        status: "credential_error",
        months: [],
        items: 0,
        error: token.reason,
      };
    }
    stored = token.source !== "env";
    api = clients.user(token.token);
    route = "GET /users/{username}/settings/billing/usage";
    params = { username: inst.accountLogin };
  }

  try {
    const { months, items } = await fetchMonths(
      withDeadline(api, deadline),
      route,
      params,
      inst.id,
      now,
    );
    await setStatus(inst.id, "ok", null, now);
    if (stored) await recordCredentialUse(inst.id, { ok: true }, now);
    return { status: "ok", months, items };
  } catch (error) {
    if (error instanceof DeadlineReached || error instanceof RateLimited)
      throw error;
    const status = errorStatus(error);
    const message =
      error instanceof BillingFormatError
        ? error.message
        : `GitHub answered ${status ?? "with an error"}`;
    const credentialProblem = inst.accountType === "USER" && status === 401;
    const result: BillingStatus = credentialProblem
      ? "credential_error"
      : "unavailable";
    const transient = status == null || status >= 500;
    await setStatus(
      inst.id,
      result,
      redactError(message, 200),
      transient ? null : now,
    );
    if (stored)
      await recordCredentialUse(inst.id, { ok: false, error: message }, now);
    return { status: result, months: [], items: 0, error: message };
  }
}
