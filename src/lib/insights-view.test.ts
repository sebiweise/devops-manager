import { describe, expect, it } from "vitest";
import type {
  Freshness,
  JobBreakdown,
  RunSummary,
  WorkflowStat,
} from "@/server/data/insights";
import {
  decodeCursor,
  encodeCursor,
  hostedVsSelfHosted,
  leaderboards,
  parseConclusion,
  staleReasons,
  textFilter,
  withParams,
} from "./insights-view";

const NOW = new Date("2026-11-11T12:00:00Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

const freshness = (f: Partial<Freshness>): Freshness => ({
  lastWebhookAt: hoursAgo(1),
  lastReconciledAt: hoursAgo(1),
  failedDeliveries: 0,
  deadDeliveries: 0,
  hasRuns: true,
  stale: false,
  ...f,
});

describe("staleReasons", () => {
  it("is empty when webhooks and reconcile are recent", () => {
    expect(staleReasons(freshness({}), NOW)).toEqual([]);
  });

  it("flags missing webhooks only while runs exist", () => {
    expect(
      staleReasons(freshness({ lastWebhookAt: hoursAgo(7) }), NOW),
    ).toEqual(["noWebhook"]);
    expect(
      staleReasons(freshness({ lastWebhookAt: null, hasRuns: false }), NOW),
    ).toEqual([]);
  });

  it("flags an old reconcile and failed deliveries", () => {
    expect(
      staleReasons(
        freshness({ lastReconciledAt: hoursAgo(25), deadDeliveries: 1 }),
        NOW,
      ),
    ).toEqual(["noReconcile", "failedDeliveries"]);
    expect(staleReasons(freshness({ lastReconciledAt: null }), NOW)).toEqual([
      "noReconcile",
    ]);
  });
});

const summary = (s: Partial<RunSummary>): RunSummary => ({
  runs: 20,
  success: 18,
  failure: 2,
  cancelled: 0,
  other: 0,
  firstTrySuccess: 18,
  flakyRecovered: 0,
  successRate: 0.9,
  firstTrySuccessRate: 0.9,
  flakyRate: 0,
  n: 20,
  p50: 60,
  p95: 120,
  queueP95: 5,
  approx: false,
  ...s,
});

const wf = (
  id: string,
  s: Partial<RunSummary>,
  w: Partial<WorkflowStat> = {},
) =>
  ({
    workflowId: id,
    workflowName: `wf-${id}`,
    repositoryId: "1",
    repoFullName: "example-org/repo-a",
    summary: summary(s),
    billableMinEst: 0,
    regression: null,
    successDrop: null,
    sparkline: [],
    ...w,
  }) satisfies WorkflowStat;

describe("leaderboards", () => {
  const stats = [
    wf(
      "1",
      { p95: 300, flakyRate: 0.1, successRate: 0.5 },
      { billableMinEst: 10 },
    ),
    wf("2", { p95: 900, n: 5 }, { billableMinEst: 40 }),
    wf(
      "3",
      { p95: 100, successRate: 0.95 },
      { regression: { metric: "p95", recent: 100, baseline: 50, ratio: 2 } },
    ),
    wf("4", { successRate: 0.2, success: 1, failure: 4 }),
  ];
  const b = leaderboards(stats);

  it("ranks slowest by p95 and skips small samples", () => {
    expect(b.slowest.map((w) => w.workflowId)).toEqual(["1", "4", "3"]);
  });

  it("ranks flaky, minutes, success and regressions", () => {
    expect(b.flakiest.map((w) => w.workflowId)).toEqual(["1"]);
    expect(b.mostMinutes.map((w) => w.workflowId)).toEqual(["2", "1"]);
    // Workflow 4 has only 5 runs in the denominator.
    expect(b.lowestSuccess[0]!.workflowId).toBe("1");
    expect(b.lowestSuccess.map((w) => w.workflowId)).not.toContain("4");
    expect(b.regressions.map((w) => w.workflowId)).toEqual(["3"]);
  });
});

const job = (j: Partial<JobBreakdown>): JobBreakdown => ({
  baseName: "test",
  labelKey: "ubuntu-latest",
  runnerKind: "GITHUB_HOSTED",
  jobs: 10,
  failureRate: 0,
  p50: 100,
  p95: 200,
  queueP95: 5,
  billableMinEst: 20,
  flakyRuns: 0,
  ...j,
});

describe("hostedVsSelfHosted", () => {
  it("compares jobs with n >= 5 on both kinds", () => {
    const out = hostedVsSelfHosted([
      job({}),
      job({ runnerKind: "SELF_HOSTED", labelKey: "self-hosted", p50: 80 }),
      job({ baseName: "lint", jobs: 20 }),
      job({
        baseName: "lint",
        runnerKind: "SELF_HOSTED",
        labelKey: "self-hosted",
        jobs: 4,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.baseName).toBe("test");
    expect(out[0]!.deltaP50).toBeCloseTo(-0.2, 10);
  });

  it("picks the busiest pool per kind and ignores unknown runners", () => {
    const out = hostedVsSelfHosted([
      job({ jobs: 6, p50: 50 }),
      job({ labelKey: "ubuntu-24.04", jobs: 30, p50: 100 }),
      job({ runnerKind: "UNKNOWN", jobs: 99 }),
      job({ runnerKind: "SELF_HOSTED", labelKey: "self-hosted", p50: 150 }),
    ]);
    expect(out[0]!.hosted.labelKey).toBe("ubuntu-24.04");
    expect(out[0]!.deltaP50).toBeCloseTo(0.5, 10);
  });
});

describe("search params", () => {
  it("round-trips the run list cursor and rejects junk", () => {
    const c = { createdAt: "2026-11-10T08:00:00.000Z", id: "123456789" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("x_1")).toBeUndefined();
    expect(decodeCursor("2026-11-10T08:00:00.000Z_abc")).toBeUndefined();
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it("parses conclusions and trims free text", () => {
    expect(parseConclusion("failure")).toBe("FAILURE");
    expect(parseConclusion("nope")).toBeUndefined();
    expect(textFilter("  main ")).toBe("main");
    expect(textFilter("   ")).toBeUndefined();
    expect(textFilter("x".repeat(500))).toHaveLength(200);
  });

  it("builds links that keep other params", () => {
    expect(
      withParams(
        "/o/example-org",
        { range: "7d", tab: ["runs"] },
        {
          range: "30d",
          before: undefined,
        },
      ),
    ).toBe("/o/example-org?range=30d&tab=runs");
    expect(
      withParams("/o/example-org", { range: "7d" }, { range: undefined }),
    ).toBe("/o/example-org");
  });
});
