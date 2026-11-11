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
import type * as Installations from "@/server/data/installations";
import type * as Steps from "@/server/data/steps";
import type * as Budget from "@/server/ingest/budget";
import type * as Reconcile from "@/server/ingest/reconcile";
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
 * Run detail steps are read live from GitHub (design §7) and never stored.
 * The run must belong to a visible installation: a foreign run answers
 * NotFound before any token is minted (design §9 isolation).
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const DAY = 86_400_000;

let db: typeof Db.db;
let steps: typeof Steps;
let installations: typeof Installations;
let reconcile: typeof Reconcile;
let budget: typeof Budget;

const scope = (role: TenantScope["role"], ...ids: bigint[]): TenantScope => ({
  userId: "user-1",
  role,
  installationIds: ids,
});

describe.skipIf(!DATABASE_URL)("run steps", () => {
  let gh: FakeGitHub;
  let runOfA: bigint;
  let runOfB: bigint;

  beforeAll(async () => {
    setActionsEnv();
    ({ db } = await import("@/server/db"));
    steps = await import("@/server/data/steps");
    installations = await import("@/server/data/installations");
    reconcile = await import("@/server/ingest/reconcile");
    budget = await import("@/server/ingest/budget");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    steps.resetStepsCache();
    await resetTables(db);
    await seedInstallations(db);
    gh = new FakeGitHub();
    gh.addRun(A, {
      createdAt: new Date(gh.now - DAY),
      durationS: 120,
      conclusion: "failure",
    });
    gh.addRun(B, { createdAt: new Date(gh.now - DAY), durationS: 90 });
    await reconcile.runReconcile({
      deadline: new budget.Deadline(gh.now + 3_600_000, gh.clock),
      clients: gh.clients(),
      config: { backfillDays: 7 },
    });
    runOfA = (
      await db.workflowRun.findFirstOrThrow({ where: { installationId: A } })
    ).id;
    runOfB = (
      await db.workflowRun.findFirstOrThrow({ where: { installationId: B } })
    ).id;
  });

  it("loads the steps of each job of the attempt, ordered by number", async () => {
    const res = await steps.getRunSteps(
      scope("VIEWER", A),
      A,
      runOfA,
      1,
      gh.clients(),
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    const all = Object.values(res.byJob);
    expect(all).toHaveLength(1);
    expect(all[0]!.map((s) => s.name)).toEqual(["Set up job", "Run tests"]);
    expect(all[0]![1]).toMatchObject({
      status: "COMPLETED",
      conclusion: "FAILURE",
      durationS: 120,
    });
    expect(gh.tokens.at(-1)).toEqual({
      installationId: A,
      purpose: "sync.runs",
    });
  });

  it("reports steps beyond GitHub retention as expired", async () => {
    gh.expiredRuns.add(Number(runOfA));
    const res = await steps.getRunSteps(
      scope("VIEWER", A),
      A,
      runOfA,
      1,
      gh.clients(),
    );
    expect(res).toEqual({ status: "expired" });
  });

  it("answers NotFound for a run of another installation, without a token", async () => {
    const before = gh.tokens.length;
    await expect(
      steps.getRunSteps(scope("ADMIN", A), A, runOfB, 1, gh.clients()),
    ).rejects.toBeInstanceOf(installations.NotFoundError);
    await expect(
      steps.getRunSteps(scope("ADMIN", A), B, runOfB, 1, gh.clients()),
    ).rejects.toBeInstanceOf(installations.NotFoundError);
    expect(gh.tokens.length).toBe(before);
  });

  it("serves repeated views of a run from the cache", async () => {
    const jobsRequests = () =>
      gh.requests.filter((r) => r.route.includes("/attempts/")).length;
    const before = jobsRequests();
    for (let i = 0; i < 3; i++)
      expect(
        (
          await steps.getRunSteps(
            scope("VIEWER", A),
            A,
            runOfA,
            1,
            gh.clients(),
          )
        ).status,
      ).toBe("ok");
    expect(jobsRequests() - before).toBe(1);
    const stored = await db.installationRateLimit.findUniqueOrThrow({
      where: {
        installationId_resource: { installationId: A, resource: "core" },
      },
    });
    expect(stored.remaining).toBe(gh.remaining);
  });

  it("does not call GitHub while the stored budget is below the floor", async () => {
    await db.installationRateLimit.upsert({
      where: {
        installationId_resource: { installationId: A, resource: "core" },
      },
      create: {
        installationId: A,
        resource: "core",
        limit: 5000,
        remaining: 50,
        resetAt: new Date(Date.now() + 600_000),
        updatedAt: new Date(),
      },
      update: { remaining: 50, resetAt: new Date(Date.now() + 600_000) },
    });
    const before = gh.requests.length;
    const res = await steps.getRunSteps(
      scope("VIEWER", A),
      A,
      runOfA,
      1,
      gh.clients(),
    );
    expect(res).toEqual({ status: "unavailable" });
    expect(gh.requests.length).toBe(before);
  });
});
