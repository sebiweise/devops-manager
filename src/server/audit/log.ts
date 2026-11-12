import "server-only";
import { randomUUID } from "node:crypto";
import { type AuditAction, type AuditStatus } from "@/generated/prisma/client";
import type { Role } from "@/server/authz/roles";
import { db } from "@/server/db";
import { redactError } from "@/server/ingest/webhook";
import {
  auditHash,
  ChainVerifier,
  GENESIS_HASH,
  resultHash,
  type ChainRow,
  type ChainVerification,
} from "./chain";

/**
 * Append-only audit writer with a hash chain per installation (design §4,
 * §8.1 steps 7 and 9, §9 "Audit"). The row hash covers the immutable fields
 * and the previous row's hash; it is written once. The final status is
 * written by a single update of a PENDING row (`completeAudit`), sealed with
 * a result hash, and the row is frozen after that. The chain is serialised
 * per installation with a transaction-scoped advisory lock (PgBouncer-safe,
 * released at commit).
 *
 * This module is the only writer of AuditLog; nothing in the app updates or
 * deletes audit rows otherwise.
 */

export { auditHash, GENESIS_HASH } from "./chain";

export type AuditEntry = {
  installationId: bigint;
  actorUserId: string;
  actorDisplay: string;
  actorRole: Role;
  actorProvider: string;
  actingAs: string | null;
  action: AuditAction;
  repositoryId?: bigint | null;
  repoFullName?: string | null;
  targetType: string;
  targetId: string;
  batchId?: string | null;
  params: Record<string, unknown>;
  confirmation: "DIALOG" | "TYPED" | "NONE";
  idempotencyKey: string;
  status: AuditStatus;
  httpStatus?: number | null;
  githubRequestId?: string | null;
  error?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
};

export type AppendResult = {
  id: string;
  /** False when a row with the idempotency key already existed. */
  created: boolean;
};

const MAX_ERROR = 1000;

function cleanError(error: string | null | undefined): string | null {
  return error ? redactError(error, MAX_ERROR) : null;
}

export async function appendAudit(entry: AuditEntry): Promise<AppendResult> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('audit'), hashtext(${String(entry.installationId)}))`;
    const existing = await tx.auditLog.findUnique({
      where: { idempotencyKey: entry.idempotencyKey },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
    const prev = await tx.auditLog.findFirst({
      where: { installationId: entry.installationId },
      orderBy: { seq: "desc" },
      select: { hash: true },
    });
    const prevHash = prev?.hash ?? GENESIS_HASH;
    const immutable = {
      id: randomUUID(),
      installationId: entry.installationId,
      actorUserId: entry.actorUserId,
      actorDisplay: entry.actorDisplay,
      actorRole: entry.actorRole,
      actorProvider: entry.actorProvider,
      actingAs: entry.actingAs,
      action: entry.action,
      repositoryId: entry.repositoryId ?? null,
      repoFullName: entry.repoFullName ?? null,
      targetType: entry.targetType,
      targetId: entry.targetId,
      batchId: entry.batchId ?? null,
      params: entry.params,
      confirmation: entry.confirmation,
      idempotencyKey: entry.idempotencyKey,
      createdAt: new Date(),
    };
    const hash = auditHash(immutable, prevHash);
    const final = {
      status: entry.status,
      httpStatus: entry.httpStatus ?? null,
      githubRequestId: entry.githubRequestId ?? null,
      error: cleanError(entry.error),
      completedAt: entry.status === "PENDING" ? null : immutable.createdAt,
    };
    const row = await tx.auditLog.create({
      data: {
        ...immutable,
        params: entry.params as object,
        ...final,
        ipHash: entry.ipHash ?? null,
        userAgent: entry.userAgent ?? null,
        prevHash,
        hash,
        resultHash: entry.status === "PENDING" ? null : resultHash(final, hash),
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  });
}

export type AuditCompletion = {
  status: Exclude<AuditStatus, "PENDING" | "DENIED">;
  httpStatus?: number | null;
  githubRequestId?: string | null;
  error?: string | null;
};

/**
 * Writes the final status of a PENDING row, once. Returns false when the row
 * is not PENDING any more (it is frozen).
 */
export async function completeAudit(
  id: string,
  result: AuditCompletion,
): Promise<boolean> {
  const row = await db.auditLog.findUnique({
    where: { id },
    select: { hash: true, status: true },
  });
  if (!row || row.status !== "PENDING") return false;
  const final = {
    status: result.status,
    httpStatus: result.httpStatus ?? null,
    githubRequestId: result.githubRequestId ?? null,
    error: cleanError(result.error),
    completedAt: new Date(),
  };
  const { count } = await db.auditLog.updateMany({
    where: { id, status: "PENDING" },
    data: { ...final, resultHash: resultHash(final, row.hash) },
  });
  return count === 1;
}

/** "oidc" or "github": the provider of the user's first linked account. */
export async function actorProviderOf(userId: string): Promise<string> {
  const account = await db.account.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { providerId: true },
  });
  return account?.providerId ?? "oidc";
}

const VERIFY_PAGE = 500;

/**
 * Verifies the whole chain of one installation (0 = instance chain), in
 * pages of 500 rows ordered by `seq`. Callers check visibility first.
 */
export async function verifyAuditChain(
  installationId: bigint,
): Promise<ChainVerification> {
  const verifier = new ChainVerifier();
  let after: bigint | null = null;
  for (;;) {
    const rows: ChainRow[] = await db.auditLog.findMany({
      where: {
        installationId,
        ...(after === null ? {} : { seq: { gt: after } }),
      },
      orderBy: { seq: "asc" },
      take: VERIFY_PAGE,
      select: {
        id: true,
        seq: true,
        installationId: true,
        actorUserId: true,
        actorDisplay: true,
        actorRole: true,
        actorProvider: true,
        actingAs: true,
        action: true,
        repositoryId: true,
        repoFullName: true,
        targetType: true,
        targetId: true,
        batchId: true,
        params: true,
        confirmation: true,
        idempotencyKey: true,
        createdAt: true,
        status: true,
        httpStatus: true,
        githubRequestId: true,
        error: true,
        completedAt: true,
        prevHash: true,
        hash: true,
        resultHash: true,
      },
    });
    for (const row of rows) verifier.add(row);
    if (rows.length < VERIFY_PAGE) break;
    after = rows[rows.length - 1]!.seq;
  }
  return verifier.result();
}
