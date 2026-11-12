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
 *   result hash; Verify reports them as "unsealed" instead of failing. The
 *   cutoff is the chain head's `sealedAfterSeq`, not the rows themselves.
 * - The chain head (seq and hash of the newest row) is kept outside the
 *   chain, so removing the newest rows is detected as "truncated".
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

/** The newest row of a chain, kept outside AuditLog (AuditChainHead). */
export type ChainHead = {
  seq: bigint;
  hash: string;
  /** Final rows with a higher seq must carry a result hash. */
  sealedAfterSeq: bigint;
};

/**
 * A PENDING row older than this was not completed by the action that wrote
 * it: no management action runs that long (Server Actions end after a few
 * minutes at most), so its outcome is missing.
 */
export const STALE_PENDING_MS = 60 * 60 * 1000;

export type ChainBreak = {
  seq: string;
  id: string | null;
  /**
   * prev_hash: the link to the previous row is wrong (a row was removed,
   * inserted or reordered); hash: an immutable field was changed;
   * result_hash: the recorded outcome was changed or removed; pending: a row
   * has no outcome long after its action ended; truncated: the chain does not
   * reach its recorded head (rows at the end were removed or rewritten).
   */
  reason: "prev_hash" | "hash" | "result_hash" | "pending" | "truncated";
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

function hasFinalFields(row: ChainRow): boolean {
  return (
    row.resultHash !== null ||
    row.completedAt !== null ||
    row.httpStatus !== null ||
    row.githubRequestId !== null ||
    row.error !== null
  );
}

/**
 * Incremental verifier: feed rows in ascending `seq` order (in pages, for
 * long chains), then read `result()`. `head` is read before the rows; rows
 * appended after it (concurrent actions) are checked as well.
 *
 * Which rows must be sealed is fixed by the head's cutoff, not by the rows
 * seen, so stripping every result hash does not turn sealed rows into
 * "unsealed" ones. Without a head, a non-empty chain is broken.
 */
export class ChainVerifier {
  private prev = GENESIS_HASH;
  private checked = 0;
  private unsealed = 0;
  private firstBreak: ChainBreak | null = null;
  private headReached = false;
  private last: { seq: bigint; id: string } | null = null;

  constructor(
    private readonly head: ChainHead | null,
    private readonly now: Date = new Date(),
  ) {}

  add(row: ChainRow): void {
    this.checked++;
    this.last = { seq: row.seq, id: row.id };
    if (this.firstBreak) return;
    const at = { seq: row.seq.toString(), id: row.id };
    const fail = (reason: ChainBreak["reason"]) => {
      this.firstBreak = { ...at, reason };
    };
    if (row.prevHash !== this.prev) return fail("prev_hash");
    if (auditHash(immutableFields(row), row.prevHash) !== row.hash)
      return fail("hash");
    if (this.head && row.seq === this.head.seq) {
      if (row.hash !== this.head.hash) return fail("truncated");
      this.headReached = true;
    }
    const sealedEra = this.head !== null && row.seq > this.head.sealedAfterSeq;
    if (row.status === "PENDING") {
      // completeAudit writes every final field at once, together with the
      // result hash; a PENDING row with any of them was edited back.
      if (hasFinalFields(row)) return fail("result_hash");
      if (
        sealedEra &&
        this.now.getTime() - row.createdAt.getTime() > STALE_PENDING_MS
      )
        return fail("pending");
    } else if (row.resultHash) {
      if (resultHash(row, row.hash) !== row.resultHash)
        return fail("result_hash");
    } else if (sealedEra) {
      return fail("result_hash");
    } else {
      this.unsealed++;
    }
    this.prev = row.hash;
  }

  result(): ChainVerification {
    let firstBreak = this.firstBreak;
    if (!firstBreak && this.last && (!this.head || !this.headReached))
      firstBreak = {
        seq: (this.head?.seq ?? this.last.seq).toString(),
        id: null,
        reason: "truncated",
      };
    if (!firstBreak && !this.last && this.head)
      firstBreak = {
        seq: this.head.seq.toString(),
        id: null,
        reason: "truncated",
      };
    return {
      ok: firstBreak === null,
      checked: this.checked,
      unsealed: this.unsealed,
      firstBreak,
    };
  }
}

export function verifyChain(
  rows: readonly ChainRow[],
  head: ChainHead | null,
  now: Date = new Date(),
): ChainVerification {
  const verifier = new ChainVerifier(head, now);
  for (const row of rows) verifier.add(row);
  return verifier.result();
}
