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
import type * as RunnerRollup from "@/server/ingest/runner-rollup";
import type * as RunnerSync from "@/server/ingest/runners";
import type * as Runners from "@/server/data/runners";
import type * as Summaries from "@/server/data/summaries";
import type * as Installations from "@/server/data/installations";
import type * as Db from "@/server/db";
import type { TenantScope } from "@/server/authz/scope";
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
 * Runners and the live queue against a real Postgres and an in-memory GitHub
 * (design §5.3 f, §6.5, §13 M2): discovery makes a repo-level runner visible
 * before its first job, samples feed utilisation ("insufficient samples"
 * below 50% coverage), removals, DailyRunnerStat, STUCK and
 * no-matching-runner on synthetic data, and installation isolation.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const MIN = 60_000;
const DAY = 86_400_000;

let db: typeof Db.db;
let reconcile: typeof Reconcile;
let budget: typeof Budget;
let runners: typeof Runners;
let installations: typeof Installations;
let runnerSync: typeof RunnerSync;
let runnerRollup: typeof RunnerRollup;
let summaries: typeof Summaries;

const scope = (installationIds: bigint[] = [A, B]): TenantScope => ({
  userId: "user-admin",
  role: "ADMIN",
  installationIds,
});

const RUNNER_1 = {
  id: 501,
  name: "runner-1",
  status: "online" as const,
  busy: false,
  labels: ["self-hosted", "Linux", "X64"],
};

async function run(gh: FakeGitHub, installationId: bigint) {
  return reconcile.runReconcile({
    deadline: new budget.Deadline(gh.now + 600_000, gh.clock),
    clients: gh.clients(),
    installationId,
    config: { backfillDays: 2, sampleIntervalS: 600 },
  });
}

