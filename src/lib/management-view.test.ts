import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { parseAuditQuery } from "./audit-view";
import {
  checksKey,
  defaultMergeMethod,
  mergeBlock,
  needsAcknowledgement,
  resultText,
  runOperationsFor,
} from "./management-view";

/** View logic of the management UI (design §7, §8.2). */

function lookup(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (o, p) => (o as Record<string, unknown> | undefined)?.[p],
      en.management,
    );
}

describe("runOperationsFor", () => {
  const completed = { status: "COMPLETED", runAttempt: 1 };
  it("re-runs completed runs and re-runs failed jobs of unsuccessful ones", () => {
    expect(runOperationsFor({ ...completed, conclusion: "SUCCESS" })).toEqual([
      "rerun",
    ]);
    for (const c of ["FAILURE", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"])
      expect(runOperationsFor({ ...completed, conclusion: c })).toEqual([
        "rerun",
        "rerun_failed",
      ]);
  });

  it("stops offering a re-run at 50 attempts", () => {
    expect(
      runOperationsFor({ ...completed, runAttempt: 50, conclusion: "FAILURE" }),
    ).toEqual(["rerun_failed"]);
  });

  it("cancels running runs; force cancel only when allowed", () => {
    const running = { status: "IN_PROGRESS", conclusion: null, runAttempt: 1 };
    expect(runOperationsFor(running)).toEqual(["cancel"]);
    expect(runOperationsFor({ ...running, status: "QUEUED" }, true)).toEqual([
      "cancel",
      "force_cancel",
    ]);
  });

  it("offers nothing for placeholder runs", () => {
    expect(
      runOperationsFor({
        ...completed,
        conclusion: "FAILURE",
        isPlaceholder: true,
      }),
    ).toEqual([]);
  });
});

describe("resultText", () => {
  it("maps every result to an existing message", () => {
    const results = [
      { status: "succeeded", replayed: false },
      { status: "succeeded", replayed: true },
      { status: "failed", message: "Head branch was modified." },
      { status: "pending" },
      { status: "unauthorized" },
      { status: "forbidden" },
      { status: "management_disabled", level: "global" as const },
      { status: "management_disabled", level: "installation" as const },
      { status: "permission_not_granted", missing: ["workflows"] },
      { status: "rate_limited", retryAfterS: 12 },
      { status: "confirmation_mismatch" },
      { status: "conflict" },
      { status: "refused", reason: "attempt_limit" },
      { status: "refused", reason: "something_new" },
      { status: "error" },
    ];
    for (const r of results) {
      const text = resultText(r);
      expect(typeof lookup(text.key), text.key).toBe("string");
    }
  });

  it("passes GitHub's message, the seconds and the merge state", () => {
    expect(
      resultText({ status: "failed", message: "Head branch was modified." }),
    ).toEqual({
      key: "result.failed",
      values: { message: "Head branch was modified." },
      tone: "error",
    });
    expect(
      resultText({
        status: "refused",
        reason: "force_cancel_too_early",
        detail: { retryAfterS: 17 },
      }).values.seconds,
    ).toBe(17);
    expect(
      resultText({
        status: "refused",
        reason: "needs_acknowledgement",
        detail: { mergeableState: "blocked" },
      }).values.state,
    ).toBe("blocked");
    expect(resultText({ status: "succeeded" }).tone).toBe("success");
  });
});

describe("merge helpers", () => {
  const clean = {
    isDraft: false,
    mergeable: "MERGEABLE" as const,
    changesWorkflows: false,
  };
  const opts = { workflowsGranted: true, methods: ["merge" as const] };

  it("preselects squash, then merge, then rebase", () => {
    expect(defaultMergeMethod(["merge", "squash", "rebase"])).toBe("squash");
    expect(defaultMergeMethod(["rebase", "merge"])).toBe("merge");
    expect(defaultMergeMethod(["rebase"])).toBe("rebase");
    expect(defaultMergeMethod([])).toBeNull();
  });

  it("blocks drafts, conflicts, unknown mergeability and missing Workflows", () => {
    expect(mergeBlock(clean, opts)).toBeNull();
    expect(mergeBlock({ ...clean, isDraft: true }, opts)).toBe("draft");
    expect(mergeBlock({ ...clean, mergeable: "CONFLICTING" }, opts)).toBe(
      "conflicting",
    );
    expect(mergeBlock({ ...clean, mergeable: "UNKNOWN" }, opts)).toBe(
      "unknown",
    );
    expect(
      mergeBlock(
        { ...clean, changesWorkflows: true },
        { ...opts, workflowsGranted: false },
      ),
    ).toBe("workflows_not_granted");
    expect(mergeBlock({ ...clean, changesWorkflows: true }, opts)).toBeNull();
    expect(mergeBlock(clean, { ...opts, methods: [] })).toBe("no_method");
  });

  it("asks for the warning unless the merge state is CLEAN", () => {
    expect(needsAcknowledgement("CLEAN")).toBe(false);
    expect(needsAcknowledgement("BLOCKED")).toBe(true);
    expect(needsAcknowledgement(null)).toBe(true);
  });

  it("groups the checks rollup", () => {
    expect(checksKey("SUCCESS")).toBe("success");
    expect(checksKey("ERROR")).toBe("failure");
    expect(checksKey("EXPECTED")).toBe("pending");
    expect(checksKey(null)).toBe("none");
  });
});

describe("parseAuditQuery", () => {
  it("keeps valid filters and makes the end date inclusive", () => {
    const q = parseAuditQuery({
      actor: "user-1",
      action: "PR_MERGE",
      repo: "101",
      status: "FAILED",
      batch: "0b6c6f3e-8a43-4c1e-9d9b-4b8d2a1f0c11",
      from: "2026-11-01",
      to: "2026-11-11",
      before: "50",
      chain: "instance",
    });
    expect(q.filter).toEqual({
      actorUserId: "user-1",
      action: "PR_MERGE",
      repositoryId: 101n,
      status: "FAILED",
      batchId: "0b6c6f3e-8a43-4c1e-9d9b-4b8d2a1f0c11",
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-11-12T00:00:00Z"),
    });
    expect(q.chain).toBe("instance");
    expect(q.before).toBe("50");
  });

  it("ignores anything that does not parse", () => {
    const q = parseAuditQuery({
      actor: "x'; drop",
      action: "NOPE",
      repo: "abc",
      status: "maybe",
      batch: "not-a-uuid",
      from: "yesterday",
      to: "2026-13-45",
      before: "-1",
      chain: "other",
    });
    expect(q.filter).toEqual({});
    expect(q.values).toEqual({});
    expect(q.chain).toBe("installation");
    expect(q.before).toBeUndefined();
  });
});
