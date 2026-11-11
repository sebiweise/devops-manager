import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SkuRateLike } from "@/server/metrics/classify";
import type { Conclusion } from "@/server/metrics/stats";
import {
  foldJob,
  foldRun,
  placeholderRunEvent,
  type JobEvent,
  type JobRow,
  type JobStatus,
  type RunEvent,
  type RunRow,
  type RunStatus,
  type Source,
} from "./fold";

/**
 * Convergence of the folds (design §5.2, §12): every permutation and
 * duplication of a job's or run's events yields the same row. Recorded-style
 * sequences check the expected values; arbitrary events check that the fold
 * is commutative, associative and idempotent even for inconsistent input.
 */

const rates: SkuRateLike[] = [
  {
    sku: "linux",
    os: "LINUX",
    labelPattern: null,
    minuteMultiplier: 1,
    pricePerMinuteUsd: 0.008,
    effectiveFrom: new Date("2024-01-01T00:00:00Z"),
  },
];
const ctx = { rates, repoPrivate: true };

const T0 = Date.parse("2026-11-02T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000);

function foldJobs(events: JobEvent[]): JobRow {
  let row: JobRow | null = null;
  for (const e of events) row = foldJob(row, e, ctx);
  return row!;
}

function foldRuns(events: RunEvent[]): RunRow {
  let row: RunRow | null = null;
  for (const e of events) row = foldRun(row, e);
  return row!;
}

/** All events at least once, some duplicated, in any order. */
function permutedWithDuplicates<T>(events: T[]) {
  return fc
    .array(fc.nat({ max: events.length - 1 }), { maxLength: events.length })
    .chain((extra) => {
      const all = [...events.map((_, i) => i), ...extra];
      return fc.shuffledSubarray(all, {
        minLength: all.length,
        maxLength: all.length,
      });
    })
    .map((idx) => idx.map((i) => events[i]!));
}

function jobEvent(overrides: Partial<JobEvent>): JobEvent {
  return {
    id: 501n,
    runId: 401n,
    runAttempt: 1,
    installationId: 1001n,
    repositoryId: 11n,
    workflowName: "CI",
    name: "test (ubuntu-latest, 22)",
    labels: ["ubuntu-latest"],
    status: "QUEUED",
    conclusion: null,
    runnerId: null,
    runnerName: null,
    runnerGroupId: null,
    runnerGroupName: null,
    createdAt: at(0),
    startedAt: at(0),
    completedAt: null,
    eventAt: at(1),
    source: "WEBHOOK",
    ...overrides,
  };
}

const runner = {
  runnerId: 7n,
  runnerName: "GitHub Actions 7",
  runnerGroupId: 1n,
  runnerGroupName: "GitHub Actions",
};

/** queued -> waiting (approval) -> queued -> in_progress -> completed. */
const recordedJob: JobEvent[] = [
  jobEvent({ status: "QUEUED", eventAt: at(1) }),
  jobEvent({ status: "WAITING", eventAt: at(2) }),
  jobEvent({ status: "QUEUED", eventAt: at(62) }),
  jobEvent({
    status: "IN_PROGRESS",
    startedAt: at(92),
    eventAt: at(93),
    ...runner,
  }),
  jobEvent({
    status: "COMPLETED",
    conclusion: "SUCCESS",
    startedAt: at(92),
    completedAt: at(392),
    eventAt: at(393),
    ...runner,
  }),
];

describe("foldJob", () => {
  it("folds a recorded sequence into the expected row", () => {
    const row = foldJobs(recordedJob);
    expect(row).toMatchObject({
      status: "COMPLETED",
      statusRank: 4,
      conclusion: "SUCCESS",
      baseName: "test",
      labelKey: "ubuntu-latest",
      runnerName: "GitHub Actions 7",
      runnerKind: "GITHUB_HOSTED",
      runnerOs: "LINUX",
      sku: "linux",
      createdAt: at(0),
      startedAt: at(92),
      completedAt: at(392),
      waitingStartedAt: at(2),
      // approval wait: from the waiting event to the next queued event
      waitingS: 60,
      // 92 s from creation to start, minus the 60 s approval wait
      queueS: 32,
      durationS: 300,
      // ceil(300 / 60) = 5 minutes, multiplier 1
      billableMinEst: 5,
      lastEventAt: at(393),
    });
  });

  it("converges for every permutation and duplication of the recorded events", () => {
    const expected = foldJobs(recordedJob);
    fc.assert(
      fc.property(permutedWithDuplicates(recordedJob), (events) => {
        expect(foldJobs(events)).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("ignores started_at of queued events (GitHub sets it to the queue time)", () => {
    const row = foldJobs([jobEvent({ status: "QUEUED", startedAt: at(0) })]);
    expect(row.startedAt).toBeNull();
    expect(row.queueS).toBeNull();
  });

  const arbJobEvent: fc.Arbitrary<JobEvent> = fc
    .record({
      status: fc.constantFrom<JobStatus>(
        "QUEUED",
        "WAITING",
        "IN_PROGRESS",
        "COMPLETED",
      ),
      conclusion: fc.option(
        fc.constantFrom<Conclusion>(
          "SUCCESS",
          "FAILURE",
          "CANCELLED",
          "SKIPPED",
        ),
      ),
      created: fc.integer({ min: 0, max: 50 }),
      started: fc.option(fc.integer({ min: 0, max: 500 })),
      completed: fc.option(fc.integer({ min: 0, max: 900 })),
      event: fc.integer({ min: 0, max: 1000 }),
      runnerName: fc.option(fc.constantFrom("runner-1", "runner-2")),
      labels: fc.constantFrom(["ubuntu-latest"], ["self-hosted", "linux"], []),
      source: fc.constantFrom<Source>("WEBHOOK", "BACKFILL", "RECONCILE"),
    })
    .map((r) =>
      jobEvent({
        status: r.status,
        conclusion: r.conclusion,
        createdAt: at(r.created),
        startedAt: r.started == null ? null : at(r.started),
        completedAt: r.completed == null ? null : at(r.completed),
        eventAt: at(r.event),
        runnerName: r.runnerName,
        labels: [...r.labels],
        source: r.source,
      }),
    );

  it("is order-independent and idempotent for arbitrary events", () => {
    fc.assert(
      fc.property(
        fc
          .array(arbJobEvent, { minLength: 1, maxLength: 6 })
          .chain((events) =>
            fc.tuple(fc.constant(events), permutedWithDuplicates(events)),
          ),
        ([events, permuted]) => {
          expect(foldJobs(permuted)).toEqual(foldJobs(events));
        },
      ),
      { numRuns: 500 },
    );
  });
});

function runEvent(overrides: Partial<RunEvent>): RunEvent {
  return {
    id: 401n,
    installationId: 1001n,
    repositoryId: 11n,
    workflowId: 301n,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    headBranch: "main",
    headSha: "a".repeat(40),
    isDefaultBranch: true,
    actorLogin: "example-user",
    runNumber: 12,
    runAttempt: 1,
    status: "QUEUED",
    conclusion: null,
    createdAt: at(0),
    runStartedAt: at(0),
    updatedAt: at(1),
    htmlUrl: "https://github.com/example-org/repo-a/actions/runs/401",
    placeholder: false,
    eventAt: at(1),
    source: "WEBHOOK",
    ...overrides,
  };
}

/** Attempt 1 fails, attempt 2 succeeds; a job creates a placeholder first. */
const recordedRun: RunEvent[] = [
  placeholderRunEvent(
    jobEvent({ runAttempt: 1, createdAt: at(5), eventAt: at(6) }),
    { headSha: "a".repeat(40), headBranch: "main" },
  ),
  runEvent({ status: "REQUESTED", eventAt: at(1) }),
  runEvent({ status: "IN_PROGRESS", updatedAt: at(10), eventAt: at(10) }),
  runEvent({
    status: "COMPLETED",
    conclusion: "FAILURE",
    updatedAt: at(300),
    eventAt: at(301),
  }),
  placeholderRunEvent(
    jobEvent({ id: 502n, runAttempt: 2, createdAt: at(400), eventAt: at(401) }),
    { headSha: "a".repeat(40), headBranch: "main" },
  ),
  runEvent({
    runAttempt: 2,
    status: "QUEUED",
    runStartedAt: at(400),
    updatedAt: at(400),
    eventAt: at(400),
  }),
  runEvent({
    runAttempt: 2,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    runStartedAt: at(400),
    updatedAt: at(700),
    eventAt: at(701),
  }),
];

describe("foldRun", () => {
  it("folds attempts, placeholders and the first-attempt conclusion", () => {
    const row = foldRuns(recordedRun);
    expect(row).toMatchObject({
      runAttempt: 2,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      firstAttemptConclusion: "FAILURE",
      isPlaceholder: false,
      workflowId: 301n,
      runStartedAt: at(400),
      completedAt: at(700),
      durationS: 300,
      createdAt: at(0),
      lastEventAt: at(701),
    });
  });

  it("converges for every permutation and duplication of the recorded events", () => {
    const expected = foldRuns(recordedRun);
    fc.assert(
      fc.property(permutedWithDuplicates(recordedRun), (events) => {
        expect(foldRuns(events)).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("keeps a run created from a job as a placeholder until the run arrives", () => {
    const row = foldRuns(recordedRun.slice(0, 1));
    expect(row.isPlaceholder).toBe(true);
    expect(row.statusRank).toBe(0);
    expect(row.workflowId).toBeNull();
    expect(row.headSha).toBe("a".repeat(40));
  });

  const arbRunEvent: fc.Arbitrary<RunEvent> = fc
    .record({
      attempt: fc.integer({ min: 1, max: 3 }),
      status: fc.constantFrom<RunStatus>(
        "REQUESTED",
        "QUEUED",
        "PENDING",
        "WAITING",
        "IN_PROGRESS",
        "COMPLETED",
      ),
      conclusion: fc.option(fc.constantFrom<Conclusion>("SUCCESS", "FAILURE")),
      placeholder: fc.boolean(),
      created: fc.integer({ min: 0, max: 50 }),
      started: fc.option(fc.integer({ min: 0, max: 500 })),
      updated: fc.option(fc.integer({ min: 0, max: 900 })),
      event: fc.integer({ min: 0, max: 1000 }),
      name: fc.constantFrom("CI", "Build"),
      branch: fc.option(fc.constantFrom("main", "feature")),
    })
    .map((r) =>
      runEvent({
        runAttempt: r.attempt,
        status: r.status,
        conclusion: r.conclusion,
        placeholder: r.placeholder,
        workflowId: r.placeholder ? null : 301n,
        createdAt: at(r.created),
        runStartedAt: r.started == null ? null : at(r.started),
        updatedAt: r.updated == null ? null : at(r.updated),
        eventAt: at(r.event),
        workflowName: r.name,
        headBranch: r.branch,
      }),
    );

  it("is order-independent and idempotent for arbitrary events", () => {
    fc.assert(
      fc.property(
        fc
          .array(arbRunEvent, { minLength: 1, maxLength: 6 })
          .chain((events) =>
            fc.tuple(fc.constant(events), permutedWithDuplicates(events)),
          ),
        ([events, permuted]) => {
          expect(foldRuns(permuted)).toEqual(foldRuns(events));
        },
      ),
      { numRuns: 500 },
    );
  });
});
