import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as ActionModule from "@/server/authz/action";
import type { TenantScope } from "@/server/authz/scope";
import type * as AuditData from "@/server/data/audit";
import type * as Costs from "@/server/data/costs";
import type * as Insights from "@/server/data/insights";
import type * as RepoData from "@/server/data/repos";
import type * as Runners from "@/server/data/runners";
import type * as Db from "@/server/db";
import type * as ActionsEvents from "@/server/ingest/actions-events";
import type * as Budget from "@/server/ingest/budget";
import type * as IgnorePurge from "@/server/ingest/ignore-purge";
import type * as Reconcile from "@/server/ingest/reconcile";
import type * as Rollup from "@/server/ingest/rollup";
import type * as RunnerRollup from "@/server/ingest/runner-rollup";
import type * as Verify from "@/server/ingest/verify";
import type * as Webhook from "@/server/ingest/webhook";
import type * as WebhookStore from "@/server/ingest/webhook-store";
import type * as RepoActions from "@/server/management/repos";
import {
  A,
  B,
  DATABASE_URL,
  FakeGitHub,
  makeRun,
  resetTables,
  seedInstallations,
  setActionsEnv,
  WEBHOOK_SECRET,
} from "./support/actions";

/**
 * Ignoring repositories (UI overhaul §3) against a real Postgres and an
 * in-memory GitHub: the admin action through the audited pipeline (role
 * denial, idempotency, unchanged, batch rows, chain verify, 404 for foreign
 * ids), reconcile and webhooks skipping an ignored repository, the purge of
 * its stored data with the runner pool stats recomputed without it, the
 * "ignored repositories" cost bucket, and un-ignore resetting the sync state
 * so the next reconcile imports the history again.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const DAY = 86_400_000;
const ADMIN = { id: "user-admin", email: "admin@example.com" };
const OPERATOR = { id: "user-operator", email: "operator@example.com" };
/** A second repository of example-user, folded directly (not in FakeGitHub). */
const REPO_Z = { id: 12n, owner: "example-user", name: "repo-z" };

let db: typeof Db.db;
let action: typeof ActionModule;
let repoActions: typeof RepoActions;
let repoData: typeof RepoData;
let auditData: typeof AuditData;
let insights: typeof Insights;
let runnersData: typeof Runners;
let costs: typeof Costs;
let events: typeof ActionsEvents;
let purge: typeof IgnorePurge;
let reconcile: typeof Reconcile;
let rollup: typeof Rollup;
let runnerRollup: typeof RunnerRollup;
let budget: typeof Budget;
let webhook: typeof Webhook;
let store: typeof WebhookStore;
let verify: typeof Verify;

function actor(
  who: { id: string; email: string },
  role: TenantScope["role"],
  installationIds: bigint[] = [A, B],
) {
  return {
    user: { id: who.id, name: role.toLowerCase(), email: who.email },
    scope: { userId: who.id, role, installationIds },
    ipHash: "b".repeat(64),
    userAgent: "vitest",
  };
}

const viewerScope = (ids: bigint[] = [A, B]): TenantScope => ({
  userId: ADMIN.id,
  role: "VIEWER",
  installationIds: ids,
});

