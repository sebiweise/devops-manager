import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { type AuditAction, type AuditStatus } from "@/generated/prisma/client";
import type { Role } from "@/server/authz/roles";
import { db } from "@/server/db";

/**
 * Append-only audit writer with a hash chain per installation (design §4,
 * §8.1 step 7). The hash covers the immutable fields and the previous row's
 * hash; it is written once, and only the final status is updated later. The
 * chain is serialised per installation with a transaction-scoped advisory
 * lock (PgBouncer-safe, released at commit).
 *
 * M1 uses it for Sync now; the full management pipeline (M3) builds on it.
 */

export const GENESIS_HASH = "0".repeat(64);

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
  error?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
};

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256(canonical(immutable fields) || prevHash). */
export function auditHash(
  fields: Record<string, unknown>,
  prevHash: string,
): string {
  return createHash("sha256")
    .update(canonical(fields))
    .update(prevHash)
    .digest("hex");
}

export async function appendAudit(entry: AuditEntry): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('audit'), hashtext(${String(entry.installationId)}))`;
    const existing = await tx.auditLog.findUnique({
      where: { idempotencyKey: entry.idempotencyKey },
      select: { id: true },
    });
    if (existing) return existing;
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
    const row = await tx.auditLog.create({
      data: {
        ...immutable,
        params: entry.params as object,
        status: entry.status,
        error: entry.error ?? null,
        ipHash: entry.ipHash ?? null,
        userAgent: entry.userAgent ?? null,
        prevHash,
        hash: auditHash(immutable, prevHash),
        completedAt: entry.status === "PENDING" ? null : new Date(),
      },
      select: { id: true },
    });
    return row;
  });
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
