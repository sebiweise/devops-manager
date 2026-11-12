import { createHash } from "node:crypto";

/**
 * The audit hash chain (design §4 AuditLog, §9 "Audit"). Pure, so the chain
 * rules and tamper detection are unit-tested without a database.
 *
 * - `hash` = sha256(canonical(immutable fields) || prevHash), written once
 *   when the row is created. Rows are chained per installation (0 = the
 *   instance-level chain) in `seq` order; the first row links to
 *   GENESIS_HASH.
 * - `resultHash` = sha256(canonical(final status fields) || hash), written
 *   with the final status, so a changed outcome (for example FAILED edited
 *   to SUCCEEDED) is detected as well. Rows written before M3 have no
 *   result hash; Verify reports them as "unsealed" instead of failing.
 */

export const GENESIS_HASH = "0".repeat(64);

export function canonical(value: unknown): string {
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

/** The fields the row hash covers; everything else is mutable or derived. */
export type ImmutableAuditFields = {
  id: string;
  installationId: bigint;
  actorUserId: string;
  actorDisplay: string;
  actorRole: string;
  actorProvider: string;
  actingAs: string | null;
  action: string;
  repositoryId: bigint | null;
  repoFullName: string | null;
  targetType: string;
  targetId: string;
  batchId: string | null;
  params: unknown;
  confirmation: string;
  idempotencyKey: string;
  createdAt: Date;
};

export type FinalAuditFields = {
  status: string;
  httpStatus: number | null;
  githubRequestId: string | null;
  error: string | null;
  completedAt: Date | null;
};

export function immutableFields(row: ImmutableAuditFields) {
  return {
    id: row.id,
    installationId: row.installationId,
    actorUserId: row.actorUserId,
    actorDisplay: row.actorDisplay,
    actorRole: row.actorRole,
    actorProvider: row.actorProvider,
    actingAs: row.actingAs,
    action: row.action,
    repositoryId: row.repositoryId,
    repoFullName: row.repoFullName,
    targetType: row.targetType,
    targetId: row.targetId,
    batchId: row.batchId,
    params: row.params,
    confirmation: row.confirmation,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}

/** sha256(canonical(final fields) || row hash). */
export function resultHash(final: FinalAuditFields, hash: string): string {
  return auditHash(
    {
      status: final.status,
      httpStatus: final.httpStatus,
      githubRequestId: final.githubRequestId,
      error: final.error,
      completedAt: final.completedAt,
    },
    hash,
  );
}

export type ChainRow = ImmutableAuditFields &
  FinalAuditFields & {
    seq: bigint;
    prevHash: string;
    hash: string;
    resultHash: string | null;
  };

export type ChainBreak = {
  seq: string;
  id: string;
  /**
   * prev_hash: the link to the previous row is wrong (a row was removed,
   * inserted or reordered); hash: an immutable field was changed;
   * result_hash: the recorded outcome was changed.
   */
  reason: "prev_hash" | "hash" | "result_hash";
};

export type ChainVerification = {
  ok: boolean;
  /** Rows checked. */
  checked: number;
  /** Final rows without a result hash (written before M3). */
  unsealed: number;
  /** The first break found, in `seq` order. */
  firstBreak: ChainBreak | null;
};

/**
 * Incremental verifier: feed rows in ascending `seq` order (in pages, for
 * long chains), then read `result()`.
 */
export class ChainVerifier {
  private prev = GENESIS_HASH;
  private checked = 0;
  private unsealed = 0;
  private firstBreak: ChainBreak | null = null;
  private sawSealed = false;

  add(row: ChainRow): void {
    this.checked++;
    if (this.firstBreak) return;
    const at = { seq: row.seq.toString(), id: row.id };
    if (row.prevHash !== this.prev) {
      this.firstBreak = { ...at, reason: "prev_hash" };
      return;
    }
    if (auditHash(immutableFields(row), row.prevHash) !== row.hash) {
      this.firstBreak = { ...at, reason: "hash" };
      return;
    }
    if (row.resultHash) {
      if (resultHash(row, row.hash) !== row.resultHash) {
        this.firstBreak = { ...at, reason: "result_hash" };
        return;
      }
      this.sawSealed = true;
    } else if (row.status !== "PENDING") {
      // Since M3 every final row is sealed: an unsealed one after a sealed
      // row means its result hash was removed.
      if (this.sawSealed) {
        this.firstBreak = { ...at, reason: "result_hash" };
        return;
      }
      this.unsealed++;
    }
    this.prev = row.hash;
  }

  result(): ChainVerification {
    return {
      ok: this.firstBreak === null,
      checked: this.checked,
      unsealed: this.unsealed,
      firstBreak: this.firstBreak,
    };
  }
}

export function verifyChain(rows: readonly ChainRow[]): ChainVerification {
  const verifier = new ChainVerifier();
  for (const row of rows) verifier.add(row);
  return verifier.result();
}