describe.skipIf(!DATABASE_URL)("repository ignore", () => {
  let gh: FakeGitHub;
  const deps = () =>
    action.defaultActionDeps({
      clients: gh.clients(),
      revalidate: () => undefined,
      managementEnabled: true,
      mergeAuditTrailer: false,
      now: () => new Date(gh.now),
    });
  const ignore = (
    ids: bigint[],
    who = actor(ADMIN, "ADMIN"),
    key = randomUUID(),
  ) =>
    repoActions.ignoreRepositories(
      who,
      {
        installationId: A,
        repositoryIds: ids,
        confirmed: true,
        idempotencyKey: key,
      },
      deps(),
    );
  const unignore = (ids: bigint[]) =>
    repoActions.unignoreRepositories(
      actor(ADMIN, "ADMIN"),
      {
        installationId: A,
        repositoryIds: ids,
        confirmed: true,
        idempotencyKey: randomUUID(),
      },
      deps(),
    );
  const runReconcile = () =>
    reconcile.runReconcile({
      deadline: new budget.Deadline(gh.now + 600_000, gh.clock),
      clients: gh.clients(),
      installationId: A,
      config: { backfillDays: 3, sampleIntervalS: 600 },
    });

  /** Folds one run of repo-z through the webhook fold functions. */
  async function foldRepoZ(createdAt: Date, labels = ["ubuntu-latest"]) {
    const made = makeRun(REPO_Z, {
      createdAt,
      durationS: 300,
      labels,
      workflowId: 900,
      workflowName: "Build",
    });
    const at = new Date(gh.now);
    await events.applyGhRun(A, REPO_Z.id, made.run, "main", at, "WEBHOOK");
    await events.applyGhJobs(A, REPO_Z.id, made.jobs, at, "WEBHOOK");
  }

  async function rollAll() {
    const tz = "UTC";
    await rollup.markAllDaysDirty(A, tz);
    const d = new budget.Deadline(gh.now + 600_000, gh.clock);
    const drained = await rollup.drainRollups(A, tz, d, 90);
    await runnerRollup.rollupRunnerDays(A, drained.days, tz, d);
  }

  const poolJobs = async () =>
    (
      await db.dailyRunnerStat.aggregate({
        where: { installationId: A, runnerKey: "pool:ubuntu-latest" },
        _sum: { jobs: true },
      })
    )._sum.jobs ?? 0;

  beforeAll(async () => {
    setActionsEnv({
      ADMIN_EMAILS: ADMIN.email,
      OPERATOR_EMAILS: OPERATOR.email,
    });
    ({ db } = await import("@/server/db"));
    action = await import("@/server/authz/action");
    repoActions = await import("@/server/management/repos");
    repoData = await import("@/server/data/repos");
    auditData = await import("@/server/data/audit");
    insights = await import("@/server/data/insights");
    runnersData = await import("@/server/data/runners");
    costs = await import("@/server/data/costs");
    events = await import("@/server/ingest/actions-events");
    purge = await import("@/server/ingest/ignore-purge");
    reconcile = await import("@/server/ingest/reconcile");
    rollup = await import("@/server/ingest/rollup");
    runnerRollup = await import("@/server/ingest/runner-rollup");
    budget = await import("@/server/ingest/budget");
    webhook = await import("@/server/ingest/webhook");
    store = await import("@/server/ingest/webhook-store");
    verify = await import("@/server/ingest/verify");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
    await db.$executeRawUnsafe(
      `TRUNCATE "RateLimitBucket", "Session", "Account", "User" CASCADE`,
    );
    await seedInstallations(db, {
      permissions: { administration: "read" },
    });
    await db.repository.create({
      data: {
        id: REPO_Z.id,
        installationId: A,
        ownerLogin: REPO_Z.owner,
        name: REPO_Z.name,
        fullName: `${REPO_Z.owner}/${REPO_Z.name}`,
        private: true,
      },
    });
    // repo-a is a fork of an open-source project.
    await db.repository.update({ where: { id: 11n }, data: { fork: true } });
    for (const u of [ADMIN, OPERATOR])
      await db.user.create({
        data: { id: u.id, name: u.id, email: u.email, emailVerified: true },
      });
    gh = new FakeGitHub();
  });

  it("ignores through the audited pipeline: roles, idempotency, unchanged, batch rows", async () => {
    // Operators are denied, and the denial is recorded.
    const denied = await ignore([11n], actor(OPERATOR, "OPERATOR"));
    expect(denied).toEqual({ status: "forbidden" });
    expect(
      await db.auditLog.count({
        where: { action: "REPO_IGNORE", status: "DENIED" },
      }),
    ).toBe(1);

    // A dialog without the checkbox is refused before any audit row.
    const unconfirmed = await repoActions.ignoreRepositories(
      actor(ADMIN, "ADMIN"),
      {
        installationId: A,
        repositoryIds: [11n],
        confirmed: false,
        idempotencyKey: randomUUID(),
      },
      deps(),
    );
    expect(unconfirmed).toEqual({ status: "confirmation_mismatch" });

    const key = randomUUID();
    const first = await ignore([11n, REPO_Z.id], actor(ADMIN, "ADMIN"), key);
    expect(first.status).toBe("succeeded");
    if (first.status !== "succeeded") return;
    expect(first.data).toMatchObject({
      changed: 2,
      unchanged: 0,
      failed: 0,
      purgeQueued: true,
    });
    const repo = await db.repository.findUniqueOrThrow({ where: { id: 11n } });
    expect(repo.ignoredAt).not.toBeNull();
    expect(repo.ignoredByUserId).toBe(ADMIN.id);
    expect(repo.ignorePurgedAt).toBeNull();

    // One parent plus one row per repository, sharing the batch id.
    const rows = await db.auditLog.findMany({
      where: { batchId: first.data!.batchId },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => [r.action, r.targetType, r.status])).toEqual([
      ["REPO_IGNORE", "batch", "SUCCEEDED"],
      ["REPO_IGNORE", "repository", "SUCCEEDED"],
      ["REPO_IGNORE", "repository", "SUCCEEDED"],
    ]);
    expect(rows[1]!.params).toEqual({ before: false, after: true, fork: true });
    expect(rows[1]!.repoFullName).toBe("example-user/repo-a");

    // The same key replays the stored result; nothing new is written.
    const replay = await ignore([11n, REPO_Z.id], actor(ADMIN, "ADMIN"), key);
    expect(replay).toMatchObject({ status: "succeeded", replayed: true });
    expect(await db.auditLog.count({ where: { action: "REPO_IGNORE" } })).toBe(
      4,
    );

    // Ignoring again changes nothing and writes no row.
    expect(await ignore([11n])).toEqual({
      status: "refused",
      reason: "unchanged",
    });
    expect(await db.auditLog.count({ where: { action: "REPO_IGNORE" } })).toBe(
      4,
    );

    // The chain still verifies.
    expect(
      (await auditData.verifyAuditLog(actor(ADMIN, "ADMIN").scope, A)).ok,
    ).toBe(true);

    const ignoredList = await repoData.listIgnoredRepositories(
      viewerScope(),
      A,
    );
    expect(ignoredList.map((r) => [r.fullName, r.fork, r.purged])).toEqual([
      ["example-user/repo-a", true, false],
      ["example-user/repo-z", false, false],
    ]);
  });

  it("answers 404 for repositories of another installation or outside the scope", async () => {
    await expect(
      repoActions.ignoreRepositories(
        actor(ADMIN, "ADMIN"),
        {
          installationId: A,
          repositoryIds: [11n, 22n],
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toThrow("Not found");
    await expect(
      repoActions.ignoreRepositories(
        actor(ADMIN, "ADMIN", [B]),
        {
          installationId: A,
          repositoryIds: [11n],
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toThrow("Not found");
    await expect(
      repoData.listIgnoredRepositories(viewerScope([B]), A),
    ).rejects.toThrow("Not found");
    expect(
      await db.repository.count({ where: { ignoredAt: { not: null } } }),
    ).toBe(0);
  });

  it("purges the stored data and recomputes the pool stats without the repository", async () => {
    const now = gh.now;
    // repo-a: a hosted job and a job on its own repo-level runner.
    gh.addRun(A, { createdAt: new Date(now - DAY), durationS: 120 });
    gh.addRun(A, {
      createdAt: new Date(now - DAY + 3_600_000),
      durationS: 180,
      labels: ["self-hosted"],
      runnerName: "runner-1",
    });
    gh.runners.set("repo:example-user/repo-a", [
      {
        id: 501,
        name: "runner-1",
        status: "online",
        busy: false,
        labels: ["self-hosted"],
      },
    ]);
    expect((await runReconcile()).installations[0]!.status).toBe("ok");
    // repo-z: one hosted job on the same pool and day.
    await foldRepoZ(new Date(now - DAY + 600_000));
    await rollAll();
    expect(await poolJobs()).toBe(2);
    expect(
      await db.dailyRunnerStat.count({
        where: { runnerKey: { startsWith: "shr:11:" } },
      }),
    ).toBeGreaterThan(0);
    // GitHub's bill for both repositories.
    const month = new Date(
      Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1),
    );
    await db.billingUsageItem.createMany({
      data: [
        { repo: "example-user/repo-a", net: 1.5 },
        { repo: "example-user/repo-z", net: 2 },
      ].map((b) => ({
        installationId: A,
        date: month,
        product: "Actions",
        sku: "Actions Linux",
        repositoryFullName: b.repo,
        unitType: "Minutes",
        quantity: 100,
        pricePerUnit: 0.008,
        grossAmount: b.net,
        discountAmount: 0,
        netAmount: b.net,
        fetchedAt: new Date(now),
      })),
    });

    expect((await ignore([11n])).status).toBe("succeeded");
    // Ignore stops loading at once: no sync state, readers hide the repo.
    expect(await db.syncState.count({ where: { repositoryId: 11n } })).toBe(0);
    const repos = await insights.listRepoStats(
      viewerScope(),
      A,
      {},
      new Date(now),
    );
    expect(repos.rows.map((r) => r.fullName)).toEqual(["example-user/repo-z"]);
    expect(repos.total).toBe(1);
    const withIgnored = await insights.listRepoStats(
      viewerScope(),
      A,
      { filters: ["ignored"], sort: "name", dir: "asc" },
      new Date(now),
    );
    expect(withIgnored.rows.map((r) => [r.fullName, r.ignored])).toEqual([
      ["example-user/repo-a", true],
      ["example-user/repo-z", false],
    ]);
    const wf = await insights.listWorkflowStats(
      viewerScope(),
      A,
      {},
      new Date(now),
    );
    expect(wf.every((w) => w.repoFullName === "example-user/repo-z")).toBe(
      true,
    );
    const runnerList = await runnersData.listRunners(
      viewerScope(),
      A,
      new Date(now),
    );
    expect(runnerList.runners).toHaveLength(0);

    // Reconcile step j deletes everything but the bill, then marks it purged.
    const result = await purge.purgeIgnoredRepositories(
      A,
      "UTC",
      90,
      new budget.Deadline(gh.now + 600_000, gh.clock),
    );
    expect(result).toMatchObject({ purged: 1, remaining: 0 });
    for (const count of [
      db.workflowRun.count({ where: { repositoryId: 11n } }),
      db.workflowJob.count({ where: { repositoryId: 11n } }),
      db.dailyWorkflowStat.count({ where: { repositoryId: 11n } }),
      db.dailyJobStat.count({ where: { repositoryId: 11n } }),
      db.rollupDirty.count({ where: { repositoryId: 11n } }),
      db.runner.count({ where: { repositoryId: 11n } }),
      db.runnerSample.count({ where: { runnerKey: `${A}:REPO:501` } }),
      db.dailyRunnerStat.count({
        where: { runnerKey: { startsWith: "shr:11:" } },
      }),
    ])
      expect(await count).toBe(0);
    // The other repository is untouched; the pool counts only its job now.
    expect(await db.workflowRun.count({ where: { repositoryId: 12n } })).toBe(
      1,
    );
    expect(await poolJobs()).toBe(1);
    expect(
      await db.billingUsageItem.count({ where: { installationId: A } }),
    ).toBe(2);
    const purged = await db.repository.findUniqueOrThrow({
      where: { id: 11n },
    });
    expect(purged.ignorePurgedAt).not.toBeNull();

    // Costs: the ignored repo's bill stays in the totals as one bucket.
    const c = await costs.getCosts(viewerScope(), A, undefined, new Date(now));
    expect(c.totals.netUsd).toBe(3.5);
    expect(c.byRepo.map((r) => r.repositoryFullName)).toEqual([
      "example-user/repo-z",
    ]);
    expect(c.ignored).toEqual({
      repositories: 1,
      billedQuantity: 100,
      grossUsd: 1.5,
      netUsd: 1.5,
    });
    expect(
      c.byRepo.reduce((s, r) => s + r.netUsd, 0) + (c.ignored?.netUsd ?? 0),
    ).toBe(c.totals.netUsd);

    // Reconcile no longer reads the ignored repository from GitHub.
    gh.requests.length = 0;
    gh.now += 10 * 60_000;
    expect((await runReconcile()).installations[0]!.status).toBe("ok");
    expect(
      gh.requests.filter((r) => r.params.repo === "repo-a").map((r) => r.route),
    ).toEqual([]);
    expect(await db.workflowRun.count({ where: { repositoryId: 11n } })).toBe(
      0,
    );
  });

  it("recomputes the pool stats beyond the sample retention and keeps their online time", async () => {
    const now = gh.now;
    const REPO_A = { id: 11n, owner: "example-user", name: "repo-a" };
    const old = new Date(now - 50 * DAY);
    const oldDay = old.toISOString().slice(0, 10);
    // Day 50: one hosted job each of repo-a and repo-z on the same pool.
    for (const repo of [REPO_A, REPO_Z]) {
      const made = makeRun(repo, {
        createdAt: old,
        durationS: 300,
        labels: ["ubuntu-latest"],
        workflowId: 900 + Number(repo.id),
        workflowName: "Build",
      });
      const at = new Date(gh.now);
      await events.applyGhRun(A, repo.id, made.run, "main", at, "WEBHOOK");
      await events.applyGhJobs(A, repo.id, made.jobs, at, "WEBHOOK");
    }
    await rollAll();
    const pool = () =>
      db.dailyRunnerStat.findUnique({
        where: {
          installationId_runnerKey_day: {
            installationId: A,
            runnerKey: "pool:ubuntu-latest",
            day: new Date(`${oldDay}T00:00:00.000Z`),
          },
        },
      });
    expect((await pool())?.jobs).toBe(2);
    // An org runner that was online that day (its samples are pruned by now).
    await db.dailyRunnerStat.create({
      data: {
        installationId: A,
        runnerKey: "sh:runner-9",
        runnerKind: "SELF_HOSTED",
        day: new Date(`${oldDay}T00:00:00.000Z`),
        jobs: 0,
        failures: 0,
        busyS: 0n,
        onlineS: 7_200n,
        peakConcurrency: 0,
        durHist: [],
        queueHist: [],
      },
    });

    expect((await ignore([11n])).status).toBe("succeeded");
    const result = await purge.purgeIgnoredRepositories(
      A,
      "UTC",
      90,
      new budget.Deadline(gh.now + 600_000, gh.clock),
    );
    expect(result).toMatchObject({ purged: 1, remaining: 0 });
    // Day 50 is outside the 30 sample days but inside the 90 raw days: the
    // pool counts only repo-z's job, the online time of runner-9 stays.
    expect((await pool())?.jobs).toBe(1);
    const sh = await db.dailyRunnerStat.findUnique({
      where: {
        installationId_runnerKey_day: {
          installationId: A,
          runnerKey: "sh:runner-9",
          day: new Date(`${oldDay}T00:00:00.000Z`),
        },
      },
    });
    expect(sh?.onlineS).toBe(7_200n);
  });

  it("skips webhooks of an ignored repository but keeps inventory events", async () => {
    await ignore([11n]);
    const send = (event: string, payload: unknown, id: string) => {
      const body = JSON.stringify(payload);
      return webhook.handleWebhook(
        {
          headers: new Headers({
            "content-type": "application/json",
            "x-github-event": event,
            "x-github-delivery": id,
            "x-hub-signature-256": verify.signPayload(WEBHOOK_SECRET, body),
          }),
          body,
        },
        [WEBHOOK_SECRET],
        store.prismaWebhookStore,
      );
    };
    const made = makeRun(
      { owner: "example-user", name: "repo-a" },
      { createdAt: new Date(gh.now - 60_000), durationS: 60 },
    );
    const repository = {
      id: 11,
      name: "repo-a",
      full_name: "example-user/repo-a",
      private: true,
      owner: { login: "example-user" },
    };
    await send(
      "workflow_job",
      {
        action: "completed",
        workflow_job: made.jobs[0],
        repository,
        installation: { id: Number(A) },
      },
      "delivery-ignored-1",
    );
    const delivery = await db.webhookDelivery.findUniqueOrThrow({
      where: { id: "delivery-ignored-1" },
    });
    expect([delivery.status, delivery.error, delivery.payload]).toEqual([
      "SKIPPED",
      "repo_ignored",
      null,
    ]);
    expect(await db.workflowJob.count({ where: { repositoryId: 11n } })).toBe(
      0,
    );
    expect(await db.workflowRun.count({ where: { repositoryId: 11n } })).toBe(
      0,
    );

    // A repository event still updates the inventory (archive, fork).
    await send(
      "repository",
      {
        action: "archived",
        repository: { ...repository, archived: true, fork: false },
        installation: { id: Number(A) },
      },
      "delivery-ignored-2",
    );
    const repo = await db.repository.findUniqueOrThrow({ where: { id: 11n } });
    expect([repo.archived, repo.fork, repo.ignoredAt !== null]).toEqual([
      true,
      false,
      true,
    ]);
    // ... without giving the ignored repo a sync state again.
    expect(await db.syncState.count({ where: { repositoryId: 11n } })).toBe(0);
  });

  it("un-ignore resets the sync state and the next reconcile imports the history", async () => {
    const now = gh.now;
    gh.addRun(A, { createdAt: new Date(now - DAY), durationS: 120 });
    gh.addRun(A, { createdAt: new Date(now - 2 * DAY), durationS: 90 });
    expect((await runReconcile()).installations[0]!.status).toBe("ok");
    expect(await db.workflowRun.count({ where: { repositoryId: 11n } })).toBe(
      2,
    );

    await ignore([11n]);
    await purge.purgeIgnoredRepositories(
      A,
      "UTC",
      90,
      new budget.Deadline(gh.now + 600_000, gh.clock),
    );
    expect(await db.workflowRun.count({ where: { repositoryId: 11n } })).toBe(
      0,
    );

    // Un-ignoring something that is not ignored is "unchanged".
    expect(await unignore([REPO_Z.id])).toEqual({
      status: "refused",
      reason: "unchanged",
    });
    const res = await unignore([11n]);
    expect(res.status).toBe("succeeded");
    const repo = await db.repository.findUniqueOrThrow({ where: { id: 11n } });
    expect([repo.ignoredAt, repo.ignoredByUserId, repo.ignorePurgedAt]).toEqual(
      [null, null, null],
    );
    const state = await db.syncState.findUniqueOrThrow({
      where: { repositoryId: 11n },
    });
    expect(state).toMatchObject({
      runsCursor: null,
      backfillUntil: null,
      backfillDone: false,
      needsResync: true,
    });
    expect(
      await db.auditLog.count({
        where: { action: "REPO_UNIGNORE", targetType: "repository" },
      }),
    ).toBe(1);

    gh.now += 60_000;
    expect((await runReconcile()).installations[0]!.status).toBe("ok");
    expect(await db.workflowRun.count({ where: { repositoryId: 11n } })).toBe(
      2,
    );
    const after = await db.syncState.findUniqueOrThrow({
      where: { repositoryId: 11n },
    });
    expect(after.backfillDone).toBe(true);
    expect(after.needsResync).toBe(false);
  });

  it("an un-ignore during a purge stops it and keeps the repo active", async () => {
    gh.addRun(A, { createdAt: new Date(gh.now - DAY), durationS: 120 });
    await runReconcile();
    await ignore([11n]);
    await unignore([11n]);
    const result = await purge.purgeIgnoredRepositories(
      A,
      "UTC",
      90,
      new budget.Deadline(gh.now + 600_000, gh.clock),
    );
    expect(result).toEqual({ purged: 0, remaining: 0, rows: 0, runnerDays: 0 });
    expect(await db.workflowRun.count({ where: { repositoryId: 11n } })).toBe(
      1,
    );
  });
});
