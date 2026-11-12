import { describe, expect, it } from "vitest";
import {
  auditHash,
  GENESIS_HASH,
  immutableFields,
  resultHash,
  verifyChain,
  type ChainRow,
} from "./chain";

/**
 * Audit hash chain (design §12 "Audit hash chain"): a valid chain verifies,
 * and a changed field, a changed outcome, a removed row, a reordered row
 * or a stripped result hash is detected at the right row.
 */

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
    expect(verifyChain(chain(5))).toEqual({
      ok: true,
      checked: 5,
      unsealed: 0,
      firstBreak: null,
    });
    expect(verifyChain([]).ok).toBe(true);
  });

  it("detects a changed immutable field", () => {
    const rows = chain(5);
    rows[2] = {
      ...rows[2]!,
      params: { name: "LINUX_RUNNER", before: "x", after: "y" },
    };
    expect(verifyChain(rows).firstBreak).toEqual({
      seq: "3",
      id: "row-2",
      reason: "hash",
    });
    const actor = chain(3);
    actor[1] = { ...actor[1]!, actorUserId: "someone-else" };
    expect(verifyChain(actor).firstBreak?.reason).toBe("hash");
  });

  it("detects a changed outcome through the result hash", () => {
    const rows = chain(3);
    rows[1] = { ...rows[1]!, status: "FAILED" };
    expect(verifyChain(rows).firstBreak).toMatchObject({
      seq: "2",
      reason: "result_hash",
    });
  });

  it("detects a removed or reordered row", () => {
    const removed = chain(4);
    removed.splice(1, 1);
    expect(verifyChain(removed).firstBreak).toMatchObject({
      id: "row-2",
      reason: "prev_hash",
    });
    const swapped = chain(4);
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(verifyChain(swapped).firstBreak?.reason).toBe("prev_hash");
  });

  it("detects a recomputed row whose successor still links to the old hash", () => {
    const rows = chain(3);
    const forged = { ...rows[1]!, actorDisplay: "Forged" };
    forged.hash = auditHash(immutableFields(forged), forged.prevHash);
    forged.resultHash = resultHash(forged, forged.hash);
    rows[1] = forged;
    expect(verifyChain(rows).firstBreak).toMatchObject({
      id: "row-2",
      reason: "prev_hash",
    });
  });

  it("counts unsealed rows written before M3, but not after a sealed row", () => {
    const legacy = chain(3, false);
    expect(verifyChain(legacy)).toMatchObject({ ok: true, unsealed: 3 });
    const stripped = chain(3);
    stripped[2] = { ...stripped[2]!, resultHash: null };
    expect(verifyChain(stripped).firstBreak).toMatchObject({
      id: "row-2",
      reason: "result_hash",
    });
  });

  it("canonicalises key order, bigint and dates", () => {
    const a = auditHash({ b: 1n, a: new Date(0), c: { y: 1, x: 2 } }, "p");
    const b = auditHash({ c: { x: 2, y: 1 }, a: new Date(0), b: 1n }, "p");
    expect(a).toBe(b);
    expect(auditHash({ a: "1" }, "p")).toBe(auditHash({ a: 1n }, "p"));
  });
});
