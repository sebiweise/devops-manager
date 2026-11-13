import "server-only";
import type {
  AuditAction,
  AuditStatus,
  Prisma,
} from "@/generated/prisma/client";
import { verifyAuditChain } from "@/server/audit/log";
import type { ChainVerification } from "@/server/audit/chain";
import type { TenantScope } from "@/server/authz/scope";
import { hasRole } from "@/server/authz/roles";
import { db } from "@/server/db";
import { inScope, NotFoundError } from "./installations";

/**
 * Audit log reads for the UI (design §7 /audit, §8.2 "Visibility of audit
 * entries"). Every role sees the chain of every visible installation; the
 * instance-level chain (installation 0: roles, SkuRate, billing
 * credentials) is visible to admins only. Params are sanitised: a redacted
 * variable value shows only its sha256 and length, never its sealed copy.
 */

/** The instance-level chain. */
export const INSTANCE_CHAIN = 0n;

function assertChainVisible(scope: TenantScope, chain: bigint) {
  if (chain === INSTANCE_CHAIN) {
    if (!hasRole(scope.role, "ADMIN")) throw new NotFoundError();
    return;
  }
  if (!inScope(scope, chain)) throw new NotFoundError();
}

export type AuditFilter = {
  actorUserId?: string;
  action?: AuditAction;
  repositoryId?: bigint;
  status?: AuditStatus;
  batchId?: string;
  /** One entry (e.g. "created by audit entry" on a deployment). */
  id?: string;
  from?: Date;
  to?: Date;
};

export type AuditEntryDto = {
  id: string;
  seq: string;
  createdAt: string;
  completedAt: string | null;
  actorUserId: string;
  actorDisplay: string;
  actorRole: string;
  actorProvider: string;
  actingAs: string | null;
  action: AuditAction;
  status: AuditStatus;
  repositoryId: string | null;
  repoFullName: string | null;
  targetType: string;
  targetId: string;
  batchId: string | null;
  params: unknown;
  confirmation: string;
  httpStatus: number | null;
  githubRequestId: string | null;
  error: string | null;
};

/** Replaces sealed variable values by `{redacted, sha256, length}`. */
export function sanitiseParams(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitiseParams);
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if ("sealed" in obj)
      return { redacted: true, sha256: obj.sha256, length: obj.length };
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, sanitiseParams(v)]),
    );
  }
  return value;
}

function whereOf(
  chain: bigint,
  filter: AuditFilter,
): Prisma.AuditLogWhereInput {
  return {
    installationId: chain,
    ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.repositoryId ? { repositoryId: filter.repositoryId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.batchId ? { batchId: filter.batchId } : {}),
    ...(filter.id ? { id: filter.id } : {}),
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lt: filter.to } : {}),
          },
        }
      : {}),
  };
}

const ENTRY_SELECT = {
  id: true,
  seq: true,
  createdAt: true,
  completedAt: true,
  actorUserId: true,
  actorDisplay: true,
  actorRole: true,
  actorProvider: true,
  actingAs: true,
  action: true,
  status: true,
  repositoryId: true,
  repoFullName: true,
  targetType: true,
  targetId: true,
  batchId: true,
  params: true,
  confirmation: true,
  httpStatus: true,
  githubRequestId: true,
  error: true,
} as const;

type EntryRow = Prisma.AuditLogGetPayload<{ select: typeof ENTRY_SELECT }>;

function toDto(r: EntryRow): AuditEntryDto {
  return {
    id: r.id,
    seq: r.seq.toString(),
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    actorUserId: r.actorUserId,
    actorDisplay: r.actorDisplay,
    actorRole: r.actorRole,
    actorProvider: r.actorProvider,
    actingAs: r.actingAs,
    action: r.action,
    status: r.status,
    repositoryId: r.repositoryId?.toString() ?? null,
    repoFullName: r.repoFullName,
    targetType: r.targetType,
    targetId: r.targetId,
    batchId: r.batchId,
    params: sanitiseParams(r.params),
    confirmation: r.confirmation,
    httpStatus: r.httpStatus,
    githubRequestId: r.githubRequestId,
    error: r.error,
  };
}

