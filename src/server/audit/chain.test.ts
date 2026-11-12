import { describe, expect, it } from "vitest";
import {
  auditHash,
  GENESIS_HASH,
  immutableFields,
  resultHash,
  STALE_PENDING_MS,
  verifyChain,
  type ChainHead,
  type ChainRow,
} from "./chain";

/**
 * Audit hash chain (design §12 "Audit hash chain"): a valid chain verifies,
 * and a changed field, a changed outcome, a removed row, a reordered row,
 * a stripped result hash, an outcome edited back to PENDING and removed
 * rows at the end of the chain are detected at the right row.
 */

const NOW = new Date(Date.UTC(2026, 10, 1, 3));

/** The head the writer keeps for `rows` (cutoff 0 = every row sealed). */
function headOf(rows: ChainRow[], sealedAfterSeq = 0n): ChainHead {
  const last = rows[rows.length - 1]!;
  return { seq: last.seq, hash: last.hash, sealedAfterSeq };
}

function verify(rows: ChainRow[], head: ChainHead | null = headOf(rows)) {
  return verifyChain(rows, head, NOW);
}

function chain(n: number, sealed = true): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const base = {
      id: `row-${i}`,
      installationId: 1001n,
      actorUserId: "user-admin",
      actorDisplay: "Admin",
      actorRole: "ADMIN",
      actorProvider: "oidc",
      actingAs: "app:example-devops-manager[bot]",
      action: "VAR_UPDATE",
      repositoryId: 11n,
      repoFullName: "example-user/repo-a",
      targetType: "variable",
      targetId: "LINUX_RUNNER",
      batchId: null,
      params: { name: "LINUX_RUNNER", before: "ubuntu-latest", after: `v${i}` },
      confirmation: "DIALOG",
      idempotencyKey: `key-${i}`,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)),
    };
    const hash = auditHash(immutableFields(base as ChainRow), prev);
    const final = {
      status: "SUCCEEDED",
      httpStatus: 204,
      githubRequestId: `req-${i}`,
      error: null,
      completedAt: new Date(Date.UTC(2026, 10, 1, 0, i, 1)),
    };
    rows.push({
      ...base,
      ...final,
      seq: BigInt(i + 1),
      prevHash: prev,
      hash,
      resultHash: sealed ? resultHash(final, hash) : null,
    });
    prev = hash;
  }
  return rows;
}

describe("audit hash chain", () => {
  it("verifies an intact chain, including an empty one", () => {
    expect(verify(chain(5))).toEqual({
      ok: true,
      checked: 5,
      unsealed: 0,
      firstBreak: null,
    });
    expect(verifyChain([], null).ok).toBe(true);
  });

  it("detects a changed immutable field", () => {
    const rows = chain(5);
    rows[2] = {
      ...rows[2]!,
      params: { name: "LINUX_RUNNER", before: "x", after: "y" },
    };
    expect(verify(rows).firstBreak).toEqual({
      seq: "3",
      id: "row-2",
      reason: "hash",
    });
    const actor = chain(3);
    actor[1] = { ...actor[1]!, actorUserId: "someone-else" };
    expect(verify(actor).firstBreak?.reason).toBe("hash");
  });

  it("detects a changed outcome through the result hash", () => {
    const rows = chain(3);
    rows[1] = { ...rows[1]!, status: "FAILED" };
    expect(verify(rows).firstBreak).toMatchObject({
      seq: "2",
      reason: "result_hash",
    });
  });

  it("detects a removed or reordered row", () => {
    const removed = chain(4);
    removed.splice(1, 1);
    expect(verify(removed).firstBreak).toMatchObject({
      id: "row-2",
      reason: "prev_hash",
    });
    const swapped = chain(4);
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(verify(swapped).firstBreak?.reason).toBe("prev_hash");
  });

  it("detects a recomputed row whose successor still links to the old hash", () => {
    const rows = chain(3);
    const forged = { ...rows[1]!, actorDisplay: "Forged" };
    forged.hash = auditHash(immutableFields(forged), forged.prevHash);
    forged.resultHash = resultHash(forged, forged.hash);
    rows[1] = forged;
    expect(verify(rows).firstBreak).toMatchObject({
      id: "row-2",
      reason: "prev_hash",
    });
  });

  it("counts unsealed rows up to the head's cutoff only", () => {
    const legacy = chain(3, false);
    expect(verify(legacy, headOf(legacy, 3n))).toMatchObject({
      ok: true,
      unsealed: 3,
    });
    const stripped = chain(3);
    stripped[2] = { ...stripped[2]!, resultHash: null };
    expect(verify(stripped).firstBreak).toMatchObject({
      id: "row-2",
      reason: "result_hash",
    });
    // Stripping every result hash does not turn the rows into legacy ones.
    const allStripped = chain(3).map((r) => ({ ...r, resultHash: null }));
    expect(verify(allStripped).firstBreak).toMatchObject({
      id: "row-0",
      reason: "result_hash",
    });
  });

  it("detects an outcome edited back to PENDING", () => {
    const rows = chain(3);
    rows[1] = { ...rows[1]!, status: "PENDING", resultHash: null };
    expect(verify(rows).firstBreak).toMatchObject({
      id: "row-1",
      reason: "result_hash",
    });
    const cleared = chain(3);
    cleared[1] = {
      ...cleared[1]!,
      status: "PENDING",
      resultHash: null,
      httpStatus: null,
      githubRequestId: null,
      completedAt: null,
    };
    // Every final field cleared: caught by its age.
    expect(verify(cleared).firstBreak).toMatchObject({
      id: "row-1",
      reason: "pending",
    });
    const running = chain(3);
    running[2] = {
      ...running[2]!,
      status: "PENDING",
      resultHash: null,
      httpStatus: null,
      githubRequestId: null,
      completedAt: null,
    };
    // A recent PENDING row is an action still running.
    expect(
      verifyChain(
        running,
        headOf(running),
        new Date(running[2]!.createdAt.getTime() + STALE_PENDING_MS - 1),
      ).ok,
    ).toBe(true);
  });

  it("detects removed rows at the end of the chain through the head", () => {
    const rows = chain(4);
    const head = headOf(rows);
    expect(verify(rows.slice(0, 2), head)).toMatchObject({
      ok: false,
      firstBreak: { seq: "4", id: null, reason: "truncated" },
    });
    expect(verify([], head).firstBreak?.reason).toBe("truncated");
    // A rewritten newest row no longer matches the head.
    const forged = chain(4);
    forged[3] = { ...forged[3]!, actorDisplay: "Forged" };
    forged[3].hash = auditHash(immutableFields(forged[3]), forged[3].prevHash);
    forged[3].resultHash = resultHash(forged[3], forged[3].hash);
    expect(verify(forged, head).firstBreak).toMatchObject({
      id: "row-3",
      reason: "truncated",
    });
    // Without a head a non-empty chain is not trusted.
    expect(verify(rows, null).firstBreak?.reason).toBe("truncated");
    // Rows appended after the head was read are fine.
    expect(verify(rows, headOf(rows.slice(0, 3))).ok).toBe(true);
  });

  it("canonicalises key order, bigint and dates", () => {
    const a = auditHash({ b: 1n, a: new Date(0), c: { y: 1, x: 2 } }, "p");
    const b = auditHash({ c: { x: 2, y: 1 }, a: new Date(0), b: 1n }, "p");
    expect(a).toBe(b);
    expect(auditHash({ a: "1" }, "p")).toBe(auditHash({ a: 1n }, "p"));
  });
});
