import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as Budget from "@/server/ingest/budget";
import type * as Reconcile from "@/server/ingest/reconcile";
import type * as Triggers from "@/server/ingest/triggers";
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
 * Reconcile against a real Postgres and an in-memory GitHub (design §5.3,
 * §13 M1): backfill of BACKFILL_DAYS with window splitting above 1,000
 * results, deadline stop and resume from cursors, independent installations,
 * and exactly one lazy reconcile per stale installation.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const DAY = 86_400_000;

let db: typeof Db.db;
let reconcile: typeof Reconcile;
let triggers: typeof Triggers;
let budget: typeof Budget;

describe.skipIf(!DATABASE_URL)("reconcile", () => {
  beforeAll(async () => {
    setActionsEnv();
    ({ db } = await import("@/server/db"));
    reconcile = await import("@/server/ingest/reconcile");
    triggers = await import("@/server/ingest/triggers");
    budget = await import("@/server/ingest/budget");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
  });

  it(
    "backfills BACKFILL_DAYS of runs and jobs and splits a window with more than 1,000 results",
    { timeout: 240_000 },
    async () => {
      await seedInstallations(db);
      const gh = new FakeGitHub();
      const now = gh.now;
      // 1,050 runs within one day two days ago: inside the first 3-day window.
      for (let i = 0; i < 1_050; i++)
        gh.addRun(A, {
          createdAt: new Date(now - 2 * DAY + i * 60_000),
          durationS: 60 + (i % 50),
        });
      // A few older runs, one outside BACKFILL_DAYS (7).
      for (const d of [3.5, 5, 6.5, 8])
        gh.addRun(A, { createdAt: new Date(now - d * DAY), durationS: 120 });

      const result = await reconcile.runReconcile({
        deadline: new budget.Deadline(now + 3_600_000, gh.clock),
        clients: gh.clients(),
        installationId: A,
        config: { backfillDays: 7 },
      });
      expect(result.installations[0]).toMatchObject({ status: "ok" });

      expect(await db.workflowRun.count({ where: { installationId: A } })).toBe(
        1_053,
      );
      expect(await db.workflowJob.count({ where: { installationId: A } })).toBe(
        1_053,
      );
      const state = await db.syncState.findUniqueOrThrow({
        where: { repositoryId: 11n },
      });
      expect(state.backfillDone).toBe(true);
      expect(state.backfillUntil!.getTime()).toBeLessThanOrEqual(
        now - 7 * DAY + 1000,
      );

      // The first window was counted, found >= 1,000 and split.
      const counts = gh.requests.filter(
        (r) =>
          r.route === "GET /repos/{owner}/{repo}/actions/runs" &&
          r.params.per_page === 1,
      );
      expect(counts.length).toBeGreaterThan(3);
      // Every listed window is below the cap: no page beyond 10 was needed.
      const listed = gh.requests.filter(
        (r) =>
          r.route === "GET /repos/{owner}/{repo}/actions/runs" &&
          r.params.per_page === 100,
      );
      expect(
        Math.max(...listed.map((r) => Number(r.params.page))),
      ).toBeLessThanOrEqual(10);

      // Rollups were drained for the ingested days.
      const [rollup] = await db.$queryRaw<Array<{ runs: number }>>`
        SELECT COALESCE(sum("runs"), 0)::int AS runs FROM "DailyWorkflowStat" WHERE "installationId" = ${A}`;
      expect(rollup?.runs).toBe(1_053);
    },
  );

  it(
    "stops before the deadline, persists cursors and resumes",
    { timeout: 120_000 },
    async () => {
      await seedInstallations(db);
      const gh = new FakeGitHub();
      const start = gh.now;
      for (let i = 0; i < 60; i++)
        gh.addRun(A, {
          createdAt: new Date(start - (i + 1) * 2.5 * 3_600_000),
          durationS: 100,
        });
      gh.msPerRequest = 1_000; // every GitHub call takes a second of fake time

      const first = new budget.Deadline(start + 40_000, gh.clock);
      const r1 = await reconcile.runReconcile({
        deadline: first,
        clients: gh.clients(),
        installationId: A,
        config: { backfillDays: 7 },
      });
      expect(r1.installations[0]?.status).toBe("partial");
      expect(gh.now).toBeLessThanOrEqual(first.endsAt);
      const afterFirst = await db.syncState.findUniqueOrThrow({
        where: { repositoryId: 11n },
      });
      expect(afterFirst.backfillDone).toBe(false);
      expect(afterFirst.backfillUntil!.getTime()).toBeLessThan(start);
      const firstCount = await db.workflowRun.count({
        where: { installationId: A },
      });
      expect(firstCount).toBeGreaterThan(0);
      expect(firstCount).toBeLessThan(60);
      // The lock is released and lastReconciledAt set, so the next tick can run.
      const inst = await db.installation.findUniqueOrThrow({
        where: { id: A },
      });
      expect(inst.reconcileLockedUntil).toBeNull();
      expect(inst.lastReconciledAt).not.toBeNull();

      const resumeFrom = afterFirst.backfillUntil!.getTime();
      const before = gh.requests.length;
      const r2 = await reconcile.runReconcile({
        deadline: new budget.Deadline(gh.now + 3_600_000, gh.clock),
        clients: gh.clients(),
        installationId: A,
        config: { backfillDays: 7 },
      });
      expect(r2.installations[0]?.status).toBe("ok");
      expect(await db.workflowRun.count({ where: { installationId: A } })).toBe(
        60,
      );
      // The second pass resumed below the stored cursor instead of starting over.
      const windows = gh.requests
        .slice(before)
        .filter(
          (r) =>
            r.route === "GET /repos/{owner}/{repo}/actions/runs" &&
            String(r.params.created).includes(".."),
        )
        .map((r) => Date.parse(String(r.params.created).split("..")[1]!));
      expect(windows.length).toBeGreaterThan(0);
      for (const to of windows) expect(to).toBeLessThan(resumeFrom);
      expect(
        (await db.syncState.findUniqueOrThrow({ where: { repositoryId: 11n } }))
          .backfillDone,
      ).toBe(true);
    },
  );

  it(
    "syncs two installations independently",
    { timeout: 120_000 },
    async () => {
      await seedInstallations(db);
      const gh = new FakeGitHub();
      for (let i = 0; i < 5; i++) {
        gh.addRun(A, {
          createdAt: new Date(gh.now - ((i + 1) * DAY) / 2),
          durationS: 100,
        });
        gh.addRun(B, {
          createdAt: new Date(gh.now - ((i + 1) * DAY) / 2),
          durationS: 200,
        });
      }
      gh.failInstallations.add(B);

      const r1 = await reconcile.runReconcile({
        deadline: new budget.Deadline(gh.now + 3_600_000, gh.clock),
        clients: gh.clients(),
        config: { backfillDays: 7 },
      });
      const byId = new Map(r1.installations.map((i) => [i.installationId, i]));
      expect(byId.get(String(A))?.status).toBe("ok");
      expect(await db.workflowRun.count({ where: { installationId: A } })).toBe(
        5,
      );
      expect(await db.workflowRun.count({ where: { installationId: B } })).toBe(
        0,
      );
      // B's failure is recorded on B's repo only.
      expect(
        (await db.syncState.findUnique({ where: { repositoryId: 22n } }))
          ?.lastError,
      ).toBeTruthy();
      expect(
        (await db.syncState.findUnique({ where: { repositoryId: 11n } }))
          ?.lastError,
      ).toBeNull();

      gh.failInstallations.clear();
      await reconcile.runReconcile({
        deadline: new budget.Deadline(gh.now + 3_600_000, gh.clock),
        clients: gh.clients(),
        installationId: B,
        config: { backfillDays: 7 },
      });
      expect(await db.workflowRun.count({ where: { installationId: B } })).toBe(
        5,
      );
      expect(await db.workflowRun.count({ where: { installationId: A } })).toBe(
        5,
      );

      // Each installation's rows only reference its own repository, and every
      // token was minted for the installation whose data it read.
      expect(
        await db.workflowRun.count({
          where: { installationId: A, repositoryId: { not: 11n } },
        }),
      ).toBe(0);
      expect(
        await db.workflowJob.count({
          where: { installationId: B, repositoryId: { not: 22n } },
        }),
      ).toBe(0);
      for (const req of gh.requests.filter((r) =>
        r.route.startsWith("GET /repos/"),
      )) {
        const owner = req.params.owner;
        expect(owner).toBe(
          req.installationId === A ? "example-user" : "example-org",
        );
      }
      expect(new Set(gh.tokens.map((t) => t.purpose))).toEqual(
        new Set(["sync.runs"]),
      );
    },
  );

  it(
    "starts exactly one lazy reconcile for a stale installation",
    { timeout: 60_000 },
    async () => {
      await seedInstallations(db, {
        lastReconciledAt: new Date(Date.now() - 60 * 60_000),
      });
      const gh = new FakeGitHub();
      gh.addRun(A, { createdAt: new Date(gh.now - DAY / 2), durationS: 100 });

      const tasks: Array<() => Promise<unknown>> = [];
      const schedule = (task: () => Promise<unknown>) => void tasks.push(task);
      const opts = { clients: gh.clients() };

      // Five concurrent page views of the same installation.
      const started = await Promise.all(
        Array.from({ length: 5 }, () =>
          triggers.maybeLazyReconcile(A, schedule, opts),
        ),
      );
      expect(started.filter(Boolean)).toHaveLength(1);
      expect(tasks).toHaveLength(1);

      await tasks[0]!();
      const inst = await db.installation.findUniqueOrThrow({
        where: { id: A },
      });
      expect(Date.now() - inst.lastReconciledAt!.getTime()).toBeLessThan(
        60_000,
      );
      expect(inst.reconcileLockedUntil).toBeNull();
      expect(await db.workflowRun.count({ where: { installationId: A } })).toBe(
        1,
      );

      // Fresh now: further page views do not start another one.
      expect(await triggers.maybeLazyReconcile(A, schedule, opts)).toBe(false);
      expect(tasks).toHaveLength(1);

      // The other installation is independent and still stale.
      expect(await triggers.maybeLazyReconcile(B, schedule, opts)).toBe(true);
      expect(tasks).toHaveLength(2);
    },
  );

  it("does not start a lazy reconcile for a recently reconciled installation", async () => {
    await seedInstallations(db, {
      lastReconciledAt: new Date(Date.now() - 5 * 60_000),
    });
    const tasks: unknown[] = [];
    expect(
      await triggers.maybeLazyReconcile(A, (t) => void tasks.push(t), {
        clients: new FakeGitHub().clients(),
      }),
    ).toBe(false);
    expect(tasks).toHaveLength(0);
  });

  it("continues an unfinished (partial) reconcile after a minute", async () => {
    await seedInstallations(db, {
      lastReconciledAt: new Date(Date.now() - 2 * 60_000),
    });
    const tasks: unknown[] = [];
    const schedule = (t: () => Promise<unknown>) => void tasks.push(t);
    const opts = { clients: new FakeGitHub().clients() };
    expect(await triggers.maybeLazyReconcile(A, schedule, opts)).toBe(false);
    await db.installation.update({
      where: { id: A },
      data: { lastReconcileStatus: "partial" },
    });
    expect(await triggers.maybeLazyReconcile(A, schedule, opts)).toBe(true);
    expect(tasks).toHaveLength(1);
  });

  it("rate-limits Sync now to once per five minutes per installation", async () => {
    await seedInstallations(db);
    const now = new Date();
    expect(await triggers.claimSyncNow(A, now)).toBe(true);
    expect(
      await triggers.claimSyncNow(A, new Date(now.getTime() + 60_000)),
    ).toBe(false);
    expect(await triggers.claimSyncNow(B, now)).toBe(true);
    expect(
      await triggers.claimSyncNow(A, new Date(now.getTime() + 5 * 60_000 + 1)),
    ).toBe(true);
  });
});