describe.skipIf(!DATABASE_URL)("runners", () => {
  beforeAll(async () => {
    setActionsEnv();
    ({ db } = await import("@/server/db"));
    reconcile = await import("@/server/ingest/reconcile");
    budget = await import("@/server/ingest/budget");
    runners = await import("@/server/data/runners");
    summaries = await import("@/server/data/summaries");
    installations = await import("@/server/data/installations");
    runnerSync = await import("@/server/ingest/runners");
    runnerRollup = await import("@/server/ingest/runner-rollup");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
  });

  it("discovers a repo-level runner before its first job and samples it", async () => {
    await seedInstallations(db, { permissions: { administration: "read" } });
    const gh = new FakeGitHub();
    gh.runners.set("repo:example-user/repo-a", [RUNNER_1]);

    const first = await run(gh, A);
    expect(first.installations[0]!.runners).toMatchObject({
      discovery: "done",
      runners: 1,
      samples: 1,
      repoRunnersGranted: true,
    });
    expect(await db.workflowJob.count()).toBe(0);
    expect(gh.tokens).toContainEqual({
      installationId: A,
      purpose: "sync.runners",
    });

    const list = await runners.listRunners(scope(), A, new Date(gh.now));
    expect(list.runners).toHaveLength(1);
    expect(list.runners[0]).toMatchObject({
      key: `${A}:REPO:501`,
      scope: "REPO",
      repository: { id: "11", fullName: "example-user/repo-a" },
      name: "runner-1",
      online: true,
      busy: false,
      labels: ["linux", "self-hosted", "x64"],
      jobs7d: 0,
    });
    // One sample covers nothing yet: no utilisation number.
    expect(list.runners[0]!.utilisation7d.insufficientSamples).toBe(true);
    expect(list.runners[0]!.utilisation7d.value).toBeNull();
    expect(list.discoveredAt).not.toBeNull();

    // Next tick (10 min later): no discovery, but the known runner is sampled.
    gh.now += 10 * MIN;
    gh.runners.set("repo:example-user/repo-a", [{ ...RUNNER_1, busy: true }]);
    const second = await run(gh, A);
    expect(second.installations[0]!.runners).toMatchObject({
      discovery: "not_due",
      samples: 1,
    });
    const samples = await db.runnerSample.findMany({
      where: { runnerKey: `${A}:REPO:501` },
      orderBy: { sampledAt: "asc" },
    });
    expect(samples.map((s) => [s.busy, s.intervalS])).toEqual([
      [false, 0],
      [true, 600],
    ]);
    const runner = await db.runner.findUniqueOrThrow({
      where: { key: `${A}:REPO:501` },
    });
    expect(runner.busy).toBe(true);
  });

  it('shows utilisation with the sample interval, and "insufficient samples" below 50%', async () => {
    await seedInstallations(db, { permissions: { administration: "read" } });
    const gh = new FakeGitHub();
    gh.runners.set("repo:example-user/repo-a", [RUNNER_1]);
    await run(gh, A);
    const key = `${A}:REPO:501`;
    const now = gh.now;

    // Three days of 10-minute samples: 3/7 of the week, below 50%.
    const sample = (days: number) =>
      Array.from({ length: (days * DAY) / (10 * MIN) }, (_, i) => ({
        installationId: A,
        runnerKey: key,
        sampledAt: new Date(now - (i + 1) * 10 * MIN),
        online: true,
        busy: false,
        intervalS: 600,
      }));
    await db.runnerSample.createMany({ data: sample(3), skipDuplicates: true });
    let r = (await runners.listRunners(scope(), A, new Date(now))).runners[0]!;
    expect(r.utilisation7d.coverage).toBeLessThan(0.5);
    expect(r.utilisation7d.insufficientSamples).toBe(true);
    expect(r.utilisation7d.value).toBeNull();
    expect(r.utilisation7d.medianSampleIntervalS).toBe(600);

    // Five days: enough coverage, and a 2-hour job makes it busy.
    await db.runnerSample.createMany({ data: sample(5), skipDuplicates: true });
    await db.workflowJob.create({
      data: {
        id: 9001n,
        runId: 8001n,
        runAttempt: 1,
        installationId: A,
        repositoryId: 11n,
        workflowName: "CI",
        name: "build",
        baseName: "build",
        labels: ["linux", "self-hosted"],
        labelKey: "linux,self-hosted",
        status: "COMPLETED",
        statusRank: 4,
        conclusion: "SUCCESS",
        runnerName: "runner-1",
        runnerKind: "SELF_HOSTED",
        createdAt: new Date(now - 3 * 3_600_000),
        startedAt: new Date(now - 3 * 3_600_000),
        completedAt: new Date(now - 3_600_000),
        durationS: 7_200,
        queueS: 0,
        source: "WEBHOOK",
        lastEventAt: new Date(now - 3_600_000),
      },
    });
    r = (await runners.listRunners(scope(), A, new Date(now))).runners[0]!;
    expect(r.utilisation7d.insufficientSamples).toBe(false);
    expect(r.utilisation7d.busyS).toBe(7_200);
    expect(r.utilisation7d.value).toBeCloseTo(7_200 / (5 * 86_400), 3);
    expect(r.jobs7d).toBe(1);

    const detail = await runners.getRunnerDetail(
      scope(),
      A,
      key,
      "7d",
      new Date(now),
    );
    expect(detail.runner.key).toBe(key);
    expect(detail.utilisation.insufficientSamples).toBe(false);
    expect(detail.statusTimeline.length).toBeGreaterThan(100);
    expect(detail.topJobs[0]).toMatchObject({ baseName: "build", jobs: 1 });
  });

  it("marks a runner that left the list as removed (and ephemeral after at most one job)", async () => {
    await seedInstallations(db, { permissions: { administration: "read" } });
    const gh = new FakeGitHub();
    gh.runners.set("repo:example-user/repo-a", [RUNNER_1]);
    await run(gh, A);
    gh.now += 10 * MIN;
    gh.runners.set("repo:example-user/repo-a", []);
    const res = await run(gh, A);
    expect(res.installations[0]!.runners!.removed).toBe(1);
    const row = await db.runner.findUniqueOrThrow({
      where: { key: `${A}:REPO:501` },
    });
    expect(row.removedAt).not.toBeNull();
    expect(row.ephemeral).toBe(true);
    expect(
      (await runners.listRunners(scope(), A, new Date(gh.now))).runners,
    ).toHaveLength(0);
  });

  it("samples org runners of an organisation installation", async () => {
    await seedInstallations(db, {
      permissions: { organization_self_hosted_runners: "read" },
    });
    const gh = new FakeGitHub();
    gh.runners.set("org:example-org", [
      { ...RUNNER_1, id: 777, name: "runner-2" },
    ]);
    const res = await run(gh, B);
    expect(res.installations[0]!.runners).toMatchObject({
      orgRunnersGranted: true,
      repoRunnersGranted: false,
      runners: 1,
    });
    const list = await runners.listRunners(scope(), B, new Date(gh.now));
    expect(list.runners.map((r) => [r.key, r.scope])).toEqual([
      [`${B}:ORG:777`, "ORG"],
    ]);
    // A personal installation has no org runners: nothing listed there.
    expect(
      (await runners.listRunners(scope(), A, new Date(gh.now))).runners,
    ).toHaveLength(0);
  });

  it("without the permissions there is nothing to sample and no error", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    gh.runners.set("repo:example-user/repo-a", [RUNNER_1]);
    const res = await run(gh, A);
    expect(res.installations[0]!.status).toBe("ok");
    expect(res.installations[0]!.runners).toBeUndefined();
    const list = await runners.listRunners(scope(), A, new Date(gh.now));
    expect(list.repoRunnersGranted).toBe(false);
    expect(list.runners).toHaveLength(0);
  });

  it("rolls self-hosted jobs and samples up into DailyRunnerStat", async () => {
    await seedInstallations(db, { permissions: { administration: "read" } });
    const gh = new FakeGitHub();
    gh.runners.set("repo:example-user/repo-a", [RUNNER_1]);
    // A job on runner-1 and a hosted one, an hour ago.
    gh.addRun(A, {
      createdAt: new Date(gh.now - 2 * 3_600_000),
      durationS: 300,
      labels: ["self-hosted", "linux"],
      runnerName: "runner-1",
    });
    gh.addRun(A, {
      createdAt: new Date(gh.now - 2 * 3_600_000),
      durationS: 120,
    });
    await run(gh, A);
    const stats = await db.dailyRunnerStat.findMany({
      where: { installationId: A },
      orderBy: { runnerKey: "asc" },
    });
    // runner-1 is a repo runner of repo-a (11): keyed by repository and name.
    const sh = stats.find((s) => s.runnerKey === "shr:11:runner-1");
    const pool = stats.find((s) => s.runnerKey === "pool:ubuntu-latest");
    expect(sh).toMatchObject({
      runnerKind: "SELF_HOSTED",
      jobs: 1,
      peakConcurrency: 1,
    });
    expect(Number(sh!.busyS)).toBe(300);
    expect(Number(sh!.onlineS)).toBeGreaterThanOrEqual(300);
    expect(pool).toMatchObject({
      runnerKind: "GITHUB_HOSTED",
      jobs: 1,
      onlineS: null,
    });

    const daily = await runners.listRunnerDailyStats(
      scope(),
      A,
      {
        range: "7d",
        runnerKey: "shr:11:runner-1",
      },
      new Date(gh.now),
    );
    expect(daily.map((d) => d.jobs).reduce((a, b) => a + b, 0)).toBe(1);

    const pools = await runners.listRunnerPools(
      scope(),
      A,
      "7d",
      new Date(gh.now),
    );
    expect(pools.split.map((s) => s.runnerKind).sort()).toEqual([
      "GITHUB_HOSTED",
      "SELF_HOSTED",
    ]);
    const shPool = pools.pools.find((p) => p.runnerKind === "SELF_HOSTED")!;
    expect(shPool.runners).toBe(1);
    expect(shPool.peakConcurrency).toBe(1);
  });

  it("resumes a discovery pass cut short by the deadline instead of starting over", async () => {
    await seedInstallations(db, { permissions: { administration: "read" } });
    const extra = ["repo-c", "repo-d", "repo-e", "repo-f"];
    await db.repository.createMany({
      data: extra.map((name, i) => ({
        id: BigInt(12 + i),
        installationId: A,
        ownerLogin: "example-user",
        name,
        fullName: `example-user/${name}`,
        private: true,
      })),
    });
    const gh = new FakeGitHub();
    for (const name of extra) gh.runners.set(`repo:example-user/${name}`, []);
    // Only the last repository has a runner.
    gh.runners.set("repo:example-user/repo-f", [
      { ...RUNNER_1, id: 515, name: "runner-5" },
    ]);
    gh.msPerRequest = 1_000;
    const pass = (deadlineMs: number) => {
      const budgetNow = new budget.RateBudget(gh.clock);
      const deadline = new budget.Deadline(gh.now + deadlineMs, gh.clock);
      return runnerSync.sampleRunners({
        installationId: A,
        accountLogin: "example-user",
        accountType: "USER",
        permissions: { administration: "read" },
        api: gh.api(A),
        budget: budgetNow,
        deadline,
        targetIntervalS: 600,
      });
    };
    const listedRepos = () =>
      gh.requests
        .filter((r) => r.route === "GET /repos/{owner}/{repo}/actions/runners")
        .map((r) => String(r.params.repo));

    // 5 s reserve + 1.5 s at 1 s per request: two repositories fit.
    const first = await pass(6_500);
    expect(first.discovery).toBe("partial");
    expect(listedRepos()).toEqual(["repo-a", "repo-c"]);
    let inst = await db.installation.findUniqueOrThrow({ where: { id: A } });
    expect(inst.runnersDiscoveredAt).toBeNull();
    expect(await runnerSync.discoveryCursor(A)).toBe(12n);

    // The next tick continues after repo-c, not from the first repository.
    gh.requests.length = 0;
    const second = await pass(600_000);
    expect(second.discovery).toBe("done");
    expect(listedRepos()).toEqual(["repo-d", "repo-e", "repo-f"]);
    expect(await runnerSync.discoveryCursor(A)).toBeNull();
    inst = await db.installation.findUniqueOrThrow({ where: { id: A } });
    expect(inst.runnersDiscoveredAt).not.toBeNull();
    const list = await runners.listRunners(scope(), A, new Date(gh.now));
    expect(list.runners.map((r) => r.name)).toEqual(["runner-5"]);

    // Done for the day: the next tick only samples the known repository.
    gh.requests.length = 0;
    expect((await pass(600_000)).discovery).toBe("not_due");
    expect(listedRepos()).toEqual(["repo-f"]);
  });

  it("keeps repo runners with the same name in different repositories apart", async () => {
    await seedInstallations(db, { permissions: { administration: "read" } });
    await db.repository.create({
      data: {
        id: 12n,
        installationId: A,
        ownerLogin: "example-user",
        name: "repo-c",
        fullName: "example-user/repo-c",
        private: true,
      },
    });
    const gh = new FakeGitHub();
    // Both repositories register a runner called runner-1 (e.g. one host).
    gh.runners.set("repo:example-user/repo-a", [RUNNER_1]);
    gh.runners.set("repo:example-user/repo-c", [{ ...RUNNER_1, id: 502 }]);
    gh.addRun(A, {
      createdAt: new Date(gh.now - 2 * 3_600_000),
      durationS: 300,
      labels: ["self-hosted", "linux"],
      runnerName: "runner-1",
    });
    await run(gh, A);
    const jobs = await db.workflowJob.findMany({
      where: { installationId: A },
    });
    expect(jobs.map((j) => j.repositoryId)).toEqual([11n]);

    const list = await runners.listRunners(scope(), A, new Date(gh.now));
    const byKey = new Map(list.runners.map((r) => [r.key, r]));
    expect(byKey.get(`${A}:REPO:501`)!.jobs7d).toBe(1);
    expect(byKey.get(`${A}:REPO:501`)!.utilisation7d.busyS).toBe(300);
    expect(byKey.get(`${A}:REPO:502`)!.jobs7d).toBe(0);
    expect(byKey.get(`${A}:REPO:502`)!.utilisation7d.busyS).toBe(0);

    const other = await runners.getRunnerDetail(
      scope(),
      A,
      `${A}:REPO:502`,
      "7d",
      new Date(gh.now),
    );
    expect(other.topJobs).toEqual([]);
    expect(other.distribution.runner.n).toBe(0);

    const inst = await db.installation.findUniqueOrThrow({ where: { id: A } });
    const day = new Date(gh.now - 2 * 3_600_000).toISOString().slice(0, 10);
    await runnerRollup.rollupRunnerDay(A, day, inst.timezone);
    const stats = await db.dailyRunnerStat.findMany({
      where: { installationId: A, runnerKind: "SELF_HOSTED" },
    });
    expect(
      stats.find((s) => s.runnerKey === "shr:11:runner-1")?.jobs ?? 0,
    ).toBe(1);
    expect(
      stats.find((s) => s.runnerKey === "shr:12:runner-1")?.jobs ?? 0,
    ).toBe(0);
    expect(stats.some((s) => s.runnerKey === "sh:runner-1")).toBe(false);
  });

  it("flags STUCK and no-matching-runner jobs in the live queue", async () => {
    await seedInstallations(db);
    const now = Date.now();
    await db.runner.createMany({
      data: [
        {
          key: `${A}:REPO:501`,
          installationId: A,
          scope: "REPO",
          repositoryId: 11n,
          githubRunnerId: 501n,
          name: "runner-1",
          os: "Linux",
          labels: ["linux", "self-hosted", "x64"],
          online: true,
          busy: true,
          firstSeenAt: new Date(now - DAY),
          lastSeenAt: new Date(now),
        },
      ],
    });
    const job = (
      id: bigint,
      labels: string[],
      ageMin: number,
      status: "QUEUED" | "WAITING" = "QUEUED",
    ) => ({
      id,
      runId: id + 1000n,
      runAttempt: 1,
      installationId: A,
      repositoryId: 11n,
      workflowName: "CI",
      name: "build",
      baseName: "build",
      labels,
      labelKey: [...labels].sort().join(","),
      status,
      statusRank: status === "QUEUED" ? 1 : 2,
      createdAt: new Date(now - ageMin * MIN),
      source: "WEBHOOK" as const,
      lastEventAt: new Date(now - ageMin * MIN),
    });
    await db.workflowJob.createMany({
      data: [
        job(1n, ["linux", "self-hosted"], 20), // runner busy: STUCK
        job(2n, ["linux", "self-hosted"], 5), // too young
        job(3n, ["gpu", "self-hosted"], 30), // no runner has "gpu"
        job(4n, ["ubuntu-latest"], 40), // hosted: never STUCK
        job(5n, ["linux", "self-hosted"], 60, "WAITING"), // approval wait
      ],
    });
    const q = await runners.getLiveQueue(scope(), A, new Date(now));
    const byId = new Map(q.jobs.map((j) => [j.jobId, j]));
    expect(byId.get("1")).toMatchObject({
      stuck: true,
      noMatchingRunner: false,
    });
    expect(byId.get("2")).toMatchObject({ stuck: false });
    expect(byId.get("3")).toMatchObject({
      stuck: true,
      noMatchingRunner: true,
    });
    expect(byId.get("4")).toMatchObject({
      stuck: false,
      noMatchingRunner: false,
    });
    expect(q.stuck).toBe(2);
    // The start page card and the overview tile count the same stuck jobs.
    const stuckOnCard = async () =>
      (await summaries.getAccountSummaries(scope(), new Date(now))).find(
        (s) => s.installationId === String(A),
      )!.queuedStuck;
    expect(await stuckOnCard()).toBe(q.stuck);
    expect(q.approvals.map((j) => j.jobId)).toEqual(["5"]);
    const group = q.groups.find((g) => g.labelKey === "linux,self-hosted")!;
    expect(group).toMatchObject({
      count: 2,
      stuck: 1,
      repoFullName: "example-user/repo-a",
    });
    expect(group.oldestAgeS).toBe(20 * 60);

    // Within one refresh: once the runner is free, job 1 is no longer STUCK.
    await db.runner.update({
      where: { key: `${A}:REPO:501` },
      data: { busy: false },
    });
    const after = await runners.getLiveQueue(scope(), A, new Date(now));
    expect(after.jobs.find((j) => j.jobId === "1")!.stuck).toBe(false);
    expect(after.stuck).toBe(1);
    expect(await stuckOnCard()).toBe(1);
  });

  it("samples lazily at most once per two minutes", async () => {
    await seedInstallations(db, { permissions: { administration: "read" } });
    const gh = new FakeGitHub();
    gh.runners.set("repo:example-user/repo-a", [RUNNER_1]);
    await run(gh, A); // discovery: the runner is known
    const triggers = await import("@/server/ingest/triggers");
    const tasks: Array<() => Promise<unknown>> = [];
    const schedule = (t: () => Promise<unknown>) => void tasks.push(t);
    const at = new Date(Date.now() + 5 * MIN);
    expect(
      await triggers.maybeLazyRunnerSample(A, schedule, {
        clients: gh.clients(),
        now: at,
      }),
    ).toBe(true);
    expect(
      await triggers.maybeLazyRunnerSample(A, schedule, {
        clients: gh.clients(),
        now: new Date(at.getTime() + MIN),
      }),
    ).toBe(false);
    expect(tasks).toHaveLength(1);
    await tasks[0]!();
    expect(await db.runnerSample.count({ where: { installationId: A } })).toBe(
      2,
    );
  });

  it("keeps installations apart", async () => {
    await seedInstallations(db, {
      permissions: {
        administration: "read",
        organization_self_hosted_runners: "read",
      },
    });
    const gh = new FakeGitHub();
    gh.runners.set("repo:example-user/repo-a", [RUNNER_1]);
    gh.runners.set("repo:example-org/repo-b", [
      { ...RUNNER_1, id: 601, name: "runner-3" },
    ]);
    await run(gh, A);
    await run(gh, B);
    const onlyA = scope([A]);
    const NotFound = installations.NotFoundError;
    await expect(runners.listRunners(onlyA, B)).rejects.toBeInstanceOf(
      NotFound,
    );
    await expect(runners.getLiveQueue(onlyA, B)).rejects.toBeInstanceOf(
      NotFound,
    );
    await expect(runners.listRunnerPools(onlyA, B)).rejects.toBeInstanceOf(
      NotFound,
    );
    await expect(
      runners.getConcurrencyTimeline(onlyA, B),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      runners.getHostedVsSelfHosted(onlyA, B),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(runners.listRunnerDailyStats(onlyA, B)).rejects.toBeInstanceOf(
      NotFound,
    );
    // A runner key of B through A's installation id is unknown there.
    await expect(
      runners.getRunnerDetail(onlyA, A, `${B}:REPO:601`),
    ).rejects.toBeInstanceOf(NotFound);
    const a = await runners.listRunners(onlyA, A);
    expect(a.runners.map((r) => r.name)).toEqual(["runner-1"]);
    // Each installation's token only listed its own repositories.
    const listed = gh.requests.filter(
      (r) => r.route === "GET /repos/{owner}/{repo}/actions/runners",
    );
    for (const r of listed)
      expect(r.params.owner).toBe(
        r.installationId === A ? "example-user" : "example-org",
      );
  });
});
