import { describe, expect, it } from "vitest";
import {
  countConclusions,
  detectFlakyJobs,
  detectRegression,
  detectSuccessDrop,
  firstTrySuccessRate,
  flakyRate,
  isFlakyRun,
  percentileExact,
  queueSeconds,
  runTimings,
  successRate,
  trendDelta,
  type Conclusion,
} from "./stats";

const t = (s: number) =>
  new Date(Date.parse("2026-11-02T10:00:00Z") + s * 1000);

describe("success rate", () => {
  it("excludes cancelled, skipped, neutral, action_required and stale from the denominator", () => {
    const c = countConclusions([
      "SUCCESS",
      "SUCCESS",
      "SUCCESS",
      "FAILURE",
      "TIMED_OUT",
      "STARTUP_FAILURE",
      "CANCELLED",
      "SKIPPED",
      "NEUTRAL",
      "ACTION_REQUIRED",
      "STALE",
    ] satisfies Conclusion[]);
    expect(c).toEqual({
      runs: 11,
      success: 3,
      failure: 3,
      cancelled: 1,
      other: 4,
    });
    expect(successRate(c)).toBe(0.5);
  });

  it("is null without completed runs in the denominator", () => {
    expect(successRate({ success: 0, failure: 0 })).toBeNull();
  });

  it("computes first-try success and flaky rate", () => {
    expect(
      firstTrySuccessRate({ success: 8, failure: 2, firstTrySuccess: 6 }),
    ).toBe(0.6);
    expect(flakyRate({ success: 8, flakyRecovered: 2 })).toBe(0.25);
  });
});

