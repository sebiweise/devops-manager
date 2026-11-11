import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TenantScope } from "@/server/authz/scope";
import type * as Insights from "@/server/data/insights";
import type * as Installations from "@/server/data/installations";
import type * as Budget from "@/server/ingest/budget";
import type * as Reconcile from "@/server/ingest/reconcile";
import type * as Db from "@/server/db";
import type * as Histogram from "@/server/metrics/histogram";
import {
  A,
  B,
  DATABASE_URL,
  FakeGitHub,
  resetTables,
  seedInstallations,
  setActionsEnv,
} from "./support/actions";

/**
 * Metrics through the whole pipeline (fake GitHub -> reconcile -> rollups ->
 * data layer) against a hand-computed fixture, synthetic regressions and
 * flaky jobs, histogram codec parity between TypeScript and SQL, and the
 * two-installation isolation suite (design §6, §9, §12, §13 M1).
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const DAY = 86_400_000;

let db: typeof Db.db;
let insights: typeof Insights;
let installations: typeof Installations;
let reconcile: typeof Reconcile;
let budget: typeof Budget;
let histogram: typeof Histogram;

const scope = (role: TenantScope["role"], ...ids: bigint[]): TenantScope => ({
  userId: "user-1",
  role,
  installationIds: ids,
});

/** Noon UTC, `days` ago: far from day boundaries. */
function daysAgo(now: number, days: number, minutes = 0) {
  const d = new Date(now - days * DAY);
  d.setUTCHours(12, minutes, 0, 0);
  return d;
}

async function sync(gh: FakeGitHub, installationId?: bigint) {
  return reconcile.runReconcile({
    deadline: new budget.Deadline(gh.now + 3_600_000, gh.clock),
    clients: gh.clients(),
    config: { backfillDays: 35 },
    ...(installationId !== undefined ? { installationId } : {}),
  });
}

/**
 * The hand-computed fixture: 10 runs of workflow 301 two days ago.
 * Job duration d = 60..600 s (step 60), queue q = 5..50 s (step 5), so the
 * run duration (created -> completed) is d + q = 65, 130, ..., 650.
 *   p50 = (325 + 390) / 2 = 357.5          (percentile_cont, rank 4.5)
 *   p95 = 585 + 0.55 * (650 - 585) = 620.75 (rank 8.55)
 *   queue p95 = 45 + 0.55 * 5 = 47.75
 *   success rate = 7 / (7 + 2), one cancelled run outside the denominator
 *   minutes = sum(ceil(d / 60)) = 1 + 2 + ... + 10 = 55
 */
function addFixture(gh: FakeGitHub) {
  const conclusions = [
    "success",
    "success",
    "success",
    "success",
    "success",
    "success",
    "success",
    "failure",
    "failure",
    "cancelled",
  ];
  for (let i = 0; i < 10; i++)
    gh.addRun(A, {
      createdAt: daysAgo(gh.now, 2, i * 2),
      durationS: 60 * (i + 1),
      queueS: 5 * (i + 1),
      conclusion: conclusions[i],
    });
}

const EXPECTED = { p50: 357.5, p95: 620.75, queueP95: 47.75, rate: 7 / 9 };

