import type { AuditAction, AuditStatus } from "@/generated/prisma/client";
import type { AuditFilter } from "@/server/data/audit";
import { param, type SearchParams } from "./insights-view";

/**
 * Search params of the audit page and its CSV export (design §7 /audit):
 * app user, action, repo, status, batch and a date range. Anything that
 * does not parse is ignored, so a hand-edited URL never errors.
 */

export const AUDIT_ACTIONS = [
  "RUN_RERUN",
  "RUN_RERUN_FAILED",
  "RUN_CANCEL",
  "RUN_FORCE_CANCEL",
  "VAR_CREATE",
  "VAR_UPDATE",
  "VAR_DELETE",
  "VAR_BULK",
  "VAR_BULK_REVERT",
  "ORG_VAR_CREATE",
  "ORG_VAR_UPDATE",
  "ORG_VAR_DELETE",
  "PR_MERGE",
  "PR_BULK_MERGE",
  "SYNC_NOW",
  "MANAGEMENT_TOGGLE",
  "SETTINGS_UPDATE",
  "DATA_PURGE",
  "DELIVERY_REPLAY",
  "ROLE_UPDATE",
  "USER_DISABLE",
  "USER_ENABLE",
  "SKU_RATE_UPDATE",
  "BILLING_CREDENTIAL_SET",
  "BILLING_CREDENTIAL_CONNECT",
  "BILLING_CREDENTIAL_REVOKE",
  "REPO_IGNORE",
  "REPO_UNIGNORE",
  "VERCEL_CONNECT",
  "VERCEL_TOKEN_ROTATE",
  "VERCEL_DISCONNECT",
  "VERCEL_PROJECT_LINK",
] as const satisfies readonly AuditAction[];

export const AUDIT_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "DENIED",
  "PENDING",
] as const satisfies readonly AuditStatus[];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function day(value: string | undefined, plusDays = 0): Date | undefined {
  if (!value || !DAY.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d;
}

export type AuditQuery = {
  filter: AuditFilter;
  /** The raw, valid values (for the form and links). */
  values: {
    actor?: string;
    action?: string;
    repo?: string;
    status?: string;
    batch?: string;
    from?: string;
    to?: string;
  };
  /** `instance`: the instance-level chain (admins only). */
  chain: "installation" | "instance";
  before?: string;
};

export function parseAuditQuery(sp: SearchParams): AuditQuery {
  const actor = param(sp, "actor");
  const action = param(sp, "action");
  const repo = param(sp, "repo");
  const status = param(sp, "status");
  const batch = param(sp, "batch");
  const from = param(sp, "from");
  const to = param(sp, "to");
  const before = param(sp, "before");
  const values: AuditQuery["values"] = {};
  const filter: AuditFilter = {};
  if (actor && USER_ID.test(actor)) {
    values.actor = actor;
    filter.actorUserId = actor;
  }
  if (action && (AUDIT_ACTIONS as readonly string[]).includes(action)) {
    values.action = action;
    filter.action = action as AuditAction;
  }
  if (repo && /^\d{1,20}$/.test(repo)) {
    values.repo = repo;
    filter.repositoryId = BigInt(repo);
  }
  if (status && (AUDIT_STATUSES as readonly string[]).includes(status)) {
    values.status = status;
    filter.status = status as AuditStatus;
  }
  if (batch && UUID.test(batch)) {
    values.batch = batch;
    filter.batchId = batch;
  }
  const fromDate = day(from);
  if (fromDate) {
    values.from = from;
    filter.from = fromDate;
  }
  // `to` is inclusive in the form: the filter ends at the next midnight.
  const toDate = day(to, 1);
  if (toDate) {
    values.to = to;
    filter.to = toDate;
  }
  return {
    filter,
    values,
    chain: param(sp, "chain") === "instance" ? "instance" : "installation",
    ...(before && /^\d{1,20}$/.test(before) ? { before } : {}),
  };
}