describe("percentiles", () => {
  it("matches percentile_cont interpolation", () => {
    expect(percentileExact([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileExact([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48);
    expect(percentileExact([], 0.5)).toBeNull();
  });
});

describe("job and run timings", () => {
  const base = {
    conclusion: "SUCCESS" as Conclusion,
    runnerName: "runner-1",
    createdAt: t(0),
    startedAt: t(100),
    completedAt: t(400),
    waitingS: 0,
  };

  it("queue time excludes the approval wait", () => {
    expect(queueSeconds(base)).toBe(100);
    expect(queueSeconds({ ...base, waitingS: 70 })).toBe(30);
    expect(queueSeconds({ ...base, waitingS: 500 })).toBe(0);
  });

  it("has no queue time for skipped and abandoned jobs", () => {
    expect(queueSeconds({ ...base, conclusion: "SKIPPED" })).toBeNull();
    expect(
      queueSeconds({
        ...base,
        runnerName: null,
        startedAt: t(5),
        completedAt: t(5),
      }),
    ).toBeNull();
    expect(
      queueSeconds({ ...base, conclusion: "CANCELLED", runnerName: null }),
    ).toBeNull();
  });

  it("derives wall clock, compute, parallelism and first queue", () => {
    const jobs = [
      {
        ...base,
        startedAt: t(10),
        completedAt: t(110),
        durationS: 100,
        queueS: 10,
      },
      {
        ...base,
        startedAt: t(20),
        completedAt: t(220),
        durationS: 200,
        queueS: 20,
      },
    ];
    expect(
      runTimings({ runStartedAt: t(0), completedAt: t(230) }, jobs),
    ).toEqual({
      wallS: 220,
      computeS: 300,
      parallelism: 300 / 220,
      firstQueueS: 10,
    });
  });
});

describe("flakiness", () => {
  it("flags runs that failed in attempt 1 and succeeded later", () => {
    expect(
      isFlakyRun({
        runAttempt: 2,
        firstAttemptConclusion: "FAILURE",
        conclusion: "SUCCESS",
      }),
    ).toBe(true);
    expect(
      isFlakyRun({
        runAttempt: 1,
        firstAttemptConclusion: "SUCCESS",
        conclusion: "SUCCESS",
      }),
    ).toBe(false);
    expect(
      isFlakyRun({
        runAttempt: 2,
        firstAttemptConclusion: "CANCELLED",
        conclusion: "SUCCESS",
      }),
    ).toBe(false);
  });

  it("detects flaky jobs on synthetic data", () => {
    const jobs = [
      // run 1: "test" fails in attempt 1, succeeds in attempt 2 -> flaky
      {
        runId: 1n,
        runAttempt: 1,
        baseName: "test",
        conclusion: "FAILURE" as const,
      },
      {
        runId: 1n,
        runAttempt: 2,
        baseName: "test",
        conclusion: "SUCCESS" as const,
      },
      {
        runId: 1n,
        runAttempt: 1,
        baseName: "lint",
        conclusion: "SUCCESS" as const,
      },
      // run 2: "test" fails twice, then succeeds in attempt 3 -> flaky
      {
        runId: 2n,
        runAttempt: 1,
        baseName: "test",
        conclusion: "FAILURE" as const,
      },
      {
        runId: 2n,
        runAttempt: 2,
        baseName: "test",
        conclusion: "TIMED_OUT" as const,
      },
      {
        runId: 2n,
        runAttempt: 3,
        baseName: "test",
        conclusion: "SUCCESS" as const,
      },
      // run 3: "build" succeeds, then fails -> not flaky
      {
        runId: 3n,
        runAttempt: 1,
        baseName: "build",
        conclusion: "SUCCESS" as const,
      },
      {
        runId: 3n,
        runAttempt: 2,
        baseName: "build",
        conclusion: "FAILURE" as const,
      },
      // run 4: "lint" fails and is never retried -> not flaky
      {
        runId: 4n,
        runAttempt: 1,
        baseName: "lint",
        conclusion: "FAILURE" as const,
      },
    ];
    expect(detectFlakyJobs(jobs)).toEqual([{ baseName: "test", runs: 2 }]);
  });
});

describe("regression badge", () => {
  const window = (n: number, p50: number, p95: number) => ({ n, p50, p95 });

  it("fires when p50 or p95 grows by more than 20% with n >= 10 on both sides", () => {
    expect(
      detectRegression(window(12, 130, 200), window(40, 100, 190)),
    ).toEqual({
      metric: "p50",
      recent: 130,
      baseline: 100,
      ratio: 1.3,
    });
    expect(
      detectRegression(window(12, 100, 300), window(40, 100, 200))?.metric,
    ).toBe("p95");
  });

  it("does not fire at exactly 1.2x, or with fewer than 10 samples", () => {
    expect(
      detectRegression(window(12, 120, 240), window(40, 100, 200)),
    ).toBeNull();
    expect(
      detectRegression(window(9, 500, 900), window(40, 100, 200)),
    ).toBeNull();
    expect(
      detectRegression(window(12, 500, 900), window(9, 100, 200)),
    ).toBeNull();
  });

  it("fires on a synthetic slowdown of a workflow's durations", () => {
    const baseline = Array.from({ length: 56 }, (_, i) => 300 + (i % 7) * 10);
    const recent = Array.from({ length: 14 }, (_, i) => 420 + (i % 7) * 10);
    const w = (v: number[]) => ({
      n: v.length,
      p50: percentileExact(v, 0.5),
      p95: percentileExact(v, 0.95),
    });
    const r = detectRegression(w(recent), w(baseline));
    expect(r).not.toBeNull();
    expect(r!.ratio).toBeGreaterThan(1.2);
  });
});

describe("success drop", () => {
  it("fires at 10 percentage points below the baseline", () => {
    expect(
      detectSuccessDrop(
        { success: 8, failure: 2 },
        { success: 36, failure: 0 },
      ),
    ).toMatchObject({ recent: 0.8, baseline: 1 });
    expect(
      detectSuccessDrop(
        { success: 9, failure: 1 },
        { success: 40, failure: 0 },
      ),
    ).not.toBeNull();
    expect(
      detectSuccessDrop(
        { success: 19, failure: 1 },
        { success: 40, failure: 0 },
      ),
    ).toBeNull();
    expect(
      detectSuccessDrop(
        { success: 1, failure: 5 },
        { success: 40, failure: 0 },
      ),
    ).toBeNull();
  });

  it("computes trend deltas", () => {
    expect(trendDelta(0.9, 0.8)).toBeCloseTo(0.1);
    expect(trendDelta(null, 0.8)).toBeNull();
  });
});
