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
import type * as Budget from "@/server/ingest/budget";
import type * as GitHubClient from "@/server/ingest/github-client";
import type * as Prune from "@/server/ingest/prune";
import type * as Reconcile from "@/server/ingest/reconcile";
import type * as Rollup from "@/server/ingest/rollup";
import type * as Db from "@/server/db";
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
 * Retention edges (design §5.5): insights only read raw rows inside the
 * retention prune applies (MAX_RETENTION_DAYS=30 here), rollups of days
 * prune may have cut into are never recomputed, a purge resumes when the
 * deadline cuts it off, and one failing stale job does not stop reconcile.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const DAY = 86_400_000;
const HIST = Array.from({ length: 80 }, () => 0);

let db: typeof Db.db;
let insights: typeof Insights;
let reconcile: typeof Reconcile;
let rollup: typeof Rollup;
let prune: typeof Prune;
let budget: typeof Budget;

const scope = (...ids: bigint[]): TenantScope => ({
  userId: "user-1",
  role: "VIEWER",
  installationIds: ids,
});

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

describe.skipIf(!DATABASE_URL)("retention", () => {
  beforeAll(async () => {
    setActionsEnv({ MAX_RETENTION_DAYS: "30" });
    ({ db } = await import("@/server/db"));
    insights = await import("@/server/data/insights");
    reconcile = await import("@/server/ingest/reconcile");
    rollup = await import("@/server/ingest/rollup");
    prune = await import("@/server/ingest/prune");
    budget = await import("@/server/ingest/budget");
  });

  afterAll(async () => {
    delete process.env.MAX_RETENTION_DAYS;
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
  });

  it("reads ranges beyond MAX_RETENTION_DAYS from rollups, not truncated raw rows", async () => {
    await seedInstallations(db, { rawRetentionDays: 90 });
    const gh = new FakeGitHub();
    gh.addRun(A, { createdAt: new Date(gh.now - 2 * DAY), durationS: 60 });
    await reconcile.runReconcile({
      deadline: new budget.Deadline(gh.now + 3_600_000, gh.clock),
      clients: gh.clients(),
      installationId: A,
      config: { backfillDays: 7 },
    });
    const now = new Date(gh.now);
    const inside = await insights.getInstallationOverview(
      scope(A),
      A,
      "30d",
      now,
    );
    expect(inside.summary.approx).toBe(false);
    const beyond = await insights.getInstallationOverview(
      scope(A),
      A,
      "90d",
      now,
    );
    expect(beyond.summary.approx).toBe(true);
    expect(beyond.summary.runs).toBe(1);
  });

  it("keeps the stats of days before the retention cutoff when they are re-marked", async () => {
    await seedInstallations(db, { rawRetentionDays: 14 });
    const now = Date.now();
    const oldDay = new Date(`${isoDay(now - 20 * DAY)}T00:00:00Z`);
    await db.dailyWorkflowStat.create({
      data: {
        installationId: A,
        repositoryId: 11n,
        workflowId: 301n,
        workflowName: "CI",
        day: oldDay,
        defaultBranch: true,
        runs: 40,
        success: 38,
        failure: 2,
        cancelled: 0,
        other: 0,
        firstTrySuccess: 38,
        flakyRecovered: 0,
        durSumS: 4000n,
        durHist: HIST,
        queueHist: HIST,
        jobSecondsLinux: 4000,
        jobSecondsWindows: 0,
        jobSecondsMacos: 0,
        jobSecondsSelfHosted: 0,
        billableMinEst: 80,
      },
    });
    await db.rollupDirty.create({
      data: {
        installationId: A,
        repositoryId: 11n,
        day: oldDay,
        markedAt: new Date(now),
      },
    });
    const drained = await rollup.drainRollups(
      A,
      "UTC",
      new budget.Deadline(now + 60_000),
      14,
    );
    expect(drained).toEqual({ partitions: 0, remaining: false, days: [] });
    expect(await db.rollupDirty.count()).toBe(0);
    const kept = await db.dailyWorkflowStat.findFirstOrThrow({
      where: { installationId: A, day: oldDay },
    });
    expect(kept.runs).toBe(40);
  });

  it("purges an uninstalled installation in batches and resumes after the deadline", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    gh.addRun(B, { createdAt: new Date(gh.now - DAY), durationS: 60 });
    await reconcile.runReconcile({
      deadline: new budget.Deadline(gh.now + 3_600_000, gh.clock),
      clients: gh.clients(),
      installationId: B,
      config: { backfillDays: 7 },
    });
    expect(await db.workflowRun.count({ where: { installationId: B } })).toBe(
      1,
    );

    // A deadline that expires after the first check: nothing may be lost.
    let t = Date.now();
    const cut = new budget.Deadline(t + 1, () => (t += 1));
    expect(await prune.purgeInstallation(B, cut)).toBe(false);
    expect(await db.installation.count({ where: { id: B } })).toBe(1);

    expect(
      await prune.purgeInstallation(
        B,
        new budget.Deadline(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(await db.installation.count({ where: { id: B } })).toBe(0);
    expect(await db.workflowRun.count({ where: { installationId: B } })).toBe(
      0,
    );
    expect(await db.workflowJob.count({ where: { installationId: B } })).toBe(
      0,
    );
    expect(await db.repository.count({ where: { installationId: B } })).toBe(0);
    expect(await db.syncState.count({ where: { installationId: B } })).toBe(0);
    // The other installation is untouched.
    expect(await db.installation.count({ where: { id: A } })).toBe(1);
  });

  it("rotates a stale job GitHub fails on instead of stopping reconcile", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    gh.addRun(A, { createdAt: new Date(gh.now - DAY), durationS: 60 });
    const deadline = () => new budget.Deadline(gh.now + 3_600_000, gh.clock);
    await reconcile.runReconcile({
      deadline: deadline(),
      clients: gh.clients(),
      installationId: A,
      config: { backfillDays: 7 },
    });
    const job = await db.workflowJob.findFirstOrThrow({
      where: { installationId: A },
    });
    const old = new Date(gh.now - 2 * 3_600_000);
    await db.workflowJob.update({
      where: { id: job.id },
      data: { status: "IN_PROGRESS", statusRank: 2, lastEventAt: old },
    });

    const base = gh.clients();
    const failing: GitHubClient.GitHubClients = {
      app: base.app,
      installation: async (...args) => {
        const api = await base.installation(...args);
        return {
          request: (route, params) =>
            route.startsWith("GET /repos/{owner}/{repo}/actions/jobs/")
              ? Promise.reject(
                  Object.assign(new Error("HTTP 502"), { status: 502 }),
                )
              : api.request(route, params),
        };
      },
    };
    const before = gh.requests.length;
    const result = await reconcile.runReconcile({
      deadline: deadline(),
      clients: failing,
      installationId: A,
      config: { backfillDays: 7 },
    });
    expect(result.installations[0]!.status).not.toBe("error");
    const after = await db.workflowJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(after.lastEventAt.getTime()).toBeGreaterThan(old.getTime());
    // d) incremental sync still listed the repository's runs.
    expect(
      gh.requests
        .slice(before)
        .some(
          (r) => r.route.includes("/actions/runs") && r.installationId === A,
        ),
    ).toBe(true);
  });
});