describe.skipIf(!DATABASE_URL)("insights", () => {
  beforeAll(async () => {
    setActionsEnv();
    ({ db } = await import("@/server/db"));
    insights = await import("@/server/data/insights");
    installations = await import("@/server/data/installations");
    reconcile = await import("@/server/ingest/reconcile");
    budget = await import("@/server/ingest/budget");
    histogram = await import("@/server/metrics/histogram");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
  });

  it(
    "matches the hand-computed fixture exactly from raw rows",
    { timeout: 60_000 },
    async () => {
      await seedInstallations(db);
      const gh = new FakeGitHub();
      addFixture(gh);
      await sync(gh, A);
      const now = new Date(gh.now);

      const o = await insights.getInstallationOverview(
        scope("VIEWER", A),
        A,
        "7d",
        now,
      );
      expect(o.summary.approx).toBe(false);
      expect(o.summary).toMatchObject({
        runs: 10,
        success: 7,
        failure: 2,
        cancelled: 1,
        other: 0,
      });
      expect(o.summary.successRate).toBeCloseTo(EXPECTED.rate, 10);
      expect(Math.abs(o.summary.p50! - EXPECTED.p50)).toBeLessThanOrEqual(1);
      expect(Math.abs(o.summary.p95! - EXPECTED.p95)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(o.summary.queueP95! - EXPECTED.queueP95),
      ).toBeLessThanOrEqual(1);
      expect(o.billableMinEst).toBe(55);

      const day = o.perDay.find((d) => d.runs > 0)!;
      expect(day).toMatchObject({
        runs: 10,
        success: 7,
        failure: 2,
        cancelled: 1,
      });
      expect(o.perDay.filter((d) => d.runs > 0)).toHaveLength(1);
    },
  );

  it(
    "matches the fixture within 10% from rollup histograms",
    { timeout: 60_000 },
    async () => {
      // Raw retention of 14 days makes a 30-day range read the rollups.
      await seedInstallations(db, { rawRetentionDays: 14 });
      const gh = new FakeGitHub();
      addFixture(gh);
      await sync(gh, A);
      const now = new Date(gh.now);

      const o = await insights.getInstallationOverview(
        scope("VIEWER", A),
        A,
        "30d",
        now,
      );
      expect(o.summary.approx).toBe(true);
      expect(o.summary).toMatchObject({
        runs: 10,
        success: 7,
        failure: 2,
        cancelled: 1,
      });
      expect(o.summary.successRate).toBeCloseTo(EXPECTED.rate, 10);
      const within10 = (v: number | null, e: number) =>
        expect(Math.abs(v! - e) / e).toBeLessThanOrEqual(0.1);
      within10(o.summary.p50, EXPECTED.p50);
      within10(o.summary.p95, EXPECTED.p95);
      within10(o.summary.queueP95, EXPECTED.queueP95);
      expect(o.billableMinEst).toBe(55);

      // Job rollups: one job per run, 7 successes and 2 failures.
      const detail = await insights.getWorkflowDetail(
        scope("VIEWER", A),
        A,
        301n,
        "30d",
        now,
      );
      expect(detail.approx).toBe(true);
      expect(detail.jobs).toHaveLength(1);
      expect(detail.jobs[0]).toMatchObject({
        baseName: "test",
        jobs: 10,
        billableMinEst: 55,
      });
      within10(detail.jobs[0]!.p50, 330); // job durations 60..600: (300 + 360) / 2
    },
  );

  it("agrees with the SQL histogram codec", async () => {
    const values = [
      0, 0.5, 1, 1.5, 2, 3, 4, 7, 8, 15, 16, 59, 60, 61, 300, 3_600, 86_400,
      432_000, 10_000_000,
    ];
    const rows = await db.$queryRaw<Array<{ s: number; b: number }>>`
      SELECT s, hist_bucket(s) AS b FROM unnest(${values}::float8[]) AS s`;
    for (const r of rows) expect(r.b).toBe(histogram.bucketOf(Number(r.s)));
    const dense = await db.$queryRaw<Array<{ s: number; b: number }>>`
      SELECT s, hist_bucket(s) AS b FROM generate_series(1, 20000) AS s`;
    for (const r of dense) expect(r.b).toBe(histogram.bucketOf(Number(r.s)));
    const [agg] = await db.$queryRaw<Array<{ h: number[] }>>`
      SELECT hist_sum(h) AS h FROM (
        SELECT hist_agg(x) AS h FROM unnest(${[1, 2, 3, 60]}::float8[]) AS x
        UNION ALL SELECT hist_agg(x) FROM unnest(${[60, 600]}::float8[]) AS x
      ) t`;
    expect(agg!.h).toEqual(histogram.histogramOf([1, 2, 3, 60, 60, 600]));
  });

  it(
    "fires the regression badge and flaky detection on synthetic data",
    { timeout: 120_000 },
    async () => {
      await seedInstallations(db);
      const gh = new FakeGitHub();
      // Baseline: 20 runs between 8 and 34 days ago at about 300 s.
      for (let i = 0; i < 20; i++)
        gh.addRun(A, {
          createdAt: daysAgo(gh.now, 8 + i * 1.3),
          durationS: 290 + (i % 5) * 5,
          workflowId: 302,
          workflowName: "Deploy",
        });
      // Last 7 days: 12 runs at about 420 s.
      for (let i = 0; i < 12; i++)
        gh.addRun(A, {
          createdAt: daysAgo(gh.now, 1 + (i % 6), i),
          durationS: 410 + (i % 4) * 5,
          workflowId: 302,
          workflowName: "Deploy",
        });
      // A stable workflow next to it: no badge.
      for (let i = 0; i < 30; i++)
        gh.addRun(A, {
          createdAt: daysAgo(gh.now, 1 + i, 30),
          durationS: 100,
          workflowId: 303,
          workflowName: "Lint",
        });
      // Flaky: "test" failed in attempt 1 and passed in attempt 2, in three runs.
      for (let i = 0; i < 3; i++)
        gh.addRun(A, {
          createdAt: daysAgo(gh.now, 2, 40 + i),
          durationS: 100,
          attempt: 2,
          firstConclusion: "failure",
          workflowId: 304,
          workflowName: "Flaky",
        });
      await sync(gh, A);
      const now = new Date(gh.now);

      const alerts = await insights.listAlerts(scope("VIEWER", A), A, now);
      expect(alerts.regressions.map((w) => w.workflowId)).toEqual(["302"]);
      expect(alerts.regressions[0]!.regression!.ratio).toBeGreaterThan(1.2);

      const flaky = await insights.listFlakyJobs(
        scope("VIEWER", A),
        A,
        "30d",
        now,
      );
      expect(flaky).toEqual([
        {
          workflowId: "304",
          workflowName: "Flaky",
          repoFullName: "example-user/repo-a",
          baseName: "test",
          runs: 3,
        },
      ]);
      const detail = await insights.getWorkflowDetail(
        scope("VIEWER", A),
        A,
        304n,
        "30d",
        now,
      );
      expect(detail.summary.flakyRecovered).toBe(3);
      expect(detail.summary.firstTrySuccess).toBe(0);
      expect(detail.jobs.find((j) => j.baseName === "test")?.flakyRuns).toBe(3);
    },
  );

  describe("two-installation isolation", () => {
    let runOfB: bigint;
    let now: Date;

    beforeEach(async () => {
      await seedInstallations(db);
      const gh = new FakeGitHub();
      for (let i = 0; i < 3; i++) {
        gh.addRun(A, {
          createdAt: daysAgo(gh.now, 1 + i),
          durationS: 100,
          workflowId: 301,
        });
        gh.addRun(B, {
          createdAt: daysAgo(gh.now, 1 + i),
          durationS: 200,
          workflowId: 401,
          workflowName: "Org CI",
        });
      }
      await sync(gh);
      now = new Date(gh.now);
      runOfB = (
        await db.workflowRun.findFirstOrThrow({ where: { installationId: B } })
      ).id;
    });

    it("every data function answers NotFound for an installation outside the scope", async () => {
      const onlyA = scope("ADMIN", A);
      const calls: Array<() => Promise<unknown>> = [
        () => insights.getFreshness(onlyA, B, now),
        () => insights.getInstallationOverview(onlyA, B, "7d", now),
        () => insights.listRepoStats(onlyA, B, now),
        () => insights.listWorkflowStats(onlyA, B, {}, now),
        () => insights.getWorkflowDetail(onlyA, B, 401n, "7d", now),
        () => insights.listRuns(onlyA, B),
        () => insights.getRunDetail(onlyA, B, runOfB),
        () => insights.listFlakyJobs(onlyA, B, "7d", now),
        () => insights.listAlerts(onlyA, B, now),
        () => insights.getSyncHealth(onlyA, B, 7, now),
        () => installations.listRepositories(onlyA, B),
      ];
      for (const call of calls)
        await expect(call()).rejects.toBeInstanceOf(
          installations.NotFoundError,
        );
      expect(
        await insights.findRepositoryByName(onlyA, B, "repo-b"),
      ).toBeNull();
      expect(
        await installations.findInstallationByAccount(onlyA, "example-org"),
      ).toBeNull();
    });

    it("ids of the other installation answer NotFound inside a visible installation", async () => {
      const onlyA = scope("ADMIN", A);
      await expect(
        insights.getRunDetail(onlyA, A, runOfB),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        insights.getWorkflowDetail(onlyA, A, 401n, "7d", now),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        insights.listRuns(onlyA, A, { repositoryId: 22n }),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        insights.listWorkflowStats(onlyA, A, { repositoryId: 22n }, now),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      expect(
        await insights.findRepositoryByName(onlyA, A, "repo-b"),
      ).toBeNull();
    });

    it("results of one installation never contain the other's data", async () => {
      const both = scope("ADMIN", A, B);
      const runsA = await insights.listRuns(both, A);
      expect(runsA.runs).toHaveLength(3);
      expect(new Set(runsA.runs.map((r) => r.repoFullName))).toEqual(
        new Set(["example-user/repo-a"]),
      );
      const wfA = await insights.listWorkflowStats(both, A, {}, now);
      expect(wfA.map((w) => w.workflowId)).toEqual(["301"]);
      const wfB = await insights.listWorkflowStats(both, B, {}, now);
      expect(wfB.map((w) => w.workflowId)).toEqual(["401"]);
      const repoStats = await insights.listRepoStats(both, B, now);
      expect(repoStats.map((r) => r.fullName)).toEqual(["example-org/repo-b"]);
      expect(repoStats[0]!.runs7d).toBe(3);
      const oA = await insights.getInstallationOverview(both, A, "7d", now);
      const oB = await insights.getInstallationOverview(both, B, "7d", now);
      expect(oA.summary.p50).toBe(110);
      expect(oB.summary.p50).toBe(210);
      const health = await insights.getSyncHealth(both, A, 35, now);
      expect(health.repos.map((r) => r.fullName)).toEqual([
        "example-user/repo-a",
      ]);
    });

    it("admin-only sync health answers NotFound to viewers and operators", async () => {
      for (const role of ["VIEWER", "OPERATOR"] as const)
        await expect(
          insights.getSyncHealth(scope(role, A), A, 7, now),
        ).rejects.toBeInstanceOf(installations.NotFoundError);
    });
  });
});