export type AuditPage = {
  entries: AuditEntryDto[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextBefore: string | null;
};

/** Newest first, paged by `seq`. */
export async function listAuditEntries(
  scope: TenantScope,
  chain: bigint,
  filter: AuditFilter = {},
  page: { before?: string; limit?: number } = {},
): Promise<AuditPage> {
  assertChainVisible(scope, chain);
  const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
  const before =
    page.before && /^\d{1,20}$/.test(page.before) ? BigInt(page.before) : null;
  const rows = await db.auditLog.findMany({
    where: {
      ...whereOf(chain, filter),
      ...(before !== null ? { seq: { lt: before } } : {}),
    },
    orderBy: { seq: "desc" },
    take: limit + 1,
    select: ENTRY_SELECT,
  });
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map(toDto);
  return {
    entries,
    nextBefore: more ? entries[entries.length - 1]!.seq : null,
  };
}

/** Verify button: recomputes the whole chain of a visible installation. */
export async function verifyAuditLog(
  scope: TenantScope,
  chain: bigint,
): Promise<ChainVerification> {
  assertChainVisible(scope, chain);
  return verifyAuditChain(chain);
}

const CSV_MAX_ROWS = 10_000;
const CSV_COLUMNS = [
  "seq",
  "createdAt",
  "completedAt",
  "actorDisplay",
  "actorRole",
  "actorProvider",
  "actingAs",
  "action",
  "status",
  "repoFullName",
  "targetType",
  "targetId",
  "batchId",
  "confirmation",
  "httpStatus",
  "githubRequestId",
  "error",
  "params",
] as const;

/** One CSV cell; values that a spreadsheet would run as a formula are prefixed with '. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export of the filtered chain (oldest first, at most 10,000 rows). */
export async function auditCsv(
  scope: TenantScope,
  chain: bigint,
  filter: AuditFilter = {},
): Promise<string> {
  assertChainVisible(scope, chain);
  const rows = await db.auditLog.findMany({
    where: whereOf(chain, filter),
    orderBy: { seq: "asc" },
    take: CSV_MAX_ROWS,
    select: ENTRY_SELECT,
  });
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const dto = toDto(row) as unknown as Record<string, unknown>;
    lines.push(CSV_COLUMNS.map((c) => csvCell(dto[c])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ---------- variable batches ----------

export type BatchChild = {
  auditId: string;
  action: AuditAction;
  status: AuditStatus;
  repositoryId: string | null;
  repoFullName: string | null;
  /** Raw params (sealed values included): server-side use only. */
  params: Record<string, unknown>;
  httpStatus: number | null;
  error: string | null;
};

export type BatchRecord = {
  parent: {
    auditId: string;
    action: AuditAction;
    status: AuditStatus;
    batchId: string;
    targetId: string;
    params: Record<string, unknown>;
    createdAt: Date;
  };
  children: BatchChild[];
};

/**
 * A bulk batch (parent plus children) of a visible installation, with raw
 * params. Server-side only (revert and replay); never send it to a client.
 */
export async function findBatch(
  scope: TenantScope,
  installationId: bigint,
  batchId: string,
): Promise<BatchRecord> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const rows = await db.auditLog.findMany({
    where: { installationId, batchId },
    orderBy: { seq: "asc" },
    select: {
      id: true,
      action: true,
      status: true,
      batchId: true,
      targetType: true,
      targetId: true,
      repositoryId: true,
      repoFullName: true,
      params: true,
      httpStatus: true,
      error: true,
      createdAt: true,
    },
  });
  const parent = rows.find((r) => r.targetType === "batch");
  if (!parent) throw new NotFoundError();
  return {
    parent: {
      auditId: parent.id,
      action: parent.action,
      status: parent.status,
      batchId,
      targetId: parent.targetId,
      params: (parent.params ?? {}) as Record<string, unknown>,
      createdAt: parent.createdAt,
    },
    children: rows
      .filter((r) => r !== parent)
      .map((r) => ({
        auditId: r.id,
        action: r.action,
        status: r.status,
        repositoryId: r.repositoryId?.toString() ?? null,
        repoFullName: r.repoFullName,
        params: (r.params ?? {}) as Record<string, unknown>,
        httpStatus: r.httpStatus,
        error: r.error,
      })),
  };
}

/** The batch id of the bulk action an audit row started, if it is one. */
export async function batchIdOfAudit(
  scope: TenantScope,
  installationId: bigint,
  auditId: string,
): Promise<string> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const row = await db.auditLog.findFirst({
    where: { id: auditId, installationId, targetType: "batch" },
    select: { batchId: true },
  });
  if (!row?.batchId) throw new NotFoundError();
  return row.batchId;
}

/** The revert of a batch that succeeded or is running, if any. */
export async function findBatchRevert(
  installationId: bigint,
  batchId: string,
): Promise<{
  auditId: string;
  status: AuditStatus;
  idempotencyKey: string;
} | null> {
  const row = await db.auditLog.findFirst({
    where: {
      installationId,
      action: "VAR_BULK_REVERT",
      targetType: "batch",
      targetId: batchId,
      status: { in: ["PENDING", "SUCCEEDED"] },
    },
    orderBy: { seq: "desc" },
    select: { id: true, status: true, idempotencyKey: true },
  });
  return row
    ? {
        auditId: row.id,
        status: row.status,
        idempotencyKey: row.idempotencyKey,
      }
    : null;
}

export type VariableBatchSummary = {
  auditId: string;
  batchId: string;
  action: "VAR_BULK" | "VAR_BULK_REVERT";
  status: AuditStatus;
  createdAt: string;
  actorDisplay: string;
  name: string | null;
  /** For a revert: the batch it reverted. */
  revertOf: string | null;
  succeeded: number;
  failed: number;
  /** The revert of this batch, when there is one. */
  revertedBy: string | null;
};

/** Batch history for the variables page (newest first). */
export async function listVariableBatches(
  scope: TenantScope,
  installationId: bigint,
  limit = 20,
): Promise<VariableBatchSummary[]> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const parents = await db.auditLog.findMany({
    where: {
      installationId,
      action: { in: ["VAR_BULK", "VAR_BULK_REVERT"] },
      targetType: "batch",
    },
    orderBy: { seq: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    select: {
      id: true,
      batchId: true,
      action: true,
      status: true,
      createdAt: true,
      actorDisplay: true,
      targetId: true,
      params: true,
    },
  });
  const batchIds = parents
    .map((p) => p.batchId)
    .filter((b): b is string => !!b);
  const counts = batchIds.length
    ? await db.auditLog.groupBy({
        by: ["batchId", "status"],
        where: {
          installationId,
          batchId: { in: batchIds },
          targetType: "variable",
        },
        _count: { _all: true },
      })
    : [];
  const reverts = batchIds.length
    ? await db.auditLog.findMany({
        where: {
          installationId,
          action: "VAR_BULK_REVERT",
          targetType: "batch",
          targetId: { in: batchIds },
          status: { in: ["PENDING", "SUCCEEDED"] },
        },
        select: { id: true, targetId: true },
      })
    : [];
  const revertedBy = new Map(reverts.map((r) => [r.targetId, r.id]));
  return parents.map((p) => {
    const params = (p.params ?? {}) as Record<string, unknown>;
    const of = (status: AuditStatus) =>
      counts.find((c) => c.batchId === p.batchId && c.status === status)?._count
        ._all ?? 0;
    return {
      auditId: p.id,
      batchId: p.batchId ?? "",
      action: p.action as "VAR_BULK" | "VAR_BULK_REVERT",
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      actorDisplay: p.actorDisplay,
      name: typeof params.name === "string" ? params.name : null,
      revertOf: p.action === "VAR_BULK_REVERT" ? p.targetId : null,
      succeeded: of("SUCCEEDED"),
      failed: of("FAILED"),
      revertedBy: p.batchId ? (revertedBy.get(p.batchId) ?? null) : null,
    };
  });
}

/** When the latest successful cancel of a run completed (force-cancel gate). */
export async function lastRunCancelAt(
  installationId: bigint,
  runId: bigint,
): Promise<Date | null> {
  const row = await db.auditLog.findFirst({
    where: {
      installationId,
      action: "RUN_CANCEL",
      targetType: "run",
      targetId: String(runId),
      status: "SUCCEEDED",
    },
    orderBy: { seq: "desc" },
    select: { completedAt: true },
  });
  return row?.completedAt ?? null;
}
